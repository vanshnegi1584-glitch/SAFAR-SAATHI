"""Responsive live seat occupancy. Frames stay in RAM; network carries numbers only."""
import argparse
from collections import deque
import logging
from pathlib import Path
import threading
import time
from urllib.parse import quote

import cv2
import requests

from fleet import DEFAULT_FLEET, capacity_for, load_fleet, resolve_capacity
from core import (CountStabilizer, Detector, FaceLiveness, PersonTracker, SeatAppearance, SeatTracker, draw, load_seatmap,
                  scaled_seats, seat_states, shrink_box, summarize)

log = logging.getLogger("vision")


class Camera:
    """Drain live sources continuously; reconnect without blocking the inference loop."""
    def __init__(self, source, retry=2.0, size=None):
        self.source = int(source) if str(source).isdigit() else source
        self.retry = retry
        self.size = size  # (width, height) requested from live cameras; None keeps the driver default
        self.file = isinstance(self.source, str) and Path(self.source).is_file()
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.new_frame = threading.Condition(self.lock)
        self.latest = None
        self.sequence = 0
        self.connected = False
        self.connects = 0
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _describe(self):
        return f"camera index {self.source}" if isinstance(self.source, int) else "video file" if self.file else "stream"

    def _set_connected(self, connected):
        if connected and not self.connected:
            self.connects += 1
            if not self.file or self.connects == 1:
                log.info("Camera connected (%s)%s", self._describe(), " after reconnect" if self.connects > 1 else "")
        elif not connected and self.connected and not self.file and not self.stop.is_set():
            log.warning("Camera lost (%s); reconnecting. Seats will turn UNKNOWN, not empty", self._describe())
        self.connected = connected

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
                    log.warning("Cannot open %s (in use by another app, wrong index, or unplugged); "
                                "retrying in %.0f seconds", self._describe(), self.retry)
                    self.stop.wait(self.retry)
                    continue
                if self.size and not self.file:
                    # MJPG keeps USB webcams at 30 FPS at 720p; raw YUY2 often drops to 5-10 FPS.
                    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.size[0])
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.size[1])
                    got = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
                    if got != tuple(self.size):
                        log.warning("Camera gave %dx%d instead of the requested %dx%d", *got, *self.size)
                fps = cap.get(cv2.CAP_PROP_FPS)
                delay = 1 / fps if self.file and 0 < fps <= 240 else 1 / 30 if self.file else 0
                while not self.stop.is_set():
                    started = time.monotonic()
                    ok, frame = cap.read()
                    if not ok or frame is None or frame.size == 0:
                        # Reopening loops files and recovers disconnected cameras.
                        break
                    with self.new_frame:
                        self.sequence += 1
                        self.latest = (self.sequence, time.monotonic(), frame)
                        self.new_frame.notify_all()
                    self._set_connected(True)
                    self.stop.wait(max(0, delay - (time.monotonic() - started)))
            except (cv2.error, OSError):
                log.warning("Camera read failed; retrying")
            finally:
                cap.release()
                with self.lock:
                    self.latest = None
            self._set_connected(False)
            self.stop.wait(0.1 if self.file else self.retry)

    def snapshot(self):
        with self.lock:
            return self.latest

    def wait_newer(self, sequence, timeout):
        """Block until a frame newer than `sequence` exists (or timeout); no fixed-period polling."""
        with self.new_frame:
            self.new_frame.wait_for(lambda: self.stop.is_set() or (self.latest and self.latest[0] != sequence),
                                    timeout)
            return self.latest

    def close(self):
        self.stop.set()
        with self.new_frame:
            self.new_frame.notify_all()
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

    def clear(self):
        """Stop re-sending the last reading, e.g. while the camera is offline."""
        with self.lock:
            self.latest = None

    def _run(self):
        session = requests.Session()
        delivered = None
        try:
            while not self.stop.is_set():
                with self.lock:
                    item = self.latest
                if item and item is not delivered and time.monotonic() - item[0] <= self.max_age:
                    try:
                        response = session.post(self.url, json=item[1], timeout=(2, 3))
                        response.raise_for_status()
                        delivered = item  # resend only on failure; a new reading replaces it
                        log.debug("Counts delivered (HTTP %s)", response.status_code)
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
    p.add_argument("--capacity", type=int,
                   help="Configured bus seats; default: seat map 'capacity', else the fleet file's seats for --bus, else 40")
    p.add_argument("--fleet", default=str(DEFAULT_FLEET), help="Fleet file from fleet.py (seats per bus); 'none' to ignore")
    p.add_argument("--seatmap")
    p.add_argument("--camera-id", help="Default: seat map 'camera_id', else 'main'")
    p.add_argument("--rule", choices=["hip", "iou"], default="hip")
    p.add_argument("--iou", type=float, default=0.15)
    p.add_argument("--responsive", action="store_true",
                   help="Faster updates for live viewing: count reacts in ~1 s instead of ~2 s, seats faster; "
                        "slightly more flicker. Explicit --count-*/--occupy/--vacate values still win")
    p.add_argument("--count-seconds", type=float, help="People count: median over this many seconds (default 2.0)")
    p.add_argument("--count-hold", type=float,
                   help="People count changes only after the median differs for this many seconds")
    p.add_argument("--conf", type=float, default=0.35)
    p.add_argument("--no-dedupe", action="store_true",
                   help="Keep boxes that lie almost wholly inside a bigger person box (e.g. a raised arm)")
    p.add_argument("--track-confirm", type=int, default=3,
                   help="Frames a new person box must persist before it counts (anonymous tracking IDs)")
    p.add_argument("--track-forget", type=float, default=1.0,
                   help="Seconds a person can be out of view and keep the same tracking ID")
    p.add_argument("--nms-iou", type=float, default=0.6,
                   help="Two person boxes overlapping at least this much (IoU) are merged as one body")
    p.add_argument("--box-shrink", type=float, default=0.08,
                   help="Share of a person box's width cut from each side (top/bottom get 3/8 of it) before "
                        "tracking and drawing, so neighbours' boxes stop overlapping; 0 keeps YOLO's boxes")
    p.add_argument("--weak-conf", type=float, default=0.2,
                   help="Person detections between this and --conf make a seat UNKNOWN, never counted")
    p.add_argument("--occlusion", type=float, default=0.5,
                   help="Seat fraction covered by another person's box that makes it UNKNOWN")
    p.add_argument("--occupy-seconds", type=float)
    p.add_argument("--vacate-seconds", type=float)
    p.add_argument("--unknown-seconds", type=float, default=2.0)
    p.add_argument("--agree", type=float, default=0.7, help="Share of observations needed to change a seat state")
    p.add_argument("--outage-seconds", type=float, default=5.0,
                   help="No fresh frames for this long: all seats UNKNOWN and publishing pauses")
    p.add_argument("--reference-threshold", type=float, default=0.5,
                   help="Min colour correlation with the empty-seat reference for EMPTY")
    p.add_argument("--no-reference", action="store_true", help="Ignore empty-seat references in the seat map")
    p.add_argument("--camera-size", default="1280x720",
                   help="Live camera resolution to request (more pixels per far passenger); 'native' keeps the driver default")
    p.add_argument("--imgsz", type=int, default=960,
                   help="YOLO input size; 960 found people down to ~32 px tall in a simulated test, 640 down to ~41 px")
    p.add_argument("--device", default="auto", help="auto (NVIDIA if available), cpu, or 0")
    p.add_argument("--weights")
    p.add_argument("--no-screen-filter", action="store_true",
                   help="Count people shown on phones, laptops or TVs (baseline for evaluation)")
    p.add_argument("--face-liveness", action="store_true",
                   help="People whose visible face is judged fake are not counted; faces stay in RAM")
    p.add_argument("--live-threshold", type=float, default=0.5, help="Minimum real-face probability")
    p.add_argument("--liveness-interval", type=float, default=0.3,
                   help="Minimum seconds between background face liveness checks")
    p.add_argument("--spoof-memory", type=float, default=3.0,
                   help="Seconds a person judged fake stays excluded when its face is briefly missed")
    p.add_argument("--face-max-yaw", type=float, default=0.35, help="Faces turned further are not judged")
    p.add_argument("--face-pitch", default="0.45,0.75",
                   help="Nose position between eyes (0) and mouth (1) judged as frontal; outside = not judged")
    p.add_argument("--interval", type=float, default=5, help="Seconds between log lines and backend posts")
    p.add_argument("--sample-fps", type=float, help="Inference target: default 30 with --show, otherwise 1")
    p.add_argument("--backend", help="Optional original team backend, e.g. http://localhost:8000")
    p.add_argument("--fusion-url", help="Local bridge base URL, e.g. http://127.0.0.1:8010")
    p.add_argument("--show", action="store_true")
    p.add_argument("--duration", type=float, help="Optional seconds to run for smoke tests")
    return p


def apply_speed_preset(args):
    """Fill unset smoothing times from the steady (default) or --responsive preset.

    Simulated at 30 FPS: steady 2.0/1.0 shows a real count change after 1.97 s with no flicker;
    responsive 1.0/0.5 after 1.00 s, flickering up to 2 times per 10 s only for a detection
    present in ~40% of frames.
    """
    preset = ({"count_seconds": 1.0, "count_hold": 0.5, "occupy_seconds": 0.7, "vacate_seconds": 1.5} if args.responsive
              else {"count_seconds": 2.0, "count_hold": 1.0, "occupy_seconds": 1.0, "vacate_seconds": 2.0})
    for name, value in preset.items():
        if getattr(args, name) is None:
            setattr(args, name, value)


def main():
    p = parser()
    args = p.parse_args()
    args.sample_fps = args.sample_fps if args.sample_fps is not None else (30 if args.show else 1)
    apply_speed_preset(args)
    if (args.interval <= 0 or args.sample_fps <= 0 or not 0 < args.conf <= 1 or not 0 < args.weak_conf <= args.conf
            or not 0 < args.iou <= 1 or args.imgsz < 32 or not 0 < args.live_threshold < 1
            or not 0 < args.occlusion <= 1 or not -1 <= args.reference_threshold <= 1 or args.liveness_interval < 0):
        p.error("Invalid interval, FPS, confidence, IoU, image size, occlusion, reference or liveness setting")
    if not 0 <= args.box_shrink < 0.25 or not 0 < args.nms_iou <= 1:
        p.error("--box-shrink must be in [0, 0.25) and --nms-iou in (0, 1]")
    source = args.source
    try:
        native = not args.camera_size or args.camera_size.lower() == "native"
        camera_size = None if native else tuple(int(v) for v in args.camera_size.lower().split("x"))
        if camera_size and (len(camera_size) != 2 or min(camera_size) < 32):
            raise ValueError
    except ValueError:
        p.error("--camera-size must look like 1280x720")
    if not str(source).isdigit() and "://" not in str(source) and not Path(source).is_file():
        p.error(f"--source {source!r} is not a camera index, stream URL, or existing video file")
    try:
        smoother = CountStabilizer(args.count_seconds, args.count_hold)
        people_tracker = PersonTracker(confirm=args.track_confirm, forget=args.track_forget)
        tracker = SeatTracker(args.occupy_seconds, args.vacate_seconds, args.unknown_seconds,
                              args.agree, args.outage_seconds)
        seatmap = load_seatmap(args.seatmap) if args.seatmap else None
        fleet = None if args.fleet.lower() == "none" else load_fleet(args.fleet)
        capacity, capacity_source = resolve_capacity(args.capacity, (seatmap or {}).get("capacity"),
                                                     capacity_for(fleet, args.bus), args.bus)
        if capacity < 1:
            raise ValueError("capacity must be positive")
        if seatmap and len(seatmap["seats"]) > capacity:
            raise ValueError(f"{len(seatmap['seats'])} mapped seats exceed capacity {capacity}")
        pitch = tuple(float(v) for v in args.face_pitch.split(","))
        if len(pitch) != 2 or not 0 <= pitch[0] < pitch[1] or args.face_max_yaw <= 0:
            raise ValueError("--face-pitch needs 'low,high' with low < high, and --face-max-yaw must be > 0")
        liveness = FaceLiveness(max_yaw=args.face_max_yaw, pitch_range=pitch) if args.face_liveness else None
    except (ValueError, OSError, KeyError, cv2.error) as exc:
        p.error(str(exc))
    camera_id = args.camera_id or (seatmap or {}).get("camera_id", "main")
    references = {} if not seatmap or args.no_reference else {
        s["seat_id"]: s["empty_reference"] for s in seatmap["seats"] if "empty_reference" in s}
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("Bus %s capacity %d (from %s)", args.bus, capacity, capacity_source)
    if seatmap:
        log.info("Capacity %d | %d seats mapped by camera '%s' | %d never visible to it | %d with empty reference",
                 capacity, len(seatmap["seats"]), camera_id, capacity - len(seatmap["seats"]), len(references))
    camera = Camera(source, size=camera_size)
    backend = Publisher(args.backend.rstrip("/") + "/buses/" + quote(args.bus, safe="") + "/count", args.interval) if args.backend else None
    bridge = Publisher(args.fusion_url.rstrip("/") + "/vision", min(args.interval, 5)) if args.fusion_url else None
    publishers = [v for v in [backend, bridge] if v]
    detector = None
    started = time.monotonic()
    period = 1 / args.sample_fps
    next_due = 0
    last_sequence = -1
    last_good = time.monotonic()
    last_log = 0
    offline = False
    frame_times = deque(maxlen=60)
    geometry = {}  # frame shape -> (scaled seats, appearance regions); computed once per resolution
    show = args.show
    try:
        while args.duration is None or time.monotonic() - started < args.duration:
            try:
                if detector is None:
                    detector = Detector(args.weights, args.conf, args.imgsz, args.device,
                                        screen_filter=not args.no_screen_filter, liveness=liveness,
                                        live_threshold=args.live_threshold, weak_conf=args.weak_conf,
                                        liveness_interval=args.liveness_interval, spoof_memory=args.spoof_memory,
                                        liveness_async=True, dedupe=not args.no_dedupe,
                                        nms_iou=args.nms_iou)
                    detector.warmup()
                    last_good = time.monotonic()
                    log.info("Device %s | target %.1f FPS | seats change after %.1fs occupied / %.1fs empty / %.1fs unknown",
                             detector.device, args.sample_fps, args.occupy_seconds, args.vacate_seconds, args.unknown_seconds)
                item = camera.wait_newer(last_sequence, 0.05 if show else 0.5)
                tick = time.monotonic()
                if not item or item[0] == last_sequence or tick - item[1] >= 3:
                    if tick - last_good > args.outage_seconds and not offline:
                        offline = True
                        tracker.expire(tick)
                        for publisher in publishers:
                            publisher.clear()
                        log.warning("No fresh frames for %.0f s: all seats UNKNOWN, publishing paused", tick - last_good)
                elif tick >= next_due - 0.25 * period:
                    # Fixed cadence without bursts: catch up at most one period after a stall.
                    next_due = max(next_due, tick - 0.25 * period) + period
                    sequence, captured, frame = item
                    last_sequence = sequence
                    if offline or tick - last_good > args.outage_seconds:
                        smoother = CountStabilizer(args.count_seconds, args.count_hold)
                        people_tracker = PersonTracker(confirm=args.track_confirm, forget=args.track_forget)
                        offline = False
                        log.info("Frames flowing again; rebuilding seat evidence")
                    if frame.shape not in geometry:
                        seats = scaled_seats(seatmap, frame.shape) if seatmap else []
                        geometry[frame.shape] = (seats, SeatAppearance(seats, frame.shape) if references else None)
                    seats, appearance = geometry[frame.shape]
                    boxes = detector.boxes(frame)
                    if time.monotonic() - captured > 10:
                        log.warning("Inference too slow: stale observation discarded")
                        continue
                    # Count anonymous tracked people seen for several frames, not raw boxes, so a box that
                    # flickers or a duplicate of one body does not add to the count.
                    tight = [shrink_box(b, args.box_shrink, args.box_shrink * 3 / 8) for b in boxes]
                    tracked = people_tracker.update(tight, captured)
                    raw_people = min(capacity * 2, people_tracker.count(captured))
                    people = smoother.update(raw_people, captured)
                    looks_empty = None
                    if appearance:
                        hsv = []

                        def looks_empty(sid):
                            if sid not in references:
                                return True
                            if not hsv:
                                hsv.append(cv2.cvtColor(frame, cv2.COLOR_BGR2HSV))
                            return appearance.similarity(hsv[0], sid, references[sid]) >= args.reference_threshold
                    raw = seat_states(boxes, seats, args.rule, args.iou, detector.uncertain, args.occlusion, looks_empty)
                    states = tracker.update(raw, captured)
                    summary = summarize(states, capacity)
                    payload = {"count": people}
                    if seats and summary["verified"]:
                        # Compatibility contract: free/total are camera-verified seats only.
                        payload.update(seats_free=summary["empty"], seats_total=summary["verified"])
                    if backend:
                        backend.submit(payload)
                    if bridge:
                        extra = {"camera_id": camera_id}
                        if seats:
                            extra.update(seats_unknown=summary["unknown"], seats_mapped=summary["mapped"],
                                         seat_states={str(sid): state for sid, state in states.items()})
                        bridge.submit({"bus_id": args.bus, "timestamp": time.time() - (time.monotonic() - captured),
                                       **payload, **extra})
                    finished = time.monotonic()
                    last_good = finished
                    frame_times.append(finished)
                    measured_fps = ((len(frame_times) - 1) / (frame_times[-1] - frame_times[0])
                                    if len(frame_times) > 1 else 0)
                    age_ms = (finished - captured) * 1000
                    if finished - last_log >= args.interval:
                        seat_text = (f" | seats empty {summary['empty']} occupied {summary['occupied']} unknown "
                                     f"{summary['unknown']} of {summary['mapped']} mapped, {summary['unverified']} "
                                     f"of {capacity} unverified" if seats else "")
                        log.info("Observation: %s%s | raw count %d | %.1f FPS | frame age %.0f ms | ignored on screens %d | "
                                 "fake faces %d | uncertain %d | duplicates removed %d | IDs %s", payload, seat_text, raw_people,
                                 measured_fps, age_ms, detector.rejected, detector.spoofed, len(detector.uncertain),
                                 detector.duplicates, ",".join(f"P{i}" for i, _, ok in tracked if ok) or "-")
                        last_log = finished
                    if show:
                        try:
                            preview = draw(frame, seats, states, people, capacity)
                            for pid, (x1, y1, x2, y2), confirmed in tracked:  # anonymous tracking IDs
                                color = (255, 140, 0) if confirmed else (170, 170, 170)
                                cv2.rectangle(preview, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                                cv2.putText(preview, f"P{pid}" + ("" if confirmed else "?"), (int(x1) + 4, int(y1) + 24),
                                            cv2.FONT_HERSHEY_SIMPLEX, .8, color, 2)
                            for x1, y1, x2, y2 in detector.screens:
                                cv2.rectangle(preview, (int(x1), int(y1)), (int(x2), int(y2)), (255, 0, 255), 2)
                            for x1, y1, x2, y2 in detector.uncertain:
                                cv2.rectangle(preview, (int(x1), int(y1)), (int(x2), int(y2)), (0, 200, 255), 1)
                            for x1, y1, x2, y2 in detector.face_skipped:
                                cv2.rectangle(preview, (int(x1), int(y1)), (int(x2), int(y2)), (160, 160, 160), 1)
                                cv2.putText(preview, "not judged (pose)", (int(x1), max(12, int(y1) - 5)),
                                            cv2.FONT_HERSHEY_SIMPLEX, .45, (160, 160, 160), 1)
                            for (x1, y1, x2, y2), real in detector.faces:
                                color = (0, 220, 0) if real >= args.live_threshold else (0, 0, 255)
                                cv2.rectangle(preview, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                                cv2.putText(preview, f"{'real' if real >= args.live_threshold else 'fake'} {real:.2f}",
                                            (int(x1), max(12, int(y1) - 5)), cv2.FONT_HERSHEY_SIMPLEX, .5, color, 1)
                            cv2.putText(preview, f"raw {raw_people} | {measured_fps:.1f} FPS | {age_ms:.0f} ms | {detector.device}"
                                        f" | on screens: {detector.rejected} | fake faces: {detector.spoofed}",
                                        (10, 55), cv2.FONT_HERSHEY_SIMPLEX, .55, (255, 255, 0), 1)
                            cv2.imshow("SafarSaathi debug - Q to exit", preview)
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
    except KeyboardInterrupt:
        pass
    finally:
        camera.close()
        if detector:
            detector.close()
        for publisher in publishers:
            publisher.close()
        if show:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
