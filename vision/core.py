"""Shared, image-in-memory detection and seat geometry. No frame persistence."""
import json
import math
import os
import threading
from collections import deque
from pathlib import Path
from statistics import median, median_high
import time

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / ".ultralytics"))
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault("YOLO_VERBOSE", "false")

OCCUPIED, EMPTY, UNKNOWN = "occupied", "empty", "unknown"
# Classes are looked up by name, so a custom-trained model (e.g. person + seat) works too.
# COCO tv, laptop, cell phone: a person drawn inside one is a picture, not a passenger.
SCREEN_NAMES = ("tv", "laptop", "cell phone")
# COCO chair, couch are the only seat-like classes yolov8n knows; a trained model can add "seat".
SEAT_NAMES = ("seat", "chair", "couch")


def drop_screen_people(people, screens, overlap=0.7):
    """Keep people whose box is not mostly inside a detected screen."""
    kept = []
    for x1, y1, x2, y2 in people:
        area = max(0, x2 - x1) * max(0, y2 - y1)
        inside = any(max(0, min(x2, sx2) - max(x1, sx1)) * max(0, min(y2, sy2) - max(y1, sy1)) >= overlap * area
                     for sx1, sy1, sx2, sy2 in screens)
        if area > 0 and not inside:
            kept.append([x1, y1, x2, y2])
    return kept


def drop_part_boxes(people, inside=0.85, max_size=0.5):
    """Drop a box that is mostly inside a bigger person box: a second detection of the same body
    (an arm or upper body when someone raises a hand). Kept strict so a real person partly hidden
    behind another, whose box is not almost wholly inside the other's, is still counted."""
    area = lambda b: max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    kept = []
    for i, small in enumerate(people):
        part = False
        for j, big in enumerate(people):
            if i == j or area(big) <= area(small) or area(small) > max_size * area(big):
                continue
            ix = max(0.0, min(small[2], big[2]) - max(small[0], big[0]))
            iy = max(0.0, min(small[3], big[3]) - max(small[1], big[1]))
            if area(small) and ix * iy / area(small) >= inside:
                part = True
                break
        if not part:
            kept.append(small)
    return kept


def drop_group_boxes(people, inside=0.7, min_height=0.6, apart=0.5):
    """Drop a box drawn around two or more people standing close together, keeping their own boxes.

    Without this, two touching people plus the box around both count as three. A box is a group box
    only when at least two other boxes are mostly inside it, are each most of its height (whole people,
    not an arm or a torso) and are side by side rather than one inside the other."""
    area = lambda b: max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])

    def within(a, b):  # share of a's area inside b
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        return ix * iy / area(a) if area(a) else 0.0

    kept = []
    for i, big in enumerate(people):
        members = [b for j, b in enumerate(people) if j != i and area(b) < area(big) and within(b, big) >= inside
                   and (b[3] - b[1]) >= min_height * (big[3] - big[1])]
        group = any(within(a, b) < apart and within(b, a) < apart
                    for k, a in enumerate(members) for b in members[k + 1:])
        if not group:
            kept.append(big)
    return kept


def shrink_box(box, side=0.08, top=0.03):
    """A slightly tighter box: YOLO person boxes include spread arms and margin, so neighbours' boxes
    overlap even when the people do not. `side`/`top` are the share of width/height cut from each edge."""
    x1, y1, x2, y2 = box[:4]
    dx, dy = side * (x2 - x1), top * (y2 - y1)
    return [x1 + dx, y1 + dy, x2 - dx, y2 - dy]


class PersonTracker:
    """Anonymous, temporary IDs for person boxes (P1, P2, ...), matched by box overlap between frames.

    No face or appearance is stored: an ID lives only while its box keeps being seen, and a person
    who leaves for longer than `forget` seconds gets a new ID on return. IDs are never reused.
    A track counts as a person only after `confirm` sightings (not necessarily consecutive, so a real
    person the detector catches every other frame still counts), so a false box that appears for a
    frame or two and vanishes is not counted.

    Collisions: when two people's boxes touch, the detector can briefly lose one person or move a
    box so far that overlap no longer matches. A counted person's track then takes back the nearest
    leftover box of similar height within `rematch` box widths of where it was last seen, keeping
    the old ID instead of making a new one. The count is unchanged by this; only IDs are steadier.
    """
    def __init__(self, match_iou=0.3, confirm=3, forget=1.0, rematch=1.0):
        if not 0 < match_iou < 1 or confirm < 1 or forget <= 0 or rematch < 0:
            raise ValueError("match_iou must be in (0, 1), confirm >= 1 frame, forget > 0 seconds, rematch >= 0")
        self.match_iou, self.confirm, self.forget, self.rematch = match_iou, confirm, forget, rematch
        self.tracks = []  # dicts: id, box, hits, last
        self.next_id = 1

    @staticmethod
    def _match(a, b):
        """Overlap score of the same person in consecutive frames. IoU alone fails when a box suddenly
        grows or shrinks (an arm raised or lowered), so a box mostly containing the other also matches."""
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
        inside_smaller = ix * iy / smaller if smaller > 0 else 0.0
        return max(_box_iou(a, b), 0.8 * inside_smaller)

    def update(self, boxes, now):
        pairs = sorted(((self._match(t["box"], b), ti, bi) for ti, t in enumerate(self.tracks) for bi, b in enumerate(boxes)),
                       reverse=True)
        matches = []
        used_t, used_b = set(), set()
        for score, ti, bi in pairs:
            if score < self.match_iou or ti in used_t or bi in used_b:
                continue
            matches.append((ti, bi))
            used_t.add(ti)
            used_b.add(bi)
        # Second chance for counted people lost in a collision: the nearest leftover box of similar
        # height close to where the track was last seen keeps the old ID.
        near = []
        for ti, t in enumerate(self.tracks):
            if ti in used_t or t["hits"] < self.confirm:
                continue
            px1, py1, px2, py2 = t["box"][:4]
            for bi, b in enumerate(boxes):
                if bi in used_b or not 0.6 <= (b[3] - b[1]) / max(1e-6, py2 - py1) <= 1 / 0.6:
                    continue
                dist = math.hypot((b[0] + b[2] - px1 - px2) / 2, (b[1] + b[3] - py1 - py2) / 2)
                if dist <= self.rematch * (px2 - px1):
                    near.append((dist, ti, bi))
        for _, ti, bi in sorted(near):
            if ti not in used_t and bi not in used_b:
                matches.append((ti, bi))
                used_t.add(ti)
                used_b.add(bi)
        for ti, bi in matches:
            t = self.tracks[ti]
            t["box"], t["hits"], t["last"] = boxes[bi], t["hits"] + 1, now
        for ti, t in enumerate(self.tracks):
            if ti not in used_t:
                t["hits"] = min(t["hits"], self.confirm)  # keep confirmation while briefly missed
        for bi, b in enumerate(boxes):
            if bi not in used_b:
                self.tracks.append({"id": self.next_id, "box": b, "hits": 1, "last": now})
                self.next_id += 1
        self.tracks = [t for t in self.tracks if now - t["last"] <= self.forget]
        return self.visible(now)

    def visible(self, now):
        """[(id, box, confirmed)] for tracks seen in the latest update."""
        return [(t["id"], t["box"], t["hits"] >= self.confirm) for t in self.tracks if t["last"] == now]

    def count(self, now):
        return sum(1 for _, _, confirmed in self.visible(now) if confirmed)


def split_fake_faces(people, faces, threshold=0.5):
    """Split people into (kept, suspect): suspect when every visible face in the box looks fake.

    Faceless people (backs of heads, masks the detector misses) are always kept, so a face is
    never required. Suspects are not counted, but they make a seat UNKNOWN rather than EMPTY.
    """
    kept, suspect = [], []
    for box in people:
        x1, y1, x2, y2 = box
        inside = [real for (fx1, fy1, fx2, fy2), real in faces
                  if x1 <= (fx1 + fx2) / 2 <= x2 and y1 <= (fy1 + fy2) / 2 <= y2]
        (kept if not inside or max(inside) >= threshold else suspect).append(box)
    return kept, suspect


def remember_spoofs(kept, suspects, faces, memory, now, seconds=3.0, threshold=0.5, match_iou=0.3):
    """Keep a person judged fake excluded for `seconds`, even in frames where its face is missed.

    memory is a list of [box, last_fake_time]. A kept person overlapping a remembered fake box
    becomes suspect again, unless a face judged real lies inside it (that clears the memory).
    Returns (kept, suspects, memory).
    """
    def real_face_inside(box):
        x1, y1, x2, y2 = box
        return any(real >= threshold and x1 <= (fx1 + fx2) / 2 <= x2 and y1 <= (fy1 + fy2) / 2 <= y2
                   for (fx1, fy1, fx2, fy2), real in faces)

    memory = [m for m in memory if now - m[1] <= seconds]
    for box in suspects:
        match = max(memory, key=lambda m: _box_iou(m[0], box), default=None)
        if match is not None and _box_iou(match[0], box) >= match_iou:
            match[0], match[1] = box, now
        else:
            memory.append([box, now])
    still_kept, suspects = [], list(suspects)
    for box in kept:
        match = next((m for m in memory if _box_iou(m[0], box) >= match_iou), None)
        if match is None:
            still_kept.append(box)
        elif real_face_inside(box):
            memory.remove(match)
            still_kept.append(box)
        else:
            match[0] = box  # follow the moving photo without refreshing its time
            suspects.append(box)
    return still_kept, suspects, memory


def liveness_crop(frame, box, scale=2.7, size=80):
    """MiniFASNetV2 input: the face box enlarged 2.7x around its centre, clamped to the frame."""
    h, w = frame.shape[:2]
    x, y, bw, bh = box
    scale = min((h - 1) / bh, (w - 1) / bw, scale)
    cx, cy, nw, nh = x + bw / 2, y + bh / 2, bw * scale, bh * scale
    x1, y1 = max(0, int(cx - nw / 2)), max(0, int(cy - nh / 2))
    x2, y2 = min(w - 1, int(cx + nw / 2)), min(h - 1, int(cy + nh / 2))
    return cv2.resize(frame[y1:y2 + 1, x1:x2 + 1], (size, size))


def face_pose(landmarks):
    """(yaw, pitch) ratios from YuNet's 5 landmarks: eyes, nose tip, mouth corners.

    Measured after undoing head roll. yaw: nose offset from the eye/mouth centre line in eye
    distances (0 = facing the camera). pitch: where the nose tip sits between the eye line (0)
    and the mouth line (1); it rises when the head tips down. Returns (nan, nan) if degenerate.
    """
    pts = np.asarray(landmarks, np.float64).reshape(5, 2)
    eyes = pts[:2][np.argsort(pts[:2, 0])]  # image-left eye first, whatever YuNet's order
    nose, mouth = pts[2], pts[3:].mean(axis=0)
    centre = eyes.mean(axis=0)
    angle = math.atan2(eyes[1, 1] - eyes[0, 1], eyes[1, 0] - eyes[0, 0])
    c, s = math.cos(-angle), math.sin(-angle)
    rot = lambda p: np.array([c * (p[0] - centre[0]) - s * (p[1] - centre[1]),
                              s * (p[0] - centre[0]) + c * (p[1] - centre[1])])
    nose, mouth = rot(nose), rot(mouth)
    eye_distance = float(np.linalg.norm(eyes[1] - eyes[0]))
    if eye_distance < 1e-3 or mouth[1] < 1e-3:
        return math.nan, math.nan
    return float((nose[0] - mouth[0] / 2) / eye_distance), float(nose[1] / mouth[1])


def frontal(yaw, pitch, max_yaw=0.35, pitch_range=(0.45, 0.75)):
    """True when the liveness model can be trusted on this pose (measured frontal: pitch 0.55-0.65).

    Degenerate geometry (nan) is judged anyway, so odd photos cannot slip past by breaking it.
    """
    if math.isnan(yaw) or math.isnan(pitch):
        return True
    return abs(yaw) <= max_yaw and pitch_range[0] <= pitch <= pitch_range[1]


def _box_iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy
    return ix * iy / union if union > 0 else 0.0


class FaceVotes:
    """Per-face vote over time: a face is fake only when its median score over `seconds` is.

    Faces are matched between checks by box overlap (no identity, no stored image). A face
    with fewer than `min_votes` checks is given the benefit of the doubt (treated as real),
    so one bad check on a real passenger cannot drop them.
    """
    def __init__(self, seconds=1.5, min_votes=2, match_iou=0.3):
        self.seconds, self.min_votes, self.match_iou = seconds, min_votes, match_iou
        self.tracks = []  # [box, deque[(time, real)]]

    def update(self, faces, now):
        for track in self.tracks:
            while track[1] and track[1][0][0] < now - self.seconds:
                track[1].popleft()
        self.tracks = [t for t in self.tracks if t[1]]
        smoothed, used = [], set()
        for box, real in faces:
            best = max(((i, _box_iou(box, t[0])) for i, t in enumerate(self.tracks) if i not in used),
                       key=lambda item: item[1], default=(None, 0))
            if best[1] >= self.match_iou:
                track = self.tracks[best[0]]
                used.add(best[0])
            else:
                track = [box, deque()]
                self.tracks.append(track)
                used.add(len(self.tracks) - 1)
            track[0] = box
            track[1].append((now, real))
            votes = [r for _, r in track[1]]
            smoothed.append((box, float(median(votes)) if len(votes) >= self.min_votes else 1.0))
        return smoothed


class FaceLiveness:
    """Real-vs-spoof face scores. Faces are processed in RAM only and never stored or sent.

    Only near-frontal faces are judged: MiniFASNet was trained on faces looking at the camera,
    and a head tipped down or turned is outside what it learned. Those faces go to `skipped`
    and never make a person suspect. Scores are voted over time by FaceVotes.
    """
    def __init__(self, face_model=ROOT / "models" / "face_detection_yunet_2023mar.onnx",
                 spoof_model=ROOT / "models" / "MiniFASNetV2.onnx", face_conf=0.8, min_face=40,
                 max_yaw=0.35, pitch_range=(0.45, 0.75), vote_seconds=1.5, min_votes=2, head_size=192):
        for path in (face_model, spoof_model):
            if not Path(path).is_file():
                raise FileNotFoundError(f"Missing {Path(path).name}; see README face liveness setup")
        self.faces = cv2.FaceDetectorYN.create(str(face_model), "", (320, 320), face_conf)
        self.spoof = cv2.dnn.readNetFromONNX(str(spoof_model))
        self.min_face, self.max_yaw, self.pitch_range = min_face, max_yaw, pitch_range
        self.votes = FaceVotes(vote_seconds, min_votes)
        self.head_size = head_size
        self.skipped, self.raw = [], []

    def _detect(self, image, offset=(0.0, 0.0), scale=1.0):
        """YuNet rows mapped back to full-frame coordinates."""
        h, w = image.shape[:2]
        self.faces.setInputSize((w, h))
        found = self.faces.detect(image)[1]
        if found is None:
            return []
        rows = found.copy()
        rows[:, :14] /= scale
        # Columns: x, y, w, h, then 5 landmark (x, y) pairs. Shift positions only, never w/h.
        rows[:, [0, 4, 6, 8, 10, 12]] += offset[0]
        rows[:, [1, 5, 7, 9, 11, 13]] += offset[1]
        return list(rows)

    def find_faces(self, frame, people=None):
        """Faces in the whole frame, or only in each person's head region when `people` is given.

        Head regions are enlarged to about `head_size` px, so a far passenger's small head is
        still found, and the cost grows with the number of people instead of the frame size.
        """
        if people is None:
            return self._detect(frame)
        h, w = frame.shape[:2]
        rows = []
        for x1, y1, x2, y2 in people:
            bw, bh = x2 - x1, y2 - y1
            if bw < 4 or bh < 4:
                continue
            region_h = min(bh, max(0.5 * bh, 1.2 * bw))  # head and shoulders, full or partial body
            rx1, ry1 = int(max(0, x1 - 0.15 * bw)), int(max(0, y1 - 0.1 * region_h))
            rx2, ry2 = int(min(w, x2 + 0.15 * bw)), int(min(h, y1 + region_h))
            crop = frame[ry1:ry2, rx1:rx2]
            if crop.size == 0:
                continue
            scale = min(4.0, self.head_size / max(crop.shape[:2]))
            if scale != 1.0:
                crop = cv2.resize(crop, None, fx=scale, fy=scale,
                                  interpolation=cv2.INTER_LINEAR if scale > 1 else cv2.INTER_AREA)
            rows += self._detect(crop, (rx1, ry1), scale)
        # Overlapping people can share a head region: keep the most confident copy of each face.
        rows.sort(key=lambda r: -r[14])
        unique = []
        for row in rows:
            box = [row[0], row[1], row[0] + row[2], row[1] + row[3]]
            if all(_box_iou(box, [u[0], u[1], u[0] + u[2], u[1] + u[3]]) < 0.5 for u in unique):
                unique.append(row)
        return unique

    def score(self, frame, now=None, people=None):
        """Return [(face xyxy, voted probability the face is real)] for judged faces only.

        `skipped` gets faces too small to judge or not facing the camera; `raw` keeps
        (box, face px, unvoted score) for diagnostics.
        """
        now = time.monotonic() if now is None else now
        judged, self.skipped, self.raw = [], [], []
        for row in self.find_faces(frame, people):
            x, y, bw, bh = (float(v) for v in row[:4])
            box = [x, y, x + bw, y + bh]
            if min(bw, bh) < self.min_face or not frontal(*face_pose(row[4:14]), self.max_yaw, self.pitch_range):
                self.skipped.append(box)
                continue
            # Raw 0-255 BGR, as MiniFASNet was trained; the crop comes from the full-resolution frame.
            self.spoof.setInput(cv2.dnn.blobFromImage(liveness_crop(frame, (x, y, bw, bh))))
            logits = self.spoof.forward()[0]
            probs = np.exp(logits - logits.max())
            real = float(probs[1] / probs.sum())
            judged.append((box, real))
            self.raw.append((box, int(min(bw, bh)), real))
        return self.votes.update(judged, now)


class LivenessWorker:
    """Runs FaceLiveness on a background thread so face checks never stall the camera loop.

    submit() replaces any frame still waiting (newest only); results() returns the latest faces.
    """
    def __init__(self, liveness, interval=0.3):
        self.liveness, self.interval = liveness, interval
        self.lock, self.wake, self.stop = threading.Lock(), threading.Event(), threading.Event()
        self.pending, self.faces, self.skipped, self.error = None, [], [], None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def submit(self, frame, people):
        with self.lock:
            self.pending = (frame, [list(b) for b in people])
        self.wake.set()

    def results(self):
        with self.lock:
            return list(self.faces), list(self.skipped)

    def _run(self):
        while not self.stop.is_set():
            self.wake.wait(0.5)
            self.wake.clear()
            with self.lock:
                item, self.pending = self.pending, None
            if item is None:
                continue
            started = time.monotonic()
            try:
                faces = self.liveness.score(item[0], started, item[1])
                with self.lock:
                    self.faces, self.skipped, self.error = faces, list(self.liveness.skipped), None
            except cv2.error as exc:
                self.error = exc
            self.stop.wait(max(0.0, self.interval - (time.monotonic() - started)))

    def close(self):
        self.stop.set()
        self.wake.set()
        self.thread.join(timeout=3)


class Detector:
    """Loads YOLO once. boxes() returns confident full-body person boxes; no face is required.

    After each call, `uncertain` holds person evidence too weak or suspicious to count
    (low confidence, or a face judged fake); seat logic turns it into UNKNOWN, never EMPTY.
    """
    def __init__(self, weights=None, conf=0.35, imgsz=640, device="cpu",
                 screen_filter=True, screen_conf=0.25, liveness=None, live_threshold=0.5,
                 weak_conf=0.2, liveness_interval=0.0, spoof_memory=3.0, liveness_async=False, dedupe=True,
                 nms_iou=0.6):
        if device == "auto":
            import torch
            device = "0" if torch.cuda.is_available() else "cpu"
        from ultralytics import YOLO, settings
        settings.update({"sync": False})
        self.model = YOLO(str(weights or ROOT / "yolov8n.pt"))
        ids = {str(name).lower(): int(i) for i, name in self.model.names.items()}
        if "person" not in ids:
            raise ValueError(f"Model has no 'person' class (it has: {', '.join(ids)})")
        self.person_class = ids["person"]
        self.screen_classes = tuple(ids[n] for n in SCREEN_NAMES if n in ids)
        self.seat_classes = tuple(ids[n] for n in SEAT_NAMES if n in ids)
        screen_filter = screen_filter and bool(self.screen_classes)  # a person-only model cannot see screens
        self.conf, self.imgsz, self.device = conf, imgsz, device
        # YOLO's default (0.7) keeps two boxes on one close-up body that overlap 60-70%; measured live,
        # 0.6 merged those and four people walking past each other stayed counted as four.
        self.nms_iou = nms_iou
        self.screen_filter, self.screen_conf, self.weak_conf = screen_filter, screen_conf, weak_conf
        self.liveness, self.live_threshold, self.liveness_interval = liveness, live_threshold, liveness_interval
        self.screens, self.faces, self.uncertain, self.rejected, self.spoofed = [], [], [], 0, 0
        self._faces_at = -math.inf
        self.spoof_memory, self._spoofs = spoof_memory, []
        self.face_skipped = []
        self.dedupe, self.duplicates = dedupe, 0
        self.worker = LivenessWorker(liveness, liveness_interval) if liveness and liveness_async else None

    def close(self):
        if self.worker:
            self.worker.close()

    def warmup(self, shape=(480, 640, 3)):
        """Pay CUDA/model initialisation before the first real frame, not on it."""
        self.boxes(np.zeros(shape, np.uint8))

    def _predict(self, frame, classes, conf):
        result = self.model.predict(frame, classes=list(classes), conf=conf, iou=self.nms_iou,
                                    imgsz=self.imgsz, device=self.device,
                                    save=False, save_txt=False, save_crop=False,
                                    show=False, verbose=False, visualize=False)[0]
        # One device-to-host transfer: x1, y1, x2, y2, confidence, class.
        return result.boxes.data.cpu().numpy()

    def proposals(self, frame):
        """Seat-like object boxes for calibration, de-duplicated across classes."""
        if not self.seat_classes:
            return []
        rows = self._predict(frame, self.seat_classes, self.weak_conf)
        boxes, scores = rows[:, :4].tolist(), rows[:, 4].tolist()
        keep = cv2.dnn.NMSBoxes([[x1, y1, x2 - x1, y2 - y1] for x1, y1, x2, y2 in boxes], scores, self.weak_conf, 0.5)
        return [boxes[i] for i in np.asarray(keep, int).reshape(-1)]

    def boxes(self, frame):
        screens = self.screen_filter
        floor = min(self.conf, self.weak_conf, self.screen_conf if screens else 1)
        # One pass for people and screens; lower thresholds keep weak evidence and phones.
        person = self.person_class
        rows = self._predict(frame, [person, *self.screen_classes] if screens else [person], floor)
        people = [r for r in rows if int(r[5]) == person]
        found = [r[:4].tolist() for r in people if r[4] >= self.conf]
        weak = [r[:4].tolist() for r in people if self.weak_conf <= r[4] < self.conf]
        if self.dedupe:
            # One box around two touching people: keep their own boxes. One body, two boxes
            # (e.g. a raised arm): keep the whole-body box only.
            kept = drop_part_boxes(drop_group_boxes(found + weak))
            self.duplicates = len(found) + len(weak) - len(kept)
            found = [b for b in found if b in kept]
            weak = [b for b in weak if b in kept]
        if screens:
            self.screens = [r[:4].tolist() for r in rows if int(r[5]) in self.screen_classes and r[4] >= self.screen_conf]
            kept = drop_screen_people(found, self.screens)
            self.rejected = len(found) - len(kept)
            found, weak = kept, drop_screen_people(weak, self.screens)
        suspects = []
        if self.liveness:
            now = time.monotonic()
            if self.worker:
                # Background check on this frame; use the newest finished result meanwhile.
                self.worker.submit(frame, found)
                self.faces, self.face_skipped = self.worker.results()
            elif now - self._faces_at >= self.liveness_interval:
                self.faces, self._faces_at = self.liveness.score(frame, now, found), now
                self.face_skipped = list(self.liveness.skipped)
            found, suspects = split_fake_faces(found, self.faces, self.live_threshold)
            found, suspects, self._spoofs = remember_spoofs(found, suspects, self.faces, self._spoofs, now,
                                                            self.spoof_memory, self.live_threshold)
            self.spoofed = len(suspects)
        self.uncertain = weak + suspects
        return found


def _polygon_iou(a, b):
    a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
    ax, ay, aw, ah = cv2.boundingRect(a)
    bx, by, bw, bh = cv2.boundingRect(b)
    if ax > bx + bw or bx > ax + aw or ay > by + bh or by > ay + ah:
        return 0.0
    inter, _ = cv2.intersectConvexConvex(a, b)
    union = cv2.contourArea(a) + cv2.contourArea(b) - inter
    return inter / union if union > 0 else 0.0


def load_seatmap(path, duplicate_iou=0.5):
    return validate_seatmap(json.loads(Path(path).read_text(encoding="utf-8")), duplicate_iou)


def validate_seatmap(data, duplicate_iou=0.5):
    """Validate a seat map. Optional keys: capacity, bus_id, camera_id, seat label, empty_reference."""
    size = data.get("image_size")
    if not isinstance(size, list) or len(size) != 2 or any(type(v) is not int or v <= 0 for v in size):
        raise ValueError("image_size must be [positive width, positive height]")
    seats = data.get("seats", [])
    if not seats:
        raise ValueError("Seat map must contain at least one seat")
    capacity = data.get("capacity")
    if capacity is not None and (type(capacity) is not int or capacity < len(seats)):
        raise ValueError(f"capacity must be an integer >= the {len(seats)} mapped seats")
    ids, polygons = set(), []
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
        reference = seat.get("empty_reference")
        if reference is not None and (not isinstance(reference, list) or len(reference) != HIST_BINS[0] * HIST_BINS[1]
                                      or not all(type(v) in (int, float) and v >= 0 for v in reference)):
            raise ValueError(f"Seat {sid}: invalid empty_reference")
        for other_id, other in polygons:
            if _polygon_iou(polygon, other) > duplicate_iou:
                raise ValueError(f"Seats {other_id} and {sid} overlap by more than {duplicate_iou:.0%}: duplicate seat?")
        polygons.append((sid, polygon))
    return data


def scaled_seats(seatmap, shape):
    h, w = shape[:2]
    sw, sh = seatmap["image_size"]
    if abs((w / h) / (sw / sh) - 1) > 0.02:
        raise ValueError(f"Camera frame is {w}x{h} but the seat map was calibrated at {sw}x{sh}; "
                         "aspect ratio changed, recalibrate this camera")
    return [(s["seat_id"], np.asarray(s["polygon"], np.float32) * [w / sw, h / sh])
            for s in seatmap["seats"]]


def grid_seats(corners, rows, cols, gap=0.08):
    """Split one perspective quadrilateral seat block into rows x cols seat polygons.

    corners: front-left, front-right, back-right, back-left of the block as seen in the image.
    A homography keeps far rows smaller than near rows; `gap` shrinks each cell so neighbours
    and the aisle do not overlap. Returns [(row, col, polygon)] in row-major order.
    """
    if rows < 1 or cols < 1 or not 0 <= gap < 0.5:
        raise ValueError("rows and cols must be positive; gap must be in [0, 0.5)")
    quad = np.asarray(corners, np.float32)
    if quad.shape != (4, 2) or not cv2.isContourConvex(quad) or cv2.contourArea(quad) <= 1:
        raise ValueError("Seat block needs 4 corners forming a convex quadrilateral")
    unit = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    homography = cv2.getPerspectiveTransform(unit, quad)
    cells = []
    for r in range(rows):
        for c in range(cols):
            u0, u1 = (c + gap) / cols, (c + 1 - gap) / cols
            v0, v1 = (r + gap) / rows, (r + 1 - gap) / rows
            square = np.float32([[[u0, v0], [u1, v0], [u1, v1], [u0, v1]]])
            polygon = cv2.perspectiveTransform(square, homography)[0]
            cells.append((r + 1, c + 1, [[int(round(x)), int(round(y))] for x, y in polygon]))
    return cells


def _anchor(box):
    x1, y1, x2, y2 = box
    return (x1 + x2) / 2, y1 + 0.65 * (y2 - y1)


def _box_polygon_overlap(box, poly):
    """(intersection / seat area, intersection over union) for a person box and a seat polygon."""
    x1, y1, x2, y2 = box
    if x2 <= x1 or y2 <= y1:
        return 0.0, 0.0
    rect = np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], np.float32)
    inter, _ = cv2.intersectConvexConvex(poly, rect)
    area = cv2.contourArea(poly)
    union = area + (x2 - x1) * (y2 - y1) - inter
    return (inter / area if area > 0 else 0.0), (inter / union if union > 0 else 0.0)


def _seat_score(box, poly, rule, threshold):
    """Association score of a person to a seat, or None when the person cannot be on it."""
    _, iou = _box_polygon_overlap(box, poly)
    inside = cv2.pointPolygonTest(poly, _anchor(box), False) >= 0
    if rule == "hip":
        return 1 + iou if inside else None
    return iou + inside if iou >= threshold else None


def assign_people(boxes, seats, rule="hip", threshold=0.15):
    """One-to-one person -> seat assignment by best score; returns {seat_id: person index}."""
    pairs = []
    for index, box in enumerate(boxes):
        for sid, poly in seats:
            score = _seat_score(box, np.asarray(poly, np.float32), rule, threshold)
            if score is not None:
                pairs.append((score, index, sid))
    assigned, used = {}, set()
    for _, index, sid in sorted(pairs, key=lambda p: -p[0]):
        if sid not in assigned and index not in used:
            assigned[sid] = index
            used.add(index)
    return assigned


def occupancy(boxes, seats, rule="hip", threshold=0.15):
    """Binary per-seat occupancy, each person on at most one seat."""
    assigned = assign_people(boxes, seats, rule, threshold)
    return {sid: int(sid in assigned) for sid, _ in seats}


HIST_BINS = (16, 8)


class SeatAppearance:
    """Hue/saturation histograms of seat regions, compared with the empty-bus calibration.

    Catches what person detection misses (bags, a passenger the detector cannot see): a seat
    that no longer looks like its empty self is UNKNOWN, not EMPTY. Only seat-region colour
    statistics are kept; no image is stored.
    """
    def __init__(self, seats, shape):
        h, w = shape[:2]
        self.regions = {}
        for sid, poly in seats:
            x, y, bw, bh = cv2.boundingRect(np.asarray(poly, np.int32))
            x, y = max(0, x), max(0, y)
            bw, bh = min(bw, w - x), min(bh, h - y)
            mask = np.zeros((bh, bw), np.uint8)
            cv2.fillConvexPoly(mask, np.asarray(poly, np.int32) - [x, y], 255)
            self.regions[sid] = (slice(y, y + bh), slice(x, x + bw), mask)

    def histogram(self, hsv, sid):
        rows, cols, mask = self.regions[sid]
        hist = cv2.calcHist([hsv[rows, cols]], [0, 1], mask, list(HIST_BINS), [0, 180, 0, 256])
        return cv2.normalize(hist, None, 1, 0, cv2.NORM_L1).flatten()

    def similarity(self, hsv, sid, reference):
        return float(cv2.compareHist(self.histogram(hsv, sid), np.asarray(reference, np.float32), cv2.HISTCMP_CORREL))


def seat_states(boxes, seats, rule="hip", threshold=0.15, uncertain=(), occlusion=0.5, looks_empty=None):
    """Raw per-frame state of every seat: OCCUPIED, EMPTY, or UNKNOWN.

    EMPTY needs positive evidence: no counted or uncertain person on the seat, the seat not
    covered by another person, and (when a reference exists) the seat looking like it did empty.
    """
    assigned = assign_people(boxes, seats, rule, threshold)
    states = {}
    for sid, poly in seats:
        poly = np.asarray(poly, np.float32)
        if sid in assigned:
            states[sid] = OCCUPIED
        elif any(_seat_score(box, poly, rule, threshold) is not None for box in uncertain):
            states[sid] = UNKNOWN
        elif any(_box_polygon_overlap(box, poly)[0] >= occlusion for box in boxes):
            states[sid] = UNKNOWN  # blocked by a passenger seated in front or standing
        elif looks_empty is not None and not looks_empty(sid):
            states[sid] = UNKNOWN
        else:
            states[sid] = EMPTY
    return states


class SeatTracker:
    """Time-based hysteresis so one bad frame cannot flip a seat, at any frame rate.

    A seat switches to a new state once that state made up at least `agree` of the
    observations spanning its dwell time (occupy/vacate/unknown seconds). Seats start
    UNKNOWN, and after `outage` seconds without observations every seat returns to UNKNOWN.
    """
    def __init__(self, occupy=1.0, vacate=2.0, unknown=2.0, agree=0.7, outage=5.0):
        if min(occupy, vacate, unknown) < 0 or not 0.5 <= agree <= 1 or outage <= 0:
            raise ValueError("dwell times must be >= 0, agree in [0.5, 1], outage > 0")
        self.dwell = {OCCUPIED: occupy, EMPTY: vacate, UNKNOWN: unknown}
        self.agree, self.outage = agree, outage
        self.history, self.stable, self.last = {}, {}, None

    def update(self, raw, now):
        self.expire(now)
        self.last = now
        horizon = max(self.dwell.values())
        for sid, state in raw.items():
            history = self.history.setdefault(sid, deque())
            history.append((now, state))
            # Keep one observation older than the horizon so sparse (1 FPS) evidence can span it.
            while len(history) > 1 and history[1][0] <= now - horizon:
                history.popleft()
            current = self.stable.setdefault(sid, UNKNOWN)
            if state == current:
                continue
            dwell = self.dwell[state]
            if dwell == 0:
                self.stable[sid] = state
                continue
            # Evidence window: from the newest observation at least `dwell` old up to now.
            start = max((t for t, _ in history if t <= now - dwell + 1e-6), default=None)
            if start is None:
                continue
            window = [s for t, s in history if t >= start]
            if window.count(state) >= self.agree * len(window):
                self.stable[sid] = state
        for sid in set(self.stable) - set(raw):
            del self.stable[sid]
            self.history.pop(sid, None)
        return dict(self.stable)

    def expire(self, now):
        """Camera or inference outage: forget evidence instead of letting seats look empty."""
        if self.last is not None and now - self.last > self.outage:
            self.history.clear()
            self.stable = {sid: UNKNOWN for sid in self.stable}
        return dict(self.stable)


def summarize(states, capacity):
    """Counts for publishing; only camera-verified seats contribute to free/total."""
    occupied = sum(s == OCCUPIED for s in states.values())
    empty = sum(s == EMPTY for s in states.values())
    unknown = len(states) - occupied - empty
    return {"occupied": occupied, "empty": empty, "unknown": unknown, "mapped": len(states),
            "verified": occupied + empty, "unverified": capacity - occupied - empty,
            "complete": occupied + empty == capacity}


class CountStabilizer:
    """Time-based people count that does not flicker when a detection comes and goes.

    The candidate is the median count over the last `window` seconds (ties round up, the
    conservative side). The reported count changes only after the candidate has differed
    from it for `hold` seconds, so a borderline detection (a moving photo, a half-hidden
    passenger) cannot toggle the count frame by frame. Works the same at 1 or 30 FPS.
    """
    def __init__(self, window=2.0, hold=1.0):
        if window <= 0 or hold < 0:
            raise ValueError("window must be > 0 and hold >= 0 seconds")
        self.window, self.hold = window, hold
        self.history, self.value, self.pending_since = deque(), None, None

    def update(self, count, now):
        self.history.append((now, count))
        while len(self.history) > 1 and self.history[0][0] < now - self.window:
            self.history.popleft()
        candidate = median_high([c for _, c in self.history])
        if self.value is None or candidate == self.value:
            self.value, self.pending_since = candidate, None
        elif self.pending_since is None:
            self.pending_since = now
        if self.pending_since is not None and now - self.pending_since >= self.hold:
            self.value, self.pending_since = candidate, None
        return self.value


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


STATE_COLORS = {OCCUPIED: (0, 0, 255), EMPTY: (0, 220, 0), UNKNOWN: (0, 200, 255)}


def draw(frame, seats, states, people, capacity=None):
    output = frame.copy()
    for sid, polygon in seats:
        polygon = np.asarray(polygon, np.int32)
        state = states.get(sid, UNKNOWN)
        state = {1: OCCUPIED, 0: EMPTY}.get(state, state)
        color = STATE_COLORS[state]
        cv2.polylines(output, [polygon], True, color, 2)
        center = tuple(polygon.mean(axis=0).astype(int))
        cv2.putText(output, str(sid) + ("?" if state == UNKNOWN else ""), center, cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
    text = f"People: {people}"
    if seats:
        summary = summarize({sid: {1: OCCUPIED, 0: EMPTY}.get(s, s) for sid, s in states.items()},
                            capacity or len(seats))
        text += (f" | Empty {summary['empty']} Occ {summary['occupied']} Unknown {summary['unknown']}"
                 f" of {len(seats)} mapped")
        if capacity and capacity > len(seats):
            text += f" | {capacity - len(seats)} not in view"
    elif capacity:
        # No seat map: assumes everyone visible is seated, so standing people hide free seats.
        text += f" | Seats free (estimate): {max(0, capacity - people)}/{capacity}"
    cv2.putText(output, text, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
    return output
