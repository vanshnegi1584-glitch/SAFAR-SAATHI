"""Scenario tests A-L for seat states. All inputs are SYNTHETIC geometry or fake cameras,
not real bus footage: they check the logic, not detector accuracy."""
from pathlib import Path
import sys
import time

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import (EMPTY, OCCUPIED, UNKNOWN, SeatAppearance, SeatTracker, grid_seats, seat_states,
                  split_fake_faces, summarize, validate_seatmap)
from fusion import FusionConfig, fuse, merge_cameras


def bus(rows, cols, corners=((100, 400), (500, 400), (420, 60), (180, 60))):
    """Seat polygons for one perspective seat block, numbered row-major from 1."""
    return [(i + 1, np.asarray(poly, np.float32)) for i, (_, _, poly) in enumerate(grid_seats(corners, rows, cols))]


def seated(poly, height_ratio=1.6):
    """A person box whose hip anchor falls on the seat centre (upper body visible above it)."""
    cx, cy = poly.mean(axis=0)
    w = (poly[:, 0].max() - poly[:, 0].min()) * 0.8
    h = (poly[:, 1].max() - poly[:, 1].min()) * height_ratio
    return [cx - w / 2, cy - 0.65 * h, cx + w / 2, cy + 0.35 * h]


def settle(raw, seconds=3, fps=10, tracker=None):
    tracker = tracker or SeatTracker()
    for i in range(int(seconds * fps) + 1):
        states = tracker.update(raw, i / fps)
    return states


def test_a_empty_bus_reports_visible_seats_empty():
    seats = bus(4, 4)
    assert set(seat_states([], seats).values()) == {EMPTY}
    states = settle(seat_states([], seats))
    assert summarize(states, 16) == {"occupied": 0, "empty": 16, "unknown": 0, "mapped": 16,
                                     "verified": 16, "unverified": 0, "complete": True}


def test_a_seats_start_unknown_until_evidence_accumulates():
    tracker = SeatTracker(vacate=2)
    assert set(tracker.update(seat_states([], bus(2, 2)), 0).values()) == {UNKNOWN}


def test_b_d_seated_person_counts_without_any_face():
    seats = bus(4, 4)
    person = seated(seats[5][1])
    assert seat_states([person], seats)[6] == OCCUPIED
    # Facing away / face outside the frame: no face at all, so liveness keeps the person.
    assert split_fake_faces([person], faces=[]) == ([person], [])


def test_d_face_judged_fake_makes_seat_unknown_not_empty():
    seats = bus(4, 4)
    person = seated(seats[5][1])
    face = ([person[0] + 5, person[1] + 5, person[0] + 25, person[1] + 25], 0.1)  # e.g. a mask scored as spoof
    kept, suspects = split_fake_faces([person], [face])
    assert kept == [] and seat_states(kept, seats, uncertain=suspects)[6] == UNKNOWN


def test_c_several_passengers_each_get_their_own_seat():
    seats = bus(4, 4, corners=((0, 800), (1600, 800), (1600, 0), (0, 0)))  # straight-on view, no overlap
    targets = [1, 6, 11, 16]
    states = seat_states([seated(seats[t - 1][1], 1.0) for t in targets], seats)
    assert sorted(s for s, v in states.items() if v == OCCUPIED) == targets
    assert sum(v == EMPTY for v in states.values()) == 12


def test_c_one_person_never_occupies_two_seats():
    seats = [(1, np.float32([[0, 0], [100, 0], [100, 100], [0, 100]])),
             (2, np.float32([[100, 0], [200, 0], [200, 100], [100, 100]]))]
    wide = [20, -50, 180, 100]  # anchor lands in seat 2's edge region too
    states = seat_states([wide], seats, occlusion=0.5)
    assert list(states.values()).count(OCCUPIED) == 1
    assert UNKNOWN in states.values()  # the half-covered neighbour is not claimed empty


def test_e_partial_body_occupies_but_weak_evidence_is_unknown():
    seats = bus(4, 4)
    head_and_shoulders = seated(seats[9][1], height_ratio=0.9)
    assert seat_states([head_and_shoulders], seats)[10] == OCCUPIED
    assert seat_states([], seats, uncertain=[head_and_shoulders])[10] == UNKNOWN


def test_f_blocked_seat_is_unknown_not_empty():
    seats = [(1, np.float32([[0, 150], [100, 150], [100, 230], [0, 230]])),
             (2, np.float32([[150, 150], [250, 150], [250, 230], [150, 230]]))]
    standing = [-20, -200, 120, 240]  # stands in front of seat 1: box covers it, hips above it
    assert seat_states([standing], seats) == {1: UNKNOWN, 2: EMPTY}


def test_f_object_on_seat_detected_by_empty_reference():
    frame = np.full((200, 300, 3), (40, 120, 200), np.uint8)  # orange seat fabric
    seats = [(1, np.float32([[20, 20], [120, 20], [120, 150], [20, 150]]))]
    appearance = SeatAppearance(seats, frame.shape)
    reference = appearance.histogram(cv2.cvtColor(frame, cv2.COLOR_BGR2HSV), 1)
    assert appearance.similarity(cv2.cvtColor(frame, cv2.COLOR_BGR2HSV), 1, reference) > 0.99
    bag = frame.copy()
    cv2.rectangle(bag, (30, 30), (110, 140), (200, 60, 20), -1)  # blue bag, no person
    similarity = appearance.similarity(cv2.cvtColor(bag, cv2.COLOR_BGR2HSV), 1, reference)
    assert similarity < 0.5
    assert seat_states([], seats, looks_empty=lambda sid: similarity >= 0.5) == {1: UNKNOWN}


def test_g_enter_and_leave_update_promptly_without_flicker():
    seats = bus(1, 1)
    person = seated(seats[0][1])
    tracker = SeatTracker(occupy=1.0, vacate=2.0, agree=0.7)
    settle(seat_states([], seats), tracker=tracker)
    t, fps = 3.1, 10  # continues right after settle(); a longer gap would be a camera outage
    history = []
    for i in range(25):  # enters at t; frames 5 and 15 are single missed detections
        raw = seat_states([] if i in (5, 15) else [person], seats)
        history.append(tracker.update(raw, t + i / fps)[1])
    first = history.index(OCCUPIED)
    # Switches after roughly agree x occupy seconds and stays despite the later miss.
    assert 7 <= first <= 10 and history[first:] == [OCCUPIED] * (25 - first)
    t += 2.5
    history = [tracker.update(seat_states([], seats), t + i / fps)[1] for i in range(25)]
    first = history.index(EMPTY)
    assert 12 <= first <= 20 and history[:first] == [OCCUPIED] * first  # left: empty after ~1.4-2 s


def test_g_irregular_one_fps_timing_still_settles():
    # Regression: live 1 FPS intervals jitter (1.0-1.5 s); evidence must still span the dwell.
    tracker = SeatTracker(occupy=1.0, vacate=2.0)
    times = [0.0, 1.5, 2.6, 3.7, 5.2]
    states = [tracker.update({1: EMPTY}, t)[1] for t in times]
    assert states[:2] == [UNKNOWN] * 2 and states[2:] == [EMPTY] * 3
    occupied = [tracker.update({1: OCCUPIED}, t)[1] for t in (6.3, 7.4, 8.4)]
    assert occupied == [EMPTY, OCCUPIED, OCCUPIED]  # 1.1 s after the person first appeared


@pytest.mark.parametrize("capacity, rows, cols", [(80, 20, 4), (90, 18, 5)])
def test_h_i_large_buses_have_no_seat_limit(capacity, rows, cols):
    seats = grid_seats([[50, 1050], [1850, 1050], [1250, 60], [650, 60]], rows, cols)
    data = {"image_size": [1920, 1080], "capacity": capacity,
            "seats": [{"seat_id": i + 1, "polygon": poly, "label": f"R{r}C{c}"} for i, (r, c, poly) in enumerate(seats)]}
    validate_seatmap(data)
    assert len(seats) == capacity
    states = settle(seat_states([], [(s["seat_id"], np.float32(s["polygon"])) for s in data["seats"]]))
    assert summarize(states, capacity)["complete"]


def test_i_duplicated_or_excess_seats_are_rejected():
    seats = grid_seats([[0, 400], [400, 400], [400, 0], [0, 0]], 4, 4)
    data = {"image_size": [500, 500], "capacity": 90,
            "seats": [{"seat_id": i + 1, "polygon": p} for i, (_, _, p) in enumerate(seats)]}
    copy = {**data, "seats": data["seats"] + [{"seat_id": 17, "polygon": seats[0][2]}]}
    with pytest.raises(ValueError, match="duplicate"):
        validate_seatmap(copy)
    with pytest.raises(ValueError, match="capacity"):
        validate_seatmap({**data, "capacity": 10})


def test_grid_follows_perspective():
    cells = grid_seats([[100, 400], [500, 400], [420, 60], [180, 60]], 5, 2)
    areas = [cv2.contourArea(np.float32(p)) for _, _, p in cells]
    assert len(cells) == 10 and areas[0] > areas[-1] * 1.5  # near row larger than far row
    assert all(cv2.isContourConvex(np.float32(p)) for _, _, p in cells)


def test_j_partial_coverage_reports_unverified_seats():
    states = {i: EMPTY for i in range(1, 31)} | {i: OCCUPIED for i in range(31, 34)} | {34: UNKNOWN, 35: UNKNOWN}
    summary = summarize(states, 60)
    assert (summary["verified"], summary["unknown"], summary["unverified"], summary["complete"]) == (33, 2, 27, False)
    visual = {"timestamp": 100., "count": 3, "seats_free": 30, "seats_total": 33, "seats_unknown": 2, "seats_mapped": 35}
    out = fuse({"timestamp": 100., "pax": {"net_current": 20}, "gps": {"speed": 0, "sats": 8}}, visual,
               FusionConfig(capacity=60), now=101)
    assert out["source"] == "ir" and out["seats_free"] == 40 and out["reason"] == "partial_camera_coverage"
    assert out["visual_empty_seats"] == 30 and out["visual_unknown_seats"] == 2


def test_j_two_cameras_never_count_a_shared_seat_twice():
    front = {"timestamp": 100., "count": 5, "seat_states": {"1": "empty", "2": "unknown", "3": "occupied"}}
    rear = {"timestamp": 100.5, "count": 4, "seat_states": {"2": "empty", "3": "empty", "4": "occupied"}}
    merged = merge_cameras([front, rear], now=101)
    # seat 2 unknown+empty -> empty; seat 3 occupied+empty -> occupied; 4 seats, not 6
    assert merged["seats_mapped"] == 4 and merged["seats_free"] == 2 and merged["seats_total"] == 4
    assert merged["count"] == 5 and merged["cameras"] == 2
    assert merge_cameras([front, {**rear, "timestamp": 50.}], now=101) is front  # stale camera ignored


def test_bridge_merges_cameras(monkeypatch):
    from fastapi.testclient import TestClient
    import service
    with service.lock:
        service.state.update(telemetry=None, visual={})
    now = time.time()
    front = {"bus_id": "14", "timestamp": now, "count": 2, "seats_free": 1, "seats_total": 2, "camera_id": "front",
             "seats_unknown": 1, "seats_mapped": 3, "seat_states": {"1": "empty", "2": "occupied", "3": "unknown"}}
    rear = {**front, "camera_id": "rear", "seats_free": 1, "seats_total": 1, "seats_unknown": 1, "seats_mapped": 2,
            "seat_states": {"3": "empty", "4": "unknown"}}
    with TestClient(service.app) as client:
        assert client.post("/vision", json=front).status_code == 200
        assert client.post("/vision", json=rear).status_code == 200
        bad = {**front, "camera_id": "x", "seat_states": {"1": "empty", "2": "empty", "3": "unknown"}}
        assert client.post("/vision", json=bad).status_code == 422  # states disagree with counts
        out = client.get("/fusion").json()
    assert out["cameras"] == 2 and out["visual_seats_mapped"] == 4
    assert out["visual_empty_seats"] == 2 and out["visual_unknown_seats"] == 1


def test_k_camera_disconnect_and_reconnect(monkeypatch):
    import count
    attempts = []

    class FlakyCapture:
        def __init__(self):
            self.reads = 0
        def open(self, *_):
            attempts.append(1)
        def isOpened(self):
            return len(attempts) != 1  # first open fails (camera unplugged)
        def get(self, *_):
            return 30
        def read(self):
            self.reads += 1
            time.sleep(.005)
            return (True, np.zeros((20, 20, 3), np.uint8)) if self.reads <= 3 else (False, None)
        def release(self):
            pass

    monkeypatch.setattr(count.cv2, "VideoCapture", FlakyCapture)
    camera = count.Camera(0, retry=0.05)
    try:
        deadline = time.monotonic() + 3
        while camera.connects < 2 and time.monotonic() < deadline:
            time.sleep(.01)
        assert camera.connects >= 2 and camera.thread.is_alive()  # reconnected twice, same process
        item = camera.wait_newer(-1, 1)
        assert item is not None and item[2].shape == (20, 20, 3)
    finally:
        camera.close()
    assert not camera.thread.is_alive()


def test_k_outage_turns_seats_unknown_not_empty():
    seats = bus(2, 2)
    tracker = SeatTracker(outage=5)
    states = settle(seat_states([], seats), tracker=tracker)
    assert set(states.values()) == {EMPTY}
    assert set(tracker.expire(3 + 6).values()) == {UNKNOWN}  # last update at t=3, 6 s silence


def test_calibration_grid_creates_numbered_seats_for_a_second_camera(monkeypatch, tmp_path):
    import calibrate
    from core import load_seatmap
    output = tmp_path / "rear.json"
    monkeypatch.setattr(sys, "argv", ["calibrate.py", "--source", "empty.jpg", "--no-auto", "--output", str(output),
                                      "--capacity", "90", "--camera-id", "rear", "--first-id", "41"])
    monkeypatch.setattr(calibrate.cv2, "imread", lambda *_: np.zeros((480, 640, 3), np.uint8))
    for name in ("namedWindow", "imshow"):
        monkeypatch.setattr(calibrate.cv2, name, lambda *_: None)
    monkeypatch.setattr(calibrate.cv2, "destroyAllWindows", lambda: None)
    monkeypatch.setattr(calibrate.cv2, "getWindowProperty", lambda *_: 1)
    callback = []
    monkeypatch.setattr(calibrate.cv2, "setMouseCallback", lambda _, cb: callback.append(cb))
    monkeypatch.setattr("builtins.input", lambda *_: "12x3")
    keys = iter(["corners", ord("g"), ord("s"), ord("q")])

    def key(_):
        k = next(keys)
        if k == "corners":
            for x, y in [(60, 460), (580, 460), (420, 40), (220, 40)]:
                callback[0](calibrate.cv2.EVENT_LBUTTONDOWN, x, y, 0, None)
            return 255
        return k

    monkeypatch.setattr(calibrate.cv2, "waitKey", key)
    calibrate.main()
    data = load_seatmap(output)
    assert (data["capacity"], data["camera_id"], len(data["seats"])) == (90, "rear", 36)
    assert [s["seat_id"] for s in data["seats"]] == list(range(41, 77))
    assert data["seats"][0]["label"] == "B1R1C1" and data["seats"][-1]["label"] == "B1R12C3"


def test_count_does_not_flicker_on_a_borderline_photo():
    from core import CountStabilizer
    stabilizer = CountStabilizer(window=2.0, hold=1.0)
    shown = []
    for i in range(150):  # 5 s at 30 FPS: real person always, photo detected every other frame
        shown.append(stabilizer.update(1 + i % 2, i / 30))
    assert sum(a != b for a, b in zip(shown, shown[1:])) <= 1
    rare = CountStabilizer()
    rare_shown = [rare.update(1 + (i % 10 < 3), i / 30) for i in range(150)]  # photo in 30% of frames
    assert set(rare_shown[45:]) == {1}  # after start-up, the borderline photo never counts


def test_count_follows_a_real_change_promptly():
    from core import CountStabilizer
    stabilizer = CountStabilizer(window=2.0, hold=1.0)
    for i in range(60):
        stabilizer.update(1, i / 30)
    shown = [stabilizer.update(2, 2 + i / 30) for i in range(90)]  # second person sits down at t=2
    first = shown.index(2)
    assert 30 <= first <= 60 and shown[first:] == [2] * (90 - first)  # within 1-2 s, then stable
    slow = CountStabilizer()
    # 1 FPS: the new count is shown on the third observation after the change (2 s).
    assert [slow.update(c, t) for c, t in [(1, 0), (1, 1), (2, 2), (2, 3), (2, 4)]] == [1, 1, 1, 1, 2]



def landmarks(nose_y=0.6, nose_x=0.0, roll=0.0, scale=40.0, origin=(200.0, 150.0)):
    """YuNet-order landmarks: right eye, left eye, nose, right mouth, left mouth (eye line y=0, mouth y=1)."""
    pts = np.array([[0.5, 0], [-0.5, 0], [nose_x, nose_y], [0.4, 1.0], [-0.4, 1.0]]) * scale
    c, s = np.cos(roll), np.sin(roll)
    return (pts @ np.array([[c, s], [-s, c]]) + origin).flatten()


def test_head_pose_from_landmarks():
    from core import face_pose, frontal
    yaw, pitch = face_pose(landmarks())
    assert abs(yaw) < 1e-6 and abs(pitch - 0.6) < 1e-6 and frontal(yaw, pitch)
    assert np.allclose(face_pose(landmarks(roll=0.5)), (yaw, pitch))  # head tilted sideways: same pose
    assert not frontal(*face_pose(landmarks(nose_y=0.88)))  # head tipped down (measured up to 0.90)
    assert not frontal(*face_pose(landmarks(nose_x=0.5)))  # turned to the side
    assert frontal(float("nan"), float("nan"))  # broken geometry is still judged, not waved through


def test_face_votes_ignore_one_bad_check_but_reject_a_photo():
    from core import FaceVotes
    votes = FaceVotes(seconds=1.5, min_votes=2)
    real_face, photo = [100, 100, 200, 220], [400, 300, 430, 335]
    results = [votes.update([(real_face, r), (photo, 0.05)], t / 2)
               for t, r in enumerate([0.99, 0.10, 0.98, 0.97])]  # one fake score at t=0.5 s
    assert all(real >= 0.5 for (box, real), _ in results)  # real passenger never judged fake
    assert results[0][1][1] == 1.0 and all(r[1][1] < 0.5 for r in results[1:])  # photo: fake from 2nd check


def test_photo_stays_excluded_when_its_face_is_briefly_missed():
    from core import remember_spoofs
    photo, person = [400, 300, 460, 400], [0, 0, 300, 600]
    kept, suspects, memory = remember_spoofs([person], [photo], [], [], now=0.0)
    assert kept == [person] and suspects == [photo]
    moved = [405, 302, 466, 404]  # next frames: face not found, photo moved a little
    kept, suspects, memory = remember_spoofs([person, moved], [], [], memory, now=1.0)
    assert kept == [person] and suspects == [moved]
    kept, suspects, memory = remember_spoofs([person, moved], [], [], memory, now=3.5)
    assert moved in kept and memory == []  # forgotten 3 s after the last fake verdict
    _, _, memory = remember_spoofs([], [photo], [], [], now=10.0)
    real_face = ([410, 310, 440, 345], 0.95)  # a real person now stands where the photo was
    kept, suspects, memory = remember_spoofs([photo], [], [real_face], memory, now=10.5)
    assert kept == [photo] and suspects == [] and memory == []


def test_head_region_faces_map_back_to_full_frame():
    from core import FaceLiveness
    models = Path(__file__).resolve().parents[1] / "models"
    if not (models / "MiniFASNetV2.onnx").is_file():
        pytest.skip("face liveness models not downloaded")
    live = FaceLiveness()

    class FakeYuNet:  # one face at (10, 20) size 30x40 in whatever image it is given
        def setInputSize(self, size):
            self.size = size
        def detect(self, image):
            row = np.array([[10, 20, 30, 40, 15, 30, 30, 30, 22, 40, 16, 50, 28, 50, .9]], np.float32)
            return 1, row
    live.faces = FakeYuNet()
    frame = np.zeros((720, 1280, 3), np.uint8)
    full = live.find_faces(frame)[0]
    assert full[:4].tolist() == [10, 20, 30, 40]
    region = live.find_faces(frame, people=[[600, 300, 700, 600]])[0]  # head region is upscaled
    # Head region of a 100x300 person at (600, 300): x 585-715, y 285-450 (165 px tall), upscaled to 192.
    scale = live.head_size / 165
    assert np.allclose(region[:4], [585 + 10 / scale, 285 + 20 / scale, 30 / scale, 40 / scale], atol=1e-3)
    assert np.allclose(region[4:14:2], 585 + full[4:14:2] / scale, atol=1e-3)  # landmarks x
    assert np.allclose(region[5:14:2], 285 + full[5:14:2] / scale, atol=1e-3)  # landmarks y


def test_responsive_preset_and_explicit_values():
    import count
    args = count.parser().parse_args([])
    count.apply_speed_preset(args)
    assert (args.count_seconds, args.count_hold, args.occupy_seconds, args.vacate_seconds) == (2.0, 1.0, 1.0, 2.0)
    args = count.parser().parse_args(["--responsive", "--count-hold", "0.8"])
    count.apply_speed_preset(args)
    assert (args.count_seconds, args.count_hold, args.occupy_seconds, args.vacate_seconds) == (1.0, 0.8, 0.7, 1.5)


def test_fusion_reports_people_on_board_from_ir_then_camera():
    cfg = FusionConfig(capacity=42)
    ir = {"timestamp": 100., "pax": {"net_current": 30}, "gps": {"speed": 20, "sats": 8}}
    cam = {"timestamp": 100., "count": 12}
    out = fuse(ir, cam, cfg, now=101)
    assert (out["people_on_board"], out["people_source"], out["camera_people"]) == (30, "ir", 12)
    out = fuse(None, cam, cfg, now=101)  # no IR: the camera's visible count, a lower bound
    assert (out["people_on_board"], out["people_source"]) == (12, "camera")
    out = fuse(None, {**cam, "timestamp": 50.}, cfg, now=101)  # stale camera
    assert (out["people_on_board"], out["people_source"], out["camera_people"]) == (None, "unavailable", None)


def test_raised_arm_box_inside_body_is_not_a_second_person():
    from core import drop_part_boxes
    body, arm = [100, 50, 300, 600], [120, 50, 200, 250]          # arm box almost wholly inside the body box
    neighbour = [280, 80, 480, 600]                                # second person standing close, overlapping a little
    behind = [150, 0, 330, 260]                                    # person behind, half outside the front box
    assert drop_part_boxes([body, arm]) == [body]
    assert drop_part_boxes([body, neighbour]) == [body, neighbour]
    assert drop_part_boxes([body, behind]) == [body, behind]       # not 85% inside: kept as a real person


def test_box_around_two_touching_people_does_not_make_three():
    from core import drop_group_boxes, drop_part_boxes
    left, right = [100, 50, 300, 600], [280, 60, 480, 610]         # two people, shoulders touching
    group = [95, 40, 485, 615]                                     # YOLO's extra box around both
    assert drop_part_boxes(drop_group_boxes([group, left, right])) == [left, right]
    body, arm, torso = [100, 50, 300, 600], [120, 50, 200, 250], [110, 60, 290, 350]
    assert drop_group_boxes([body, arm, torso]) == [body, arm, torso]  # parts are short: not a group
    front, behind = [100, 50, 400, 600], [130, 40, 380, 560]       # one directly behind the other
    assert drop_group_boxes([front, behind]) == [front, behind]    # only one box inside: not a group


def test_hand_near_camera_beside_its_owner_is_not_a_second_person():
    from core import drop_headless_boxes, needs_head_check
    H = 720
    me, hand = [400, 200, 900, 720], [880, 80, 1280, 710]          # as in the live screenshot: boxes touch
    nose, eyes = [650, 420, .9], [[610, 380, .9], [700, 380, .9]]
    my_pose = [nose, *eyes, [580, 400, .8], [730, 400, .3], [520, 640, .9], [800, 640, .9]]
    assert needs_head_check([me, hand], H)
    assert drop_headless_boxes([me, hand], [my_pose], H) == [me]
    # Two real people side by side keep both boxes: each has its own head.
    friend, friend_pose = [880, 150, 1280, 720], [[1080, 330, .9]] + [[0, 0, 0]] * 4 + [[980, 520, .9], [1180, 520, .9]]
    assert drop_headless_boxes([me, friend], [my_pose, friend_pose], H) == [me, friend]
    # Back turned: no face points, the shoulders still give a head.
    back = [[0, 0, .1]] * 5 + [[980, 520, .9], [1180, 520, .9]]
    assert drop_headless_boxes([me, friend], [my_pose, back], H) == [me, friend]
    # A small (far) box is never dropped, and an isolated box with no pose is kept.
    far = [880, 500, 960, 700]
    assert drop_headless_boxes([me, far], [my_pose], H) == [me, far]
    assert drop_headless_boxes([hand], [], H) == [hand] and not needs_head_check([hand], H)


def test_smaller_boxes_stay_centred_and_stop_neighbours_overlapping():
    from core import _box_iou, shrink_box
    a, b = [100, 0, 300, 400], [270, 0, 470, 400]                  # neighbours' boxes overlap by 30 px
    sa, sb = shrink_box(a), shrink_box(b)
    assert _box_iou(a, b) > 0 and _box_iou(sa, sb) == 0
    assert (sa[0] + sa[2]) / 2 == 200 and (sa[1] + sa[3]) / 2 == 200
    assert sa == pytest.approx([116, 12, 284, 388]) and shrink_box(a, 0, 0) == a


def test_two_people_colliding_keep_their_ids_and_add_no_one():
    from core import PersonTracker
    t = PersonTracker(confirm=3, forget=1.0)
    a, b = [100, 100, 300, 500], [500, 100, 700, 500]
    for i in range(3):
        t.update([a, b], i * 0.1)
    t.update([[260, 100, 460, 500]], 0.3)                          # collide: one merged box, one person hidden
    t.update([[260, 100, 460, 500]], 0.4)
    seen = t.update([[150, 100, 350, 500], [420, 100, 620, 500]], 0.5)  # step apart, both moved ~100 px
    assert sorted(pid for pid, _, ok in seen if ok) == [1, 2]      # same two IDs, nobody new
    assert t.count(0.5) == 2 and t.next_id == 3
    far = t.update([[150, 100, 350, 500], [420, 100, 620, 500], [900, 120, 1000, 450]], 0.6)
    assert [pid for pid, _, ok in far if not ok] == [3]            # a real newcomer still gets a new ID


def test_tracking_ids_stay_with_each_person_and_new_people_get_new_ids():
    from core import PersonTracker
    t = PersonTracker(confirm=3, forget=1.0)
    a, b = [100, 100, 200, 400], [300, 100, 400, 400]
    for i in range(3):                                             # two people, moving slightly
        seen = t.update([[a[0] + i * 5, a[1], a[2] + i * 5, a[3]], [b[0] - i * 5, b[1], b[2] - i * 5, b[3]]], i * 0.1)
    assert sorted(pid for pid, _, ok in seen if ok) == [1, 2] and t.count(0.2) == 2
    seen = t.update([[a[0] + 15, a[1], a[2] + 15, a[3]]], 0.3)       # person 2 briefly hidden
    assert [pid for pid, _, _ in seen] == [1]
    seen = t.update([[a[0] + 20, a[1], a[2] + 20, a[3]], b], 0.4)    # person 2 back within 1 s: same ID
    assert sorted(pid for pid, _, _ in seen) == [1, 2]
    c = [600, 100, 700, 400]
    seen = t.update([[a[0] + 25, a[1], a[2] + 25, a[3]], b, c], 0.5)  # a new person: new ID, not counted yet
    assert {pid: ok for pid, _, ok in seen} == {1: True, 2: True, 3: False} and t.count(0.5) == 2
    for k in range(2):
        t.update([[a[0] + 25, a[1], a[2] + 25, a[3]], b, c], 0.6 + k * 0.1)
    assert t.count(0.7) == 3
    t.update([b], 3.0)                                              # everyone else gone for > 1 s
    seen = t.update([b, a], 3.1)                                    # person 1 returns: new ID (no face memory)
    assert sorted(pid for pid, _, _ in seen) == [2, 4]


def test_brief_false_box_never_counts_but_a_flickering_real_person_does():
    from core import PersonTracker
    t = PersonTracker(confirm=3)
    person, blip = [100, 100, 200, 400], [500, 100, 560, 300]
    # A false box that shows up for 2 frames, then is gone for good: never counted.
    counts = [t.update([person] + ([blip] if i in (5, 6) else []), i * 0.033) and t.count(i * 0.033) for i in range(40)]
    assert max(counts) == 1
    # A real person the detector only catches every other frame is still counted, with one stable ID.
    t2 = PersonTracker(confirm=3)
    ids = set()
    for i in range(20):
        seen = t2.update([person] + ([blip] if i % 2 else []), i * 0.033)
        ids |= {pid for pid, _, _ in seen}
    assert ids == {1, 2} and t2.count(19 * 0.033) == 2


def test_raising_a_hand_keeps_the_same_id():
    from core import PersonTracker
    t = PersonTracker(confirm=3)
    standing = [100, 200, 200, 500]
    for i in range(3):
        t.update([standing, [400, 200, 500, 500]], i * 0.033)
    arm_up = [95, 40, 205, 500]                       # box grows ~50% taller when an arm goes up (IoU ~0.55 -> 0.45)
    hands_up = [80, 0, 220, 500]                      # both arms: much taller and wider (IoU < 0.3)
    for box in (arm_up, hands_up, standing):
        seen = t.update([box, [400, 200, 500, 500]], 1.0)
        assert sorted(pid for pid, _, _ in seen) == [1, 2]
    assert t.count(1.0) == 2
