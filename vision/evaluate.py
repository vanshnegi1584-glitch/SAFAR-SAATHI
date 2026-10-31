"""Export reproducible predictions, then score independent manual labels."""
import argparse
import csv
import json
from pathlib import Path
import time

import cv2
import numpy as np

from core import EMPTY, OCCUPIED, Detector, SeatTracker, Smoother, load_seatmap, scaled_seats, seat_states


def sample(args):
    if (args.n < 1 or args.window < 1 or args.window % 2 == 0 or args.capacity < 1
            or not 0 < args.conf <= 1 or not 0 < args.iou <= 1 or args.imgsz < 32):
        raise ValueError("Invalid n, window (positive odd), capacity, confidence, IoU or image size")
    seatmap = load_seatmap(args.seatmap) if args.seatmap else None
    if seatmap and len(seatmap["seats"]) > args.capacity:
        raise ValueError("Mapped seats exceed capacity")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    detector = Detector(args.weights, args.conf, args.imgsz, "cpu")
    cap = cv2.VideoCapture(args.video)
    try:
        total, fps = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)), cap.get(cv2.CAP_PROP_FPS)
        if not cap.isOpened() or total < 1 or fps <= 0:
            raise ValueError("Cannot sample video: missing frames/FPS")
        indices = np.unique(np.linspace(0, total - 1, min(total, args.n), dtype=int))
        rows, durations = [], []
        warmed = False
        for index in indices:
            smoother = Smoother(args.window)
            trackers = {rule: SeatTracker() for rule in ("hip", "iou")}
            # Run preceding 1 Hz samples so smoothing matches live inference.
            context = sorted(set(max(0, int(index - offset * fps)) for offset in range(args.window)))
            for frame_index in context:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
                ok, frame = cap.read()
                if not ok:
                    raise ValueError(f"Cannot decode frame {frame_index}")
                seats = scaled_seats(seatmap, frame.shape) if seatmap else []
                if not warmed:
                    detector.boxes(frame)
                    warmed = True
                start = time.perf_counter()
                boxes = detector.boxes(frame)
                people, _ = smoother.update(min(args.capacity * 2, len(boxes)), {})
                predictions = {rule: trackers[rule].update(seat_states(boxes, seats, rule, args.iou, detector.uncertain),
                                                           frame_index / fps)
                               for rule in ("hip", "iou")}
                durations.append(time.perf_counter() - start)
            row = {"frame": int(index), "seconds": round(index / fps, 3),
                   "people_pred": people, "people_manual": ""}
            for rule, states in predictions.items():
                if seats:
                    row[f"{rule}_free_pred"] = sum(s == EMPTY for s in states.values())
                    row[f"{rule}_unknown_pred"] = sum(s not in (EMPTY, OCCUPIED) for s in states.values())
                for sid, state in states.items():
                    # 1 occupied, 0 empty, u unknown (seat could not be verified)
                    row[f"{rule}_seat_{sid}"] = {OCCUPIED: 1, EMPTY: 0}.get(state, "u")
            for sid, _ in seats:
                row[f"manual_seat_{sid}"] = ""
            rows.append(row)
            if args.save_frames:
                # The only permitted frame-writing path; explicitly opt-in, evaluation only.
                if not cv2.imwrite(str(output / f"frame_{index:07d}.jpg"), frame):
                    raise OSError("Could not save labelling frame")
        with (output / "labels.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        metadata = {"sampled_frames": len(rows), "inference_frames_including_context": len(durations),
                    "cpu_pipeline_fps": len(durations) / sum(durations),
                    "timing_scope": "warm CPU inference + geometry + both smoothing rules; excludes decode, display, network",
                    "conf": args.conf, "imgsz": args.imgsz, "window": args.window,
                    "iou": args.iou, "capacity": args.capacity, "weights": args.weights or "yolov8n.pt",
                    "split": args.split, "manual_accuracy": "not measured", "frames_saved": args.save_frames}
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        print(json.dumps(metadata, indent=2))
    finally:
        cap.release()


def metrics(rows, allow_partial=False):
    if not rows:
        raise ValueError("CSV has no data")
    seat_columns = [key for key in rows[0] if key.startswith("manual_seat_")]
    rules = ("hip", "iou")
    people_errors, missing = [], 0
    seat = {rule: {"hits": [], "unknown": 0, "false_empty": 0, "pred_empty": 0} for rule in rules}
    total_hits, undecided = {rule: [] for rule in rules}, {rule: 0 for rule in rules}

    def integer(value, name, binary=False):
        try:
            result = int(value)
        except (ValueError, TypeError):
            raise ValueError(f"{name} must be an integer") from None
        if result < 0 or (binary and result not in (0, 1)):
            raise ValueError(f"Invalid label in {name}")
        return result

    for row in rows:
        if row["people_manual"].strip():
            people_errors.append(abs(integer(row["people_manual"], "people_manual") - integer(row["people_pred"], "people_pred")))
        else:
            missing += 1
        full = bool(seat_columns) and all(row[c].strip() for c in seat_columns)
        labels = {}
        for column in seat_columns:
            if not row[column].strip():
                missing += 1
                continue
            sid = column.removeprefix("manual_seat_")
            labels[sid] = integer(row[column], column, True)
            for rule in rules:
                raw = str(row[f"{rule}_seat_{sid}"]).strip()
                if raw == "u":
                    seat[rule]["unknown"] += 1
                    continue
                prediction = integer(raw, f"{rule}_seat_{sid}", True)
                seat[rule]["hits"].append(prediction == labels[sid])
                seat[rule]["pred_empty"] += prediction == 0
                seat[rule]["false_empty"] += prediction == 0 and labels[sid] == 1
        if full:
            manual_free = len(labels) - sum(labels.values())
            for rule in rules:
                if integer(row.get(f"{rule}_unknown_pred") or 0, f"{rule}_unknown_pred"):
                    undecided[rule] += 1
                else:
                    total_hits[rule].append(integer(row[f"{rule}_free_pred"], f"{rule}_free_pred") == manual_free)
    if missing and not allow_partial:
        raise ValueError(f"{missing} missing manual labels. Complete them or use --allow-partial for a provisional report.")
    percent = lambda values: 100 * sum(values) / len(values) if values else "not measured"
    ratio = lambda part, whole: 100 * part / whole if whole else "not measured"
    return {"provisional": bool(missing), "missing_labels": missing, "frames": len(rows),
            "people": {"labelled_frames": len(people_errors), "exact_match_percent": percent([e == 0 for e in people_errors]),
                       "within_one_percent": percent([e <= 1 for e in people_errors]),
                       "mean_absolute_error": sum(people_errors) / len(people_errors) if people_errors else "not measured"},
            "seats": {rule: {"labelled_seats": len(seat[rule]["hits"]) + seat[rule]["unknown"],
                              "decided_seats": len(seat[rule]["hits"]),
                              "accuracy_percent": percent(seat[rule]["hits"]),
                              "unknown_percent": ratio(seat[rule]["unknown"], len(seat[rule]["hits"]) + seat[rule]["unknown"]),
                              # The costly error: a seat reported free while someone sits on it.
                              "false_empty_seats": seat[rule]["false_empty"],
                              "false_empty_percent_of_predicted_empty": ratio(seat[rule]["false_empty"], seat[rule]["pred_empty"]),
                              "fully_labelled_frames": len(total_hits[rule]) + undecided[rule],
                              "frames_with_unknown_seats": undecided[rule],
                              "free_total_exact_match_percent": percent(total_hits[rule])}
                      for rule in rules}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    p = subs.add_parser("sample")
    p.add_argument("--video", required=True)
    p.add_argument("--seatmap")
    p.add_argument("--output", default="evaluation/test")
    p.add_argument("--n", type=int, default=20)
    p.add_argument("--capacity", type=int, default=40)
    p.add_argument("--conf", type=float, default=.35)
    p.add_argument("--imgsz", type=int, default=960)
    p.add_argument("--window", type=int, default=5)
    p.add_argument("--iou", type=float, default=.15)
    p.add_argument("--weights")
    p.add_argument("--split", choices=["validation", "test"], default="test")
    p.add_argument("--save-frames", action="store_true")
    p = subs.add_parser("report")
    p.add_argument("--csv", required=True)
    p.add_argument("--allow-partial", action="store_true")
    p = subs.add_parser("cleanup")
    p.add_argument("--folder", required=True)
    args = parser.parse_args()
    try:
        if args.command == "sample":
            sample(args)
        elif args.command == "report":
            with Path(args.csv).open(newline="", encoding="utf-8") as f:
                print(json.dumps(metrics(list(csv.DictReader(f)), args.allow_partial), indent=2))
        else:
            folder = Path(args.folder).resolve()
            if not (folder / "metadata.json").is_file() or not (folder / "labels.csv").is_file():
                raise ValueError("Cleanup requires an evaluation folder containing metadata.json and labels.csv")
            count = 0
            for path in folder.glob("frame_*.jpg"):
                if path.is_file() and not path.is_symlink() and path.stem.removeprefix("frame_").isdigit():
                    path.unlink()
                    count += 1
            print(f"Deleted {count} labelling frames; retained numeric CSV and metadata")
    except (ValueError, OSError, KeyError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
