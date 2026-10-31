import csv
import json
from pathlib import Path
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cv2

from core import (FaceLiveness, Smoother, draw, split_fake_faces, drop_screen_people,
                  liveness_crop, load_seatmap, occupancy, scaled_seats)
from count import Publisher
from evaluate import metrics
from fusion import FusionConfig, fuse


def test_geometry_and_smoothing():
    seats = [(1, np.array([[0, 40], [50, 40], [50, 100], [0, 100]], np.float32)),
             (2, np.array([[60, 40], [100, 40], [100, 100], [60, 100]], np.float32))]
    for rule in ("hip", "iou"):
        assert occupancy([[0, 0, 50, 100]], seats, rule) == {1: 1, 2: 0}
        assert occupancy([], seats, rule) == {1: 0, 2: 0}
    smoother = Smoother(3)
    for _ in range(3):
        smoother.update(1, {1: 1})
    assert smoother.update(0, {1: 0}) == (1, {1: 1})
    assert smoother.update(0, {1: 0}) == (0, {1: 0})


def test_draw_free_seat_estimate_without_map(monkeypatch):
    texts = []
    monkeypatch.setattr(cv2, "putText", lambda img, text, *a, **k: texts.append(text))
    draw(np.zeros((50, 50, 3), np.uint8), [], {}, 3, capacity=4)
    draw(np.zeros((50, 50, 3), np.uint8), [], {}, 6, capacity=4)
    assert texts == ["People: 3 | Seats free (estimate): 1/4", "People: 6 | Seats free (estimate): 0/4"]


def test_people_on_screens_are_dropped():
    phone = [100, 100, 200, 300]
    on_phone = [110, 120, 190, 290]
    holding_phone = [50, 0, 300, 600]
    assert drop_screen_people([on_phone, holding_phone], [phone]) == [holding_phone]
    assert drop_screen_people([on_phone], []) == [on_phone]
    assert drop_screen_people([[0, 0, 0, 10]], []) == []


def test_people_with_only_fake_faces_are_suspect_not_counted():
    real_person, phone_person, back_of_head = [0, 0, 300, 600], [100, 300, 160, 420], [400, 0, 600, 600]
    real_face, phone_face = ([100, 40, 180, 120], 0.9), ([110, 320, 150, 360], 0.1)
    people = [real_person, phone_person, back_of_head]
    # The real person also contains the phone face, but their own real face keeps them.
    assert split_fake_faces(people, [real_face, phone_face]) == ([real_person, back_of_head], [phone_person])
    assert split_fake_faces(people, [phone_face], threshold=0.05) == (people, [])


def test_liveness_crop_stays_in_frame():
    frame = np.zeros((100, 200, 3), np.uint8)
    assert liveness_crop(frame, (180, 80, 20, 20)).shape == (80, 80, 3)
    assert liveness_crop(frame, (0, 0, 150, 90)).shape == (80, 80, 3)


def test_face_liveness_models_load():
    models = Path(__file__).resolve().parents[1] / "models"
    if not (models / "MiniFASNetV2.onnx").is_file():
        pytest.skip("face liveness models not downloaded")
    assert FaceLiveness().score(np.zeros((240, 320, 3), np.uint8)) == []


def test_map_validation(tmp_path):
    path = tmp_path / "map.json"
    data = {"image_size": [100, 100], "seats": [{"seat_id": 1, "polygon": [[0, 0], [50, 0], [50, 50], [0, 50]]}]}
    path.write_text(json.dumps(data))
    seatmap = load_seatmap(path)
    assert scaled_seats(seatmap, (200, 200, 3))[0][1][2].tolist() == [100, 100]
    with pytest.raises(ValueError):
        scaled_seats(seatmap, (100, 200, 3))
    data["seats"].append(data["seats"][0])
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        load_seatmap(path)


def inputs(speed=0, total=40):
    return ({"timestamp": 100., "pax": {"net_current": 20}, "gps": {"speed": speed, "sats": 8}},
            {"timestamp": 100., "seats_free": 0, "seats_total": total})


def test_fusion_motion_coverage_staleness():
    ir, cv = inputs()
    out = fuse(ir, cv, now=101)
    assert out["source"] == "camera" and out["seats_free"] == 0 and out["recalibration_required"]
    ir, cv = inputs(speed=20)
    assert fuse(ir, cv, now=101)["seats_free"] == 20
    ir, cv = inputs(total=10)
    out = fuse(ir, cv, now=101)
    assert out["source"] == "ir" and out["deviation"] is None
    assert fuse(None, cv, now=101)["seats_free"] is None
    assert fuse(*inputs(), now=120)["source"] == "unavailable"
    assert fuse(None, inputs()[1], now=101)["source"] == "camera"
    ir, cv = inputs()
    ir["gps"]["sats"] = 0
    assert fuse(ir, cv, now=101)["source"] == "ir"
    assert fuse(ir, cv, now=99)["source"] == "unavailable"


def test_manual_metrics_are_not_fabricated():
    rows = [{"people_pred": "2", "people_manual": "", "hip_seat_1": "1", "iou_seat_1": "0",
             "manual_seat_1": "", "hip_free_pred": "0", "iou_free_pred": "1"}]
    with pytest.raises(ValueError, match="missing manual"):
        metrics(rows)
    assert metrics(rows, True)["people"]["exact_match_percent"] == "not measured"
    rows[0].update(people_manual="3", manual_seat_1="1")
    result = metrics(rows)
    assert result["people"]["mean_absolute_error"] == 1
    assert result["people"]["within_one_percent"] == 100
    assert result["seats"]["hip"]["accuracy_percent"] == 100
    assert result["seats"]["iou"]["free_total_exact_match_percent"] == 0


def test_publisher_survives_failure_and_discards_stale():
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(503 if len(received) == 1 else 200)
            self.end_headers()

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    pub = Publisher(f"http://127.0.0.1:{server.server_port}", .05, .2)
    try:
        pub.submit({"count": 2, "seats_free": 0, "seats_total": 40})
        time.sleep(.35)
        assert len(received) >= 2
        before = len(received)
        time.sleep(.15)
        assert len(received) == before
        assert pub.thread.is_alive()
        assert all(set(payload) == {"count", "seats_free", "seats_total"} for payload in received)
    finally:
        pub.close()
        server.shutdown()
        server.server_close()


def test_bridge_validation_and_bus_isolation():
    from fastapi.testclient import TestClient
    import service
    with service.lock:
        service.state.update(telemetry=None, visual={})
    with TestClient(service.app) as client:
        now = time.time()
        payload = {"bus_id": "14", "timestamp": now, "count": 40, "seats_free": 0, "seats_total": 40}
        assert client.post("/vision", json=payload).status_code == 200
        assert client.get("/fusion").json()["seats_free"] == 0
        assert client.post("/vision", json=payload).status_code == 409
        assert client.post("/vision", json={**payload, "bus_id": "15"}).status_code == 400
        assert client.post("/vision", json={**payload, "frame": "not allowed"}).status_code == 422
        assert client.post("/vision", json={**payload, "seats_free": 41}).status_code == 422
        assert client.post("/vision", json={**payload, "timestamp": now - 30}).status_code == 400


def test_camera_reconnect_and_file_loop(monkeypatch):
    import count
    opened = []

    class FakeCapture:
        def __init__(self):
            self.reads = 0
        def open(self, *_):
            opened.append(1)
        def isOpened(self):
            return True
        def get(self, *_):
            return 30
        def read(self):
            self.reads += 1
            return (True, np.zeros((20, 20, 3), np.uint8)) if self.reads <= 2 else (False, None)
        def release(self):
            pass

    monkeypatch.setattr(count.cv2, "VideoCapture", FakeCapture)
    # Existing source path exercises file looping without saving any camera frame.
    camera = count.Camera(__file__)
    try:
        time.sleep(.5)
        assert len(opened) >= 2
        assert camera.thread.is_alive()
    finally:
        camera.close()


def test_calibration_mouse_workflow_saves_only_geometry(monkeypatch, tmp_path):
    import calibrate
    output = tmp_path / "seats.json"
    monkeypatch.setattr(sys, "argv", ["calibrate.py", "--source", "empty.jpg", "--no-auto", "--output", str(output)])
    monkeypatch.setattr(calibrate.cv2, "imread", lambda *_: np.zeros((100, 100, 3), np.uint8))
    monkeypatch.setattr(calibrate.cv2, "namedWindow", lambda *_: None)
    monkeypatch.setattr(calibrate.cv2, "imshow", lambda *_: None)
    monkeypatch.setattr(calibrate.cv2, "destroyAllWindows", lambda: None)
    monkeypatch.setattr(calibrate.cv2, "getWindowProperty", lambda *_: 1)
    callback = []
    monkeypatch.setattr(calibrate.cv2, "setMouseCallback", lambda _, cb: callback.append(cb))
    actions = iter(["add", "adjust", "quit"])

    def key(_):
        action = next(actions)
        cb = callback[0]
        if action == "add":
            for x, y in [(10, 10), (70, 10), (70, 70), (10, 70)]:
                cb(calibrate.cv2.EVENT_LBUTTONDOWN, x, y, 0, None)
            return 13
        if action == "adjust":
            cb(calibrate.cv2.EVENT_RBUTTONDOWN, 30, 30, 0, None)
            cb(calibrate.cv2.EVENT_LBUTTONDOWN, 10, 10, 0, None)
            cb(calibrate.cv2.EVENT_MOUSEMOVE, 15, 15, 0, None)
            cb(calibrate.cv2.EVENT_LBUTTONUP, 15, 15, 0, None)
            return ord("s")
        return ord("q")

    monkeypatch.setattr(calibrate.cv2, "waitKey", key)
    calibrate.main()
    data = load_seatmap(output)
    assert data["seats"][0]["polygon"][0] == [15, 15]
    assert list(tmp_path.iterdir()) == [output]
