"""Reproducible synthetic-video integration check, NOT a model accuracy benchmark."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import cv2
import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    folder = ROOT / "evaluation" / f"smoke_{int(time.time())}"
    folder.mkdir(parents=True)
    video = folder / "synthetic.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10, (640, 480))
    if not writer.isOpened():
        raise RuntimeError("Synthetic video writer unavailable")
    try:
        for i in range(30):
            frame = np.full((480, 640, 3), 50, np.uint8)
            cv2.rectangle(frame, (10, 10), (100 + i, 100), (150, 150, 150), -1)
            writer.write(frame)
    finally:
        writer.release()
    seatmap = folder / "map.json"
    seatmap.write_text(json.dumps({"image_size": [640, 480], "seats": [
        {"seat_id": 1, "polygon": [[200, 200], [300, 200], [300, 400], [200, 400]]},
        {"seat_id": 2, "polygon": [[350, 200], [450, 200], [450, 400], [350, 400]]}]}))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    # A fixed 40-seat bus, independent of fleet.json.
    service = subprocess.Popen([sys.executable, "-m", "uvicorn", "service:app", "--port", str(port)], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               env={**os.environ, "VISION_CAPACITY": "40"})
    try:
        for _ in range(50):
            try:
                if requests.get(url + "/health", timeout=1).ok:
                    break
            except requests.RequestException:
                pass
            time.sleep(.1)
        else:
            raise RuntimeError("Bridge did not start")
        subprocess.run([sys.executable, "count.py", "--source", str(video), "--seatmap", str(seatmap),
                        "--fusion-url", url, "--duration", "14", "--interval", "1", "--capacity", "40"], cwd=ROOT, check=True, timeout=45)
        partial = requests.get(url + "/fusion", timeout=2).json()
        assert partial["visual_seats_total"] == 2 and partial["visual_empty_seats"] == 2, partial
        assert partial["seats_free"] is None, partial
        # Simulated numeric full-bus observation, not a claim about real camera accuracy.
        response = requests.post(url + "/vision", json={"bus_id": "14", "timestamp": time.time(),
                                 "count": 40, "seats_free": 0, "seats_total": 40}, timeout=2)
        response.raise_for_status()
        full = requests.get(url + "/fusion", timeout=2).json()
        assert full["source"] == "camera" and full["seats_free"] == 0, full
        subprocess.run([sys.executable, "evaluate.py", "sample", "--video", str(video), "--seatmap", str(seatmap),
                        "--n", "3", "--output", str(folder / "labels"), "--save-frames"], cwd=ROOT, check=True, timeout=60)
        subprocess.run([sys.executable, "evaluate.py", "cleanup", "--folder", str(folder / "labels")], cwd=ROOT, check=True)
        assert not list((folder / "labels").glob("frame_*.jpg"))
        print("SMOKE PASS: looping video -> real YOLO -> numeric HTTP -> partial/full fusion; evaluation export/cleanup")
        print("Synthetic CPU timing only:", (folder / "labels" / "metadata.json").read_text())
    finally:
        service.terminate()
        service.wait(timeout=10)
        video.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
