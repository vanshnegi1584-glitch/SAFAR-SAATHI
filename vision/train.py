"""Fine-tune YOLO on labelled bus-interior photos: extract -> label -> split -> check -> train -> evaluate.

Training needs real, labelled images from inside the buses; nothing here invents data.
Images can show passengers: collect them with permission, keep them in the git-ignored
vision/datasets/ folder, and blur faces on extraction (the default).
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import shutil

import cv2
import numpy as np

from core import ROOT, _box_iou

IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".bmp"}
SPLITS = ("train", "val", "test")
DEFAULT_NAMES = ("person", "seat")
TRIP_SEPARATOR = "__"  # extract names frames <trip>__f<frame>.jpg so splits can keep trips together


# ---------- extract ----------

def blur_faces(frame, detector):
    """Pixelate every face YuNet finds; bodies stay visible for person/seat labels."""
    h, w = frame.shape[:2]
    detector.setInputSize((w, h))
    found = detector.detect(frame)[1]
    for x, y, bw, bh in ([] if found is None else found[:, :4]):
        x1, y1 = max(0, int(x - .2 * bw)), max(0, int(y - .2 * bh))
        x2, y2 = min(w, int(x + 1.2 * bw)), min(h, int(y + 1.2 * bh))
        if x2 > x1 and y2 > y1:
            roi = frame[y1:y2, x1:x2]
            small = cv2.resize(roi, (max(1, (x2 - x1) // 12), max(1, (y2 - y1) // 12)), interpolation=cv2.INTER_AREA)
            frame[y1:y2, x1:x2] = cv2.resize(small, (x2 - x1, y2 - y1), interpolation=cv2.INTER_NEAREST)
    return 0 if found is None else len(found)


def extract(args):
    video, output = Path(args.video), Path(args.output)
    if not video.is_file():
        raise ValueError(f"Video not found: {video}")
    if args.every <= 0:
        raise ValueError("--every must be positive seconds")
    trip = (args.trip or video.stem).replace(TRIP_SEPARATOR, "_")
    output.mkdir(parents=True, exist_ok=True)
    if any(output.glob(f"{trip}{TRIP_SEPARATOR}*")):
        raise ValueError(f"{output} already has frames from trip '{trip}'; use another --trip name or folder")
    face = None
    if not args.no_blur_faces:
        model = ROOT / "models" / "face_detection_yunet_2023mar.onnx"
        if not model.is_file():
            raise ValueError("Face blurring needs models/face_detection_yunet_2023mar.onnx (see README); "
                             "pass --no-blur-faces only if the footage is consented for unblurred use")
        face = cv2.FaceDetectorYN.create(str(model), "", (320, 320), 0.6)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not cap.isOpened() or not 0 < fps <= 240:
        raise ValueError(f"Cannot read {video} or its frame rate")
    step, index, saved, faces = max(1, round(args.every * fps)), 0, 0, 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if index % step == 0:
                if face is not None:
                    faces += blur_faces(frame, face)
                path = output / f"{trip}{TRIP_SEPARATOR}f{index:07d}.jpg"
                if not cv2.imwrite(str(path), frame):
                    raise OSError(f"Could not write {path}")
                saved += 1
            index += 1
    finally:
        cap.release()
    print(f"Saved {saved} frames from {video.name} (every {args.every}s) to {output}"
          + (f"; blurred {faces} faces" if face is not None else "; faces NOT blurred"))
    print("Next: label them (YOLO format, classes in this order: " + ", ".join(DEFAULT_NAMES) + ").")


# ---------- split ----------

def trip_of(path):
    stem = Path(path).stem
    return stem.split(TRIP_SEPARATOR)[0] if TRIP_SEPARATOR in stem else None


def assign_splits(groups, val=0.15, test=0.15, seed=0):
    """Assign whole groups (trips) to train/val/test, never splitting a trip. groups: {name: n_images}."""
    names = sorted(groups)
    random.Random(seed).shuffle(names)
    total = sum(groups.values())
    result, counts = {}, {s: 0 for s in SPLITS}
    for name in names:
        if counts["test"] < test * total:
            split = "test"
        elif counts["val"] < val * total:
            split = "val"
        else:
            split = "train"
        result[name] = split
        counts[split] += groups[name]
    empty = [s for s in SPLITS if counts[s] == 0]
    if empty:
        raise ValueError(f"Not enough trips for every split (empty: {', '.join(empty)}); "
                         f"record more separate trips or videos ({len(groups)} found)")
    return result, counts


def split(args):
    images_dir = Path(args.images)
    labels_dir = Path(args.labels) if args.labels else images_dir
    output = Path(args.output)
    if output.exists():
        raise ValueError(f"{output} already exists; choose a new --output so no dataset is overwritten")
    names = [n.strip() for n in args.names.split(",") if n.strip()]
    images = sorted(p for p in images_dir.iterdir() if p.suffix.lower() in IMAGE_TYPES)
    if not images:
        raise ValueError(f"No images in {images_dir}")
    groups = {}
    for image in images:
        trip = trip_of(image)
        if trip is None:
            if not args.allow_frame_split:
                raise ValueError(f"{image.name} has no '<trip>{TRIP_SEPARATOR}' prefix. Frames from one trip are "
                                 "near-duplicates, so a random frame split leaks test data into training. Use "
                                 "extract, rename files, or pass --allow-frame-split knowingly")
            trip = image.stem
        groups[trip] = groups.get(trip, 0) + 1
    unlabelled = [i.name for i in images if not (labels_dir / f"{i.stem}.txt").is_file()]
    if unlabelled and not args.allow_unlabelled:
        raise ValueError(f"{len(unlabelled)} images have no label file (e.g. {unlabelled[0]}). Label them, or pass "
                         "--allow-unlabelled to keep them as images with nothing in them")
    assignment, counts = assign_splits(groups, args.val, args.test, args.seed)
    for s in SPLITS:
        (output / "images" / s).mkdir(parents=True)
        (output / "labels" / s).mkdir(parents=True)
    for image in images:
        s = assignment[trip_of(image) or image.stem]
        shutil.copy2(image, output / "images" / s / image.name)
        label = labels_dir / f"{image.stem}.txt"
        target = output / "labels" / s / f"{image.stem}.txt"
        shutil.copy2(label, target) if label.is_file() else target.write_text("")
    write_data_yaml(output, names)
    trips = {s: sorted(t for t, a in assignment.items() if a == s) for s in SPLITS}
    print(json.dumps({"images": counts, "trips": {s: len(t) for s, t in trips.items()},
                      "data": str(output / "data.yaml")}, indent=2))


def write_data_yaml(folder, names):
    lines = [f"path: {Path(folder).resolve().as_posix()}", "train: images/train", "val: images/val",
             "test: images/test", "names:"] + [f"  {i}: {n}" for i, n in enumerate(names)]
    (Path(folder) / "data.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------- check ----------

def read_data(data_path):
    import yaml
    data = yaml.safe_load(Path(data_path).read_text(encoding="utf-8"))
    names = data["names"]
    names = [names[i] for i in sorted(names)] if isinstance(names, dict) else list(names)
    base = Path(data.get("path") or Path(data_path).parent)
    return base, names, {s: base / data[s] for s in SPLITS if s in data}


def labels_for(image_dir):
    """YOLO convention: .../images/<split> -> .../labels/<split> (the last 'images' folder only)."""
    parts = list(Path(image_dir).parts)
    if "images" not in parts:
        raise ValueError(f"{image_dir} is not inside an 'images' folder")
    parts[len(parts) - 1 - parts[::-1].index("images")] = "labels"
    return Path(*parts)


def parse_label(path, n_classes):
    """[(class, cx, cy, w, h)] from a YOLO txt file; raises ValueError with the line on bad input."""
    rows = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) != 5:
            raise ValueError(f"{path.name}:{number}: expected 'class cx cy w h', got {line!r}")
        try:
            cls, values = int(parts[0]), [float(v) for v in parts[1:]]
        except ValueError:
            raise ValueError(f"{path.name}:{number}: not numbers: {line!r}") from None
        if not 0 <= cls < n_classes:
            raise ValueError(f"{path.name}:{number}: class {cls} outside 0-{n_classes - 1}")
        cx, cy, w, h = values
        if not (0 <= cx <= 1 and 0 <= cy <= 1 and 0 < w <= 1 and 0 < h <= 1):
            raise ValueError(f"{path.name}:{number}: coordinates must be normalised to 0-1 with positive size")
        rows.append((cls, cx, cy, w, h))
    return rows


def check_dataset(data_path):
    """Validate a YOLO dataset; returns a report dict and raises ValueError listing every problem."""
    base, names, dirs = read_data(data_path)
    errors, report, hashes = [], {"classes": names, "splits": {}}, {}
    for s in SPLITS:
        if s not in dirs:
            errors.append(f"data.yaml has no '{s}' split")
            continue
        image_dir = dirs[s]
        label_dir = labels_for(image_dir)
        images = sorted(p for p in image_dir.glob("*") if p.suffix.lower() in IMAGE_TYPES) if image_dir.is_dir() else []
        if not images:
            errors.append(f"{s}: no images in {image_dir}")
        instances, empty, missing = [0] * len(names), 0, 0
        for image in images:
            digest = hashlib.md5(image.read_bytes()).hexdigest()
            if digest in hashes and hashes[digest][0] != s:
                errors.append(f"{image.name} ({s}) is identical to {hashes[digest][1]} ({hashes[digest][0]}): leakage")
            hashes.setdefault(digest, (s, image.name))
            label = label_dir / f"{image.stem}.txt"
            if not label.is_file():
                missing += 1
                continue
            try:
                rows = parse_label(label, len(names))
            except ValueError as exc:
                errors.append(f"{s}: {exc}")
                continue
            empty += not rows
            for cls, *_ in rows:
                instances[cls] += 1
        report["splits"][s] = {"images": len(images), "without_label_file": missing, "with_no_objects": empty,
                               "instances": dict(zip(names, instances))}
        if missing:
            errors.append(f"{s}: {missing} images have no label file")
    train = report["splits"].get("train", {}).get("instances", {})
    for name, count in train.items():
        if count == 0:
            errors.append(f"train: no '{name}' boxes; the model cannot learn that class")
    if errors:
        raise ValueError("Dataset problems:\n  " + "\n  ".join(errors))
    return report


def check(args):
    print(json.dumps(check_dataset(args.data), indent=2))
    print("Dataset OK.")


# ---------- train ----------

def train(args):
    report = check_dataset(args.data)
    print(json.dumps(report, indent=2))
    from ultralytics import YOLO
    device = args.device
    if device == "auto":
        import torch
        device = "0" if torch.cuda.is_available() else "cpu"
    model = YOLO(args.model)
    run = model.train(data=str(Path(args.data).resolve()), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch,
                      device=device, patience=args.patience, project=str(ROOT / "runs"), name=args.name,
                      exist_ok=False, seed=0, deterministic=True, plots=not args.no_plots, amp=not args.no_amp,
                      workers=args.workers, verbose=False)
    best = Path(run.save_dir) / "weights" / "best.pt"
    print(f"Best weights: {best}")
    print(f"Evaluate on the held-out test split:\n  python train.py evaluate --weights {best} --data {args.data} "
          f"--baseline yolov8n.pt\nUse it live:\n  python count.py --weights {best} --show")


# ---------- evaluate ----------

def match(predictions, truths, iou=0.5):
    """Greedy one-to-one matching per class. predictions: [(cls, box, conf)], truths: [(cls, box)].

    Returns {cls: [tp, fp, fn]}.
    """
    result = {}
    for cls in {c for c, *_ in predictions} | {c for c, _ in truths}:
        preds = sorted((p for p in predictions if p[0] == cls), key=lambda p: -p[2])
        gts = [t[1] for t in truths if t[0] == cls]
        used, tp = set(), 0
        for _, box, _ in preds:
            best = max(((i, _box_iou(box, g)) for i, g in enumerate(gts) if i not in used),
                       key=lambda item: item[1], default=(None, 0))
            if best[1] >= iou:
                used.add(best[0])
                tp += 1
        result[cls] = [tp, len(preds) - tp, len(gts) - tp]
    return result


def scores(tp, fp, fn):
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else None
    rnd = lambda v: None if v is None else round(v, 3)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": rnd(precision), "recall": rnd(recall), "f1": rnd(f1)}


def evaluate_model(weights, base_names, image_dir, label_dir, conf, iou, imgsz, device):
    from ultralytics import YOLO
    model = YOLO(str(weights))
    ids = {str(n).lower(): int(i) for i, n in model.names.items()}
    # Map dataset class index -> model class id by name; classes the model lacks are reported as n/a.
    mapping = {d: ids[n.lower()] for d, n in enumerate(base_names) if n.lower() in ids}
    back = {m: d for d, m in mapping.items()}
    totals = {d: [0, 0, 0] for d in mapping}
    count_errors = []
    person = base_names.index("person") if "person" in base_names else None
    for image in sorted(p for p in image_dir.glob("*") if p.suffix.lower() in IMAGE_TYPES):
        frame = cv2.imread(str(image))
        h, w = frame.shape[:2]
        truths = []
        for cls, cx, cy, bw, bh in parse_label(label_dir / f"{image.stem}.txt", len(base_names)):
            truths.append((cls, [(cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h]))
        if not mapping:
            break
        rows = model.predict(frame, classes=list(back), conf=conf, imgsz=imgsz, device=device,
                             verbose=False)[0].boxes.data.cpu().numpy()
        predictions = [(back[int(r[5])], r[:4].tolist(), float(r[4])) for r in rows]
        for cls, (tp, fp, fn) in match(predictions, [t for t in truths if t[0] in mapping], iou).items():
            totals[cls] = [a + b for a, b in zip(totals[cls], (tp, fp, fn))]
        if person in mapping:
            count_errors.append(abs(sum(p[0] == person for p in predictions) - sum(t[0] == person for t in truths)))
    per_class = {n: scores(*totals[d]) if d in mapping else "n/a (model has no such class)"
                 for d, n in enumerate(base_names)}
    people = ({"images": len(count_errors), "count_mae": round(float(np.mean(count_errors)), 3),
               "count_exact_percent": round(100 * float(np.mean([e == 0 for e in count_errors])), 1)}
              if count_errors else "n/a")
    return {"weights": str(weights), "per_class": per_class, "people_count": people}


def evaluate(args):
    base, names, dirs = read_data(args.data)
    if args.split not in dirs:
        raise ValueError(f"data.yaml has no '{args.split}' split")
    image_dir = dirs[args.split]
    label_dir = labels_for(image_dir)
    device = args.device
    if device == "auto":
        import torch
        device = "0" if torch.cuda.is_available() else "cpu"
    out = {"split": args.split, "iou": args.iou, "conf": args.conf, "imgsz": args.imgsz,
           "trained": evaluate_model(args.weights, names, image_dir, label_dir, args.conf, args.iou, args.imgsz, device)}
    if args.baseline:
        out["baseline"] = evaluate_model(args.baseline, names, image_dir, label_dir, args.conf, args.iou, args.imgsz, device)
    print(json.dumps(out, indent=2))
    if args.split == "test":
        print("This is the held-out test split: report it once, after choosing settings on 'val'.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subs = p.add_subparsers(dest="command", required=True)
    e = subs.add_parser("extract", help="Sample frames from a recorded trip video (faces blurred)")
    e.add_argument("--video", required=True)
    e.add_argument("--output", default=str(ROOT / "datasets" / "unlabelled"))
    e.add_argument("--every", type=float, default=2.0, help="Seconds between saved frames")
    e.add_argument("--trip", help="Trip name used to keep its frames in one split (default: video name)")
    e.add_argument("--no-blur-faces", action="store_true")
    s = subs.add_parser("split", help="Build train/val/test by trip from labelled images")
    s.add_argument("--images", required=True)
    s.add_argument("--labels", help="Folder of YOLO .txt labels (default: next to the images)")
    s.add_argument("--output", default=str(ROOT / "datasets" / "bus"))
    s.add_argument("--names", default=",".join(DEFAULT_NAMES), help="Class names in label-index order")
    s.add_argument("--val", type=float, default=0.15)
    s.add_argument("--test", type=float, default=0.15)
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--allow-frame-split", action="store_true")
    s.add_argument("--allow-unlabelled", action="store_true")
    c = subs.add_parser("check", help="Validate labels, class counts and leakage")
    c.add_argument("--data", default=str(ROOT / "datasets" / "bus" / "data.yaml"))
    t = subs.add_parser("train", help="Fine-tune YOLO (runs check first)")
    t.add_argument("--data", default=str(ROOT / "datasets" / "bus" / "data.yaml"))
    t.add_argument("--model", default=str(ROOT / "yolov8n.pt"), help="Starting weights")
    t.add_argument("--epochs", type=int, default=100)
    t.add_argument("--imgsz", type=int, default=960)
    t.add_argument("--batch", type=int, default=8)
    t.add_argument("--patience", type=int, default=20, help="Stop after this many epochs without val improvement")
    t.add_argument("--device", default="auto")
    t.add_argument("--workers", type=int, default=2)
    t.add_argument("--name", default="bus")
    t.add_argument("--no-plots", action="store_true")
    t.add_argument("--no-amp", action="store_true")
    v = subs.add_parser("evaluate", help="Precision/recall per class and people-count error, vs a baseline")
    v.add_argument("--weights", required=True)
    v.add_argument("--data", default=str(ROOT / "datasets" / "bus" / "data.yaml"))
    v.add_argument("--split", choices=SPLITS, default="test")
    v.add_argument("--baseline", help="e.g. yolov8n.pt, to compare against the untrained model")
    v.add_argument("--conf", type=float, default=0.35)
    v.add_argument("--iou", type=float, default=0.5)
    v.add_argument("--imgsz", type=int, default=960)
    v.add_argument("--device", default="auto")
    args = p.parse_args()
    try:
        {"extract": extract, "split": split, "check": check, "train": train, "evaluate": evaluate}[args.command](args)
    except (ValueError, OSError, KeyError) as exc:
        p.error(str(exc))


if __name__ == "__main__":
    main()
