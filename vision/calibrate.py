"""Create a polygon-only seat map from a photo or first video/camera frame."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from fleet import DEFAULT_FLEET, capacity_for, load_fleet
from core import Detector, SeatAppearance, grid_seats, load_seatmap, seat_states, validate_seatmap, EMPTY


def read_frame(source, size=(1280, 720)):
    path = Path(source)
    frame = cv2.imread(str(path)) if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".webp"} else None
    if frame is not None:
        return frame
    cap = cv2.VideoCapture(int(source) if str(source).isdigit() else source)
    try:
        if not cap.isOpened():
            raise ValueError(f"Cannot open {source!r}: not an image, video, stream, or available camera index")
        if str(source).isdigit() and size:
            # Same request as count.py, so the map matches the counting resolution.
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, size[0])
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, size[1])
        ok, frame = False, None
        # Live cameras need a few frames for exposure to settle; videos use their first frame.
        for _ in range(15 if str(source).isdigit() else 1):
            ok, frame = cap.read()
        if not ok or frame is None:
            raise ValueError(f"{source!r} opened but returned no frame")
        return frame
    finally:
        cap.release()


def parse_grid(text):
    rows, _, cols = text.lower().partition("x")
    if not rows.strip().isdigit() or not cols.strip().isdigit() or int(rows) < 1 or int(cols) < 1:
        raise ValueError("Grid must look like 11x2 (rows x columns)")
    return int(rows), int(cols)


def empty_references(frame, polygons, detector=None):
    """Colour references for seats that look empty now; seats with people get none."""
    seats = [(i + 1, np.asarray(poly, np.float32)) for i, poly in enumerate(polygons)]
    if detector is not None:
        boxes = detector.boxes(frame)
        states = seat_states(boxes, seats, uncertain=detector.uncertain)
    else:
        states = {sid: EMPTY for sid, _ in seats}
    appearance = SeatAppearance(seats, frame.shape)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    return [[round(float(v), 6) for v in appearance.histogram(hsv, sid)] if states[sid] == EMPTY else None
            for sid, _ in seats]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True)
    p.add_argument("--bus", default="14")
    p.add_argument("--output")
    p.add_argument("--edit", help="Existing map to adjust")
    p.add_argument("--no-auto", action="store_true", help="Skip chair/couch proposals")
    p.add_argument("--capacity", type=int,
                   help="Configured seats in the whole bus (all cameras); default: the fleet file's seats for --bus")
    p.add_argument("--fleet", default=str(DEFAULT_FLEET), help="Fleet file from fleet.py; 'none' to ignore")
    p.add_argument("--camera-id", default=None, help="Name for this camera view, e.g. front or rear")
    p.add_argument("--first-id", type=int, default=None,
                   help="Seat ID of this map's first seat, so IDs stay unique across cameras")
    p.add_argument("--grid", default="10x2", help="Default rows x columns offered when pressing G")
    p.add_argument("--camera-size", default="1280x720", help="Live camera resolution; must match count.py")
    p.add_argument("--reference", action="store_true",
                   help="This frame shows the EMPTY bus: store per-seat colour references for EMPTY checks")
    args = p.parse_args()
    try:
        size = None if args.camera_size.lower() == "native" else tuple(int(v) for v in args.camera_size.lower().split("x"))
        frame = read_frame(args.source, size)
        parse_grid(args.grid)
    except ValueError as exc:
        p.error(str(exc))
    h, w = frame.shape[:2]
    polygons, labels, existing = [], [], {}
    if args.edit:
        existing = load_seatmap(args.edit)
        if existing["image_size"] != [w, h]:
            p.error("Existing map size differs from source")
        polygons = [s["polygon"] for s in existing["seats"]]
        labels = [s.get("label") for s in existing["seats"]]
    elif not args.no_auto:
        try:
            proposals = Detector().proposals(frame)
            for x1, y1, x2, y2 in proposals:
                x1, x2 = np.clip([x1, x2], 0, w - 1).astype(int).tolist()
                y1, y2 = np.clip([y1, y2], 0, h - 1).astype(int).tolist()
                polygons.append([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
                labels.append(None)
            print(f"{len(proposals)} chair/couch proposals. yolov8n has no bus-seat class: bus seats are often "
                  "missed or merged, so check every box and use G (grid) for seat blocks.")
        except Exception as exc:
            print(f"Auto proposals unavailable ({type(exc).__name__}); use manual polygons.")
    fleet = None if args.fleet.lower() == "none" else load_fleet(args.fleet)
    capacity = args.capacity or existing.get("capacity") or capacity_for(fleet, args.bus)
    if capacity:
        print(f"Bus {args.bus}: capacity {capacity} seats")
    camera_id = args.camera_id or existing.get("camera_id")
    first_id = args.first_id or (existing["seats"][0]["seat_id"] if existing else 1)
    blocks = len({label.split("R")[0] for label in labels if label})
    pending = []
    selected = [-1]
    drag = [None]
    name = "Calibration: click | Enter polygon | G grid | right select | D delete | S save | Q exit"

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
    print("Grid: click a seat block's 4 corners (front-left, front-right, back-right, back-left), press G.")
    print("N deselects, Backspace undoes pending point; Enter completes; D deletes; S saves JSON only.")
    try:
        while True:
            canvas = frame.copy()
            for i, polygon in enumerate(polygons):
                pts = np.array(polygon, np.int32)
                color = (0, 255, 255) if selected[0] == i else (0, 255, 0)
                cv2.polylines(canvas, [pts], True, color, 2)
                for pt in pts:
                    cv2.circle(canvas, tuple(pt), 3, color, -1)
                cv2.putText(canvas, str(first_id + i), tuple(pts.mean(axis=0).astype(int)), cv2.FONT_HERSHEY_SIMPLEX, .45, color, 1)
            if pending:
                cv2.polylines(canvas, [np.array(pending, np.int32)], False, (255, 0, 0), 2)
                for pt in pending:
                    cv2.circle(canvas, tuple(pt), 4, (255, 0, 0), -1)
            status = f"Seats in this view: {len(polygons)}" + (f" / capacity {capacity}" if capacity else "")
            cv2.putText(canvas, status, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, .6, (255, 255, 0), 2)
            cv2.imshow(name, canvas)
            key = cv2.waitKey(20) & 0xFF
            if key in (27, ord("q")) or cv2.getWindowProperty(name, cv2.WND_PROP_VISIBLE) < 1:
                break
            if key in (10, 13) and len(pending) >= 3:
                pts = np.array(pending, np.float32)
                if cv2.isContourConvex(pts) and cv2.contourArea(pts) > 1:
                    polygons.append(pending.copy())
                    labels.append(None)
                    pending.clear()
                else:
                    print("Polygon must be convex and not cross itself.")
            if key == ord("g"):
                if len(pending) != 4:
                    print("Grid needs exactly 4 pending corner points.")
                    continue
                answer = input(f"Rows x columns for this block [{args.grid}]: ").strip() or args.grid
                try:
                    rows, cols = parse_grid(answer)
                    cells = grid_seats(pending, rows, cols)
                except ValueError as exc:
                    print(exc)
                    continue
                blocks += 1
                for r, c, polygon in cells:
                    polygons.append(polygon)
                    labels.append(f"B{blocks}R{r}C{c}")
                pending.clear()
                print(f"Added {len(cells)} seats ({rows} rows x {cols} columns). Drag corners to fix any cell.")
            if key == 8 and pending:
                pending.pop()
            if key == ord("n"):
                selected[0] = -1
                pending.clear()
            if key == ord("d") and selected[0] >= 0:
                polygons.pop(selected[0])
                labels.pop(selected[0])
                selected[0] = -1
            if key == ord("s"):
                if not polygons or pending:
                    print("Finish pending polygons before saving.")
                    continue
                data = {"image_size": [w, h], "bus_id": args.bus,
                        "seats": [{"seat_id": first_id + i, "polygon": poly, **({"label": label} if label else {})}
                                  for i, (poly, label) in enumerate(zip(polygons, labels))]}
                if capacity:
                    data["capacity"] = capacity
                if camera_id:
                    data["camera_id"] = camera_id
                if args.reference:
                    try:
                        detector = Detector()
                    except Exception as exc:
                        print(f"Person check unavailable ({type(exc).__name__}); references assume the bus is empty.")
                        detector = None
                    references = empty_references(frame, polygons, detector)
                    for seat, reference in zip(data["seats"], references):
                        if reference is not None:
                            seat["empty_reference"] = reference
                    skipped = [s["seat_id"] for s, r in zip(data["seats"], references) if r is None]
                    if skipped:
                        print(f"No empty reference for seats {skipped}: a person or uncertain evidence is on them.")
                try:
                    validate_seatmap(data)
                except (ValueError, KeyError) as exc:
                    print(f"Not saved: {exc}")
                    continue
                output = Path(args.output) if args.output else Path(__file__).parent / f"seatmap_bus{args.bus}.json"
                output.write_text(json.dumps(data, indent=2), encoding="utf-8")
                print(f"Saved {len(polygons)} seats (IDs {first_id}-{first_id + len(polygons) - 1}) to {output}. "
                      "No image saved.")
    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
