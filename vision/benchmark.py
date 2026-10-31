"""Measure camera rate, per-stage processing time and frame age. Frames stay in RAM."""
import argparse
import json
import time

import numpy as np

from core import Detector, FaceLiveness, SeatTracker, draw, grid_seats, seat_states, summarize
from count import Camera


def stats(values):
    if not values:
        return "not measured"
    ms = np.asarray(values) * 1000
    return {"mean_ms": round(float(ms.mean()), 1), "p95_ms": round(float(np.percentile(ms, 95)), 1), "n": len(ms)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", default="0")
    p.add_argument("--frames", type=int, default=150)
    p.add_argument("--warmup", type=int, default=10)
    p.add_argument("--device", default="auto")
    p.add_argument("--imgsz", type=int, default=960)
    p.add_argument("--conf", type=float, default=.35)
    p.add_argument("--camera-size", default="1280x720")
    p.add_argument("--face-liveness", action="store_true")
    p.add_argument("--liveness-interval", type=float, default=0.3)
    p.add_argument("--grid-seats", default="18x5", help="Synthetic seat grid timed for seat logic, e.g. 18x5 = 90")
    args = p.parse_args()
    detector = Detector(None, args.conf, args.imgsz, args.device,
                        liveness=FaceLiveness() if args.face_liveness else None,
                        liveness_interval=args.liveness_interval, liveness_async=True)
    detector.warmup()
    camera = Camera(args.source, size=tuple(int(v) for v in args.camera_size.split('x')) if args.camera_size else None)
    rows, cols = (int(v) for v in args.grid_seats.lower().split("x"))
    tracker, seats = SeatTracker(), None
    stages = {"detect": [], "seat_logic": [], "draw": [], "frame_age_at_result": []}
    sequences, last, processed, started = [], -1, 0, None
    try:
        deadline = time.monotonic() + 15
        while camera.snapshot() is None:
            if time.monotonic() > deadline:
                raise SystemExit("Camera produced no frame within 15 s")
            time.sleep(.01)
        while processed < args.warmup + args.frames:
            item = camera.snapshot()
            if not item or item[0] == last:
                time.sleep(.001)
                continue
            sequence, captured, frame = item
            last = sequence
            if seats is None:
                h, w = frame.shape[:2]
                corners = [[0, h - 1], [w - 1, h - 1], [int(w * .75), 0], [int(w * .25), 0]]
                seats = [(i + 1, np.float32(poly)) for i, (_, _, poly) in enumerate(grid_seats(corners, rows, cols))]
            t0 = time.monotonic()
            boxes = detector.boxes(frame)
            t1 = time.monotonic()
            states = tracker.update(seat_states(boxes, seats, uncertain=detector.uncertain), captured)
            summarize(states, len(seats))
            ts = time.monotonic()
            draw(frame, seats, states, len(boxes))
            t2 = time.monotonic()
            processed += 1
            if processed <= args.warmup:
                continue
            if started is None:
                started, first_sequence = t0, sequence
            stages["detect"].append(t1 - t0)
            stages["seat_logic"].append(ts - t1)
            stages["draw"].append(t2 - ts)
            stages["frame_age_at_result"].append(t1 - captured)
            sequences.append(sequence)
        elapsed = time.monotonic() - started
    finally:
        camera.close()
        detector.close()
    report = {
        "source": args.source, "frame": f"{frame.shape[1]}x{frame.shape[0]}", "device": detector.device, "imgsz": args.imgsz,
        "face_liveness": args.face_liveness, "liveness_interval": args.liveness_interval,
        "synthetic_seats": len(seats),
        "camera_fps": round((sequences[-1] - first_sequence) / elapsed, 1),
        "processed_fps": round(len(sequences) / elapsed, 1),
        "frames_skipped_as_stale": int(sequences[-1] - first_sequence + 1 - len(sequences)),
        **{k: stats(v) for k, v in stages.items()},
        "scope": "detect = YOLO + screen filter (+ liveness); seat_logic = association, states, tracker on a synthetic grid; frame_age = capture to detection result; excludes display window and network",
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
