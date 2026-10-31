"""Create a polygon-only seat map from a photo or first video/camera frame."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from core import Detector, load_seatmap


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True)
    p.add_argument("--bus", default="14")
    p.add_argument("--output")
    p.add_argument("--edit", help="Existing map to adjust")
    p.add_argument("--no-auto", action="store_true")
    args = p.parse_args()
    source = Path(args.source)
    frame = cv2.imread(str(source)) if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".webp"} else None
    if frame is None:
        cap = cv2.VideoCapture(int(args.source) if args.source.isdigit() else args.source)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            p.error("Cannot read source")
    h, w = frame.shape[:2]
    polygons = []
    if args.edit:
        data = load_seatmap(args.edit)
        if data["image_size"] != [w, h]:
            p.error("Existing map size differs from source")
        polygons = [s["polygon"] for s in data["seats"]]
    elif not args.no_auto:
        try:
            for x1, y1, x2, y2 in Detector().boxes(frame, cls=56):
                x1, x2 = np.clip([x1, x2], 0, w - 1).astype(int).tolist()
                y1, y2 = np.clip([y1, y2], 0, h - 1).astype(int).tolist()
                polygons.append([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
        except Exception as exc:
            print(f"Auto proposals unavailable ({type(exc).__name__}); use manual polygons.")
    pending = []
    selected = [-1]
    drag = [None]
    name = "Calibration: click add | Enter finish | right select | D delete | S save | Q exit"

    def mouse(event, x, y, flags, _):
        point = [min(max(x, 0), w - 1), min(max(y, 0), h - 1)]
        if event == cv2.EVENT_RBUTTONDOWN:
            selected[0] = next((i for i in reversed(range(len(polygons)))
                                if cv2.pointPolygonTest(np.array(polygons[i], np.float32), (x, y), False) >= 0), -1)
        elif event == cv2.EVENT_LBUTTONDOWN:
            idx = selected[0]
            if idx >= 0:
                distances = np.linalg.norm(np.array(polygons[idx]) - point, axis=1)
                if min(distances) <= 15:
                    drag[0] = (idx, int(np.argmin(distances)))
                    return
            pending.append(point)
        elif event == cv2.EVENT_MOUSEMOVE and drag[0] is not None:
            i, j = drag[0]
            polygons[i][j] = point
        elif event == cv2.EVENT_LBUTTONUP:
            drag[0] = None

    cv2.namedWindow(name, cv2.WINDOW_AUTOSIZE)
    cv2.setMouseCallback(name, mouse)
    print("Draw convex polygons in perimeter order. Right-click selects; drag selected vertices.")
    print("N deselects, Backspace undoes pending point; Enter completes; D deletes; S saves JSON only.")
    try:
        while True:
            canvas = frame.copy()
            for i, polygon in enumerate(polygons):
                pts = np.array(polygon, np.int32)
                color = (0, 255, 255) if selected[0] == i else (0, 255, 0)
                cv2.polylines(canvas, [pts], True, color, 2)
                for pt in pts:
                    cv2.circle(canvas, tuple(pt), 5, color, -1)
                cv2.putText(canvas, str(i + 1), tuple(pts.mean(axis=0).astype(int)), cv2.FONT_HERSHEY_SIMPLEX, .7, color, 2)
            if pending:
                cv2.polylines(canvas, [np.array(pending, np.int32)], False, (255, 0, 0), 2)
                for pt in pending:
                    cv2.circle(canvas, tuple(pt), 4, (255, 0, 0), -1)
            cv2.imshow(name, canvas)
            key = cv2.waitKey(20) & 0xFF
            if key in (27, ord("q")) or cv2.getWindowProperty(name, cv2.WND_PROP_VISIBLE) < 1:
                break
            if key in (10, 13) and len(pending) >= 3:
                pts = np.array(pending, np.float32)
                if cv2.isContourConvex(pts) and cv2.contourArea(pts) > 1:
                    polygons.append(pending.copy())
                    pending.clear()
                else:
                    print("Polygon must be convex and not cross itself.")
            if key == 8 and pending:
                pending.pop()
            if key == ord("n"):
                selected[0] = -1
                pending.clear()
            if key == ord("d") and selected[0] >= 0:
                polygons.pop(selected[0])
                selected[0] = -1
            if key == ord("s"):
                if not polygons or pending or any(not cv2.isContourConvex(np.array(poly, np.float32)) or cv2.contourArea(np.array(poly, np.float32)) <= 1 for poly in polygons):
                    print("Finish pending polygons and fix invalid polygons before saving.")
                    continue
                output = Path(args.output) if args.output else Path(__file__).parent / f"seatmap_bus{args.bus}.json"
                data = {"image_size": [w, h], "seats": [{"seat_id": i + 1, "polygon": poly} for i, poly in enumerate(polygons)]}
                output.write_text(json.dumps(data, indent=2), encoding="utf-8")
                print(f"Saved {len(polygons)} seats to {output}. No image saved.")
    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
