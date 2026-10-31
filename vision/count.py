"""Live 1 FPS seat occupancy. Frames stay in RAM; network carries numbers only."""
import argparse
import logging
from pathlib import Path
import threading
import time
from urllib.parse import quote

import cv2
import requests

from core import Detector, Smoother, draw, load_seatmap, occupancy, scaled_seats

log = logging.getLogger("vision")


class Camera:
    """Drain live sources continuously; reconnect without blocking the inference loop."""
    def __init__(self, source):
        self.source = int(source) if str(source).isdigit() else source
        self.file = isinstance(self.source, str) and Path(self.source).is_file()
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.latest = None
        self.sequence = 0
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        while not self.stop.is_set():
            cap = cv2.VideoCapture()
            try:
                if isinstance(self.source, str) and not self.file:
                    cap.open(self.source, cv2.CAP_FFMPEG,
                             [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 3000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 3000])
                else:
                    cap.open(self.source)
                if not cap.isOpened():
                    log.warning("Camera unavailable; reconnecting in 2 seconds")
                    self.stop.wait(2)
                    continue
                fps = cap.get(cv2.CAP_PROP_FPS)
                delay = 1 / fps if self.file and 0 < fps <= 240 else 1 / 30 if self.file else 0
                while not self.stop.is_set():
                    started = time.monotonic()
                    ok, frame = cap.read()
                    if not ok:
                        # Reopening loops files and recovers disconnected cameras.
                        break
                    with self.lock:
                        self.sequence += 1
                        self.latest = (self.sequence, time.monotonic(), frame)
                    self.stop.wait(max(0, delay - (time.monotonic() - started)))
            except (cv2.error, OSError):
                log.warning("Camera read failed; retrying")
            finally:
                cap.release()
                with self.lock:
                    self.latest = None
            self.stop.wait(0.1 if self.file else 2)

    def snapshot(self):
        with self.lock:
            return self.latest

    def close(self):
        self.stop.set()
        self.thread.join(timeout=4)


class Publisher:
    """Retry a bounded latest value, never an old backlog of occupancy readings."""
    def __init__(self, url, interval=5, max_age=10):
        self.url, self.interval, self.max_age = url, interval, max_age
        self.lock = threading.Lock()
        self.latest = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def submit(self, payload):
        with self.lock:
            self.latest = (time.monotonic(), payload.copy())

    def _run(self):
        session = requests.Session()
        try:
            while not self.stop.is_set():
                with self.lock:
                    item = self.latest
                if item and time.monotonic() - item[0] <= self.max_age:
                    try:
                        response = session.post(self.url, json=item[1], timeout=(2, 3))
                        response.raise_for_status()
                        log.info("Counts delivered (HTTP %s)", response.status_code)
                    except requests.RequestException as exc:
                        # Do not log source URLs, response bodies, or credentials.
                        log.warning("Count delivery failed (%s); retrying", type(exc).__name__)
                self.stop.wait(self.interval)
        finally:
            session.close()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=6)


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bus", default="14")
    p.add_argument("--source", default="0")
    p.add_argument("--capacity", type=int, default=40)
    p.add_argument("--seatmap")
    p.add_argument("--rule", choices=["hip", "iou"], default="hip")
    p.add_argument("--iou", type=float, default=0.15)
    p.add_argument("--window", type=int, default=5)
    p.add_argument("--conf", type=float, default=0.35)
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--device", default="cpu", help="cpu or 0 for NVIDIA")
    p.add_argument("--weights")
    p.add_argument("--interval", type=float, default=5)
    p.add_argument("--sample-fps", type=float, default=1)
    p.add_argument("--backend", help="Optional original team backend, e.g. http://localhost:8000")
    p.add_argument("--fusion-url", help="Local bridge base URL, e.g. http://127.0.0.1:8010")
    p.add_argument("--show", action="store_true")
    p.add_argument("--duration", type=float, help="Optional seconds to run for smoke tests")
    return p


def main():
    p = parser()
    args = p.parse_args()
    if (args.capacity < 1 or args.interval <= 0 or args.sample_fps <= 0 or
            not 0 < args.conf <= 1 or not 0 < args.iou <= 1 or args.imgsz < 32):
        p.error("Invalid capacity, interval, FPS, confidence, IoU or image size")
    try:
        smoother = Smoother(args.window)
        seatmap = load_seatmap(args.seatmap) if args.seatmap else None
        if seatmap and len(seatmap["seats"]) > args.capacity:
            raise ValueError("Mapped seats exceed capacity")
    except (ValueError, OSError, KeyError) as exc:
        p.error(str(exc))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    camera = Camera(args.source)
    publishers = []
    backend = Publisher(args.backend.rstrip("/") + "/buses/" + quote(args.bus, safe="") + "/count", args.interval) if args.backend else None
    bridge = Publisher(args.fusion_url.rstrip("/") + "/vision", min(args.interval, 5)) if args.fusion_url else None
    publishers = [v for v in [backend, bridge] if v]
    detector = None
    started = time.monotonic()
    last_sequence = -1
    last_good = 0
    show = args.show
    try:
        while args.duration is None or time.monotonic() - started < args.duration:
            tick = time.monotonic()
            try:
                if detector is None:
                    detector = Detector(args.weights, args.conf, args.imgsz, args.device)
                item = camera.snapshot()
                if item and item[0] != last_sequence and tick - item[1] < 3:
                    sequence, captured, frame = item
                    if tick - last_good > 3:
                        smoother = Smoother(args.window)
                    seats = scaled_seats(seatmap, frame.shape) if seatmap else []
                    boxes = detector.boxes(frame)
                    if time.monotonic() - captured > 10:
                        log.warning("Inference too slow: stale observation discarded")
                        continue
                    people, occupied = smoother.update(min(args.capacity * 2, max(0, len(boxes))),
                                                        occupancy(boxes, seats, args.rule, args.iou))
                    payload = {"count": people}
                    if seats:
                        payload.update(seats_free=len(seats) - sum(occupied.values()), seats_total=len(seats))
                    if backend:
                        backend.submit(payload)
                    if bridge:
                        bridge.submit({"bus_id": args.bus, "timestamp": time.time() - (time.monotonic() - captured), **payload})
                    log.info("Observation: %s", payload)
                    last_sequence, last_good = sequence, tick
                    if show:
                        try:
                            cv2.imshow("SafarSaathi debug - Q to exit", draw(frame, seats, occupied, people))
                        except cv2.error:
                            show = False
                            log.warning("Debug display unavailable; continuing headless")
            except (Exception,) as exc:
                log.warning("Observation failed (%s: %s); retrying", type(exc).__name__, str(exc)[:180])
                if detector is None:
                    time.sleep(2)
            if show:
                try:
                    if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                        break
                except cv2.error:
                    show = False
            time.sleep(max(0.01, 1 / args.sample_fps - (time.monotonic() - tick)))
    except KeyboardInterrupt:
        pass
    finally:
        camera.close()
        for publisher in publishers:
            publisher.close()
        if show:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
