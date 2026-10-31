"""Shared, image-in-memory detection and seat geometry. No frame persistence."""
import json
import os
from collections import deque
from pathlib import Path
from statistics import median

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / ".ultralytics"))
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault("YOLO_VERBOSE", "false")


class Detector:
    def __init__(self, weights=None, conf=0.35, imgsz=640, device="cpu"):
        from ultralytics import YOLO, settings
        settings.update({"sync": False})
        self.model = YOLO(str(weights or ROOT / "yolov8n.pt"))
        self.conf, self.imgsz, self.device = conf, imgsz, device

    def boxes(self, frame, cls=0):
        result = self.model.predict(frame, classes=[cls], conf=self.conf,
                                    imgsz=self.imgsz, device=self.device,
                                    save=False, save_txt=False, save_crop=False,
                                    show=False, verbose=False, visualize=False)[0]
        return result.boxes.xyxy.cpu().numpy().tolist()


def load_seatmap(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    size = data.get("image_size")
    if not isinstance(size, list) or len(size) != 2 or any(type(v) is not int or v <= 0 for v in size):
        raise ValueError("image_size must be [positive width, positive height]")
    seats = data.get("seats", [])
    if not seats:
        raise ValueError("Seat map must contain at least one seat")
    ids = set()
    for seat in seats:
        sid = seat["seat_id"]
        if type(sid) is not int or sid <= 0 or sid in ids:
            raise ValueError("seat_id must be a unique positive integer")
        ids.add(sid)
        polygon = np.asarray(seat["polygon"], dtype=np.float32)
        if polygon.ndim != 2 or polygon.shape[1] != 2 or len(polygon) < 3 or not np.isfinite(polygon).all():
            raise ValueError("Invalid polygon")
        if (polygon < 0).any() or (polygon[:, 0] >= size[0]).any() or (polygon[:, 1] >= size[1]).any():
            raise ValueError("Polygon outside image")
        if not cv2.isContourConvex(polygon) or cv2.contourArea(polygon) <= 1:
            raise ValueError("Seat polygons must be convex, non-crossing, and nonzero area")
    return data


def scaled_seats(seatmap, shape):
    h, w = shape[:2]
    sw, sh = seatmap["image_size"]
    if abs((w / h) / (sw / sh) - 1) > 0.02:
        raise ValueError("Frame aspect ratio changed; recalibrate camera")
    return [(s["seat_id"], np.asarray(s["polygon"], np.float32) * [w / sw, h / sh])
            for s in seatmap["seats"]]


def occupancy(boxes, seats, rule="hip", threshold=0.15):
    occupied = {}
    for sid, poly in seats:
        poly = np.asarray(poly, np.float32)
        hit = False
        for x1, y1, x2, y2 in boxes:
            if x2 <= x1 or y2 <= y1:
                continue
            if rule == "hip":
                hit = cv2.pointPolygonTest(poly, ((x1 + x2) / 2, y1 + 0.65 * (y2 - y1)), False) >= 0
            else:
                box = np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], np.float32)
                intersection, _ = cv2.intersectConvexConvex(poly, box)
                union = cv2.contourArea(poly) + (x2 - x1) * (y2 - y1) - intersection
                hit = union > 0 and intersection / union >= threshold
            if hit:
                break
        occupied[sid] = int(hit)
    return occupied


class Smoother:
    def __init__(self, window=5):
        if window < 1 or window % 2 == 0:
            raise ValueError("window must be a positive odd number")
        self.window = window
        self.history = {}

    def update(self, people, seats):
        values = {"people": people, **seats}
        result = {}
        for key, value in values.items():
            history = self.history.setdefault(key, deque(maxlen=self.window))
            history.append(value)
            # Conservative tie at warmup: an ambiguous seat remains occupied.
            result[key] = int(np.ceil(median(history)))
        return result.pop("people"), result


def draw(frame, seats, occupied, people):
    output = frame.copy()
    for sid, polygon in seats:
        polygon = np.asarray(polygon, np.int32)
        color = (0, 0, 255) if occupied[sid] else (0, 220, 0)
        cv2.polylines(output, [polygon], True, color, 2)
        center = tuple(polygon.mean(axis=0).astype(int))
        cv2.putText(output, str(sid), center, cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    text = f"People: {people}"
    if seats:
        text += f" | Visible seats free: {len(seats) - sum(occupied.values())}/{len(seats)}"
    cv2.putText(output, text, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 0), 2)
    return output
