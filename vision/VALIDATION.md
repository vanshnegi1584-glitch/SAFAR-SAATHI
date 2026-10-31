# Executed validation — 31 October 2026

## Update: seat states, large buses, latency (31 October 2026, afternoon)

Same laptop; inference on the RTX 3050 unless marked CPU. Camera tests used the laptop
**webcam pointed at a room, not a bus**; no bus footage was available.

- `python -m pytest tests -q`: **34 passed in 2.25 s** (1 Starlette `httpx` deprecation warning).
  `tests/test_occupancy.py` holds synthetic scenarios A-L: empty seats, a seated person with no
  face, several passengers on distinct seats, one person never on two seats, partial bodies,
  weak evidence and blocked seats as UNKNOWN, a bag detected via the empty reference, enter/leave
  timing with missed detections, irregular 1 FPS timing, 80- and 90-seat maps, duplicate and
  over-capacity rejection, perspective grids, partial coverage through fusion, two-camera
  merging (pure function and HTTP bridge), simulated camera unplug/reconnect, outage -> UNKNOWN,
  and the calibration grid workflow. All geometry and cameras are simulated.
- `python tests/smoke_pipeline.py`: **SMOKE PASS**. Real YOLOv8n on a generated video; both
  synthetic seats went UNKNOWN -> EMPTY after ~2 s and reached `/fusion` as partial coverage.
  The run length was raised from 8 s to 14 s because seats now need evidence before EMPTY.
  This run found and fixed a tracker bug (1 FPS evidence never spanned the dwell window).
- Performance, `benchmark.py` (150 frames after warm-up, 640x480 webcam at 30 FPS):

  | Configuration | Detect mean / p95 | Processed FPS | Frame age mean / p95 |
  | --- | --- | --- | --- |
  | Before, GPU | 17.4 / 29.9 ms | 30.2 | 25.5 / 46.6 ms |
  | Before, GPU + face liveness | 49.2 / 105.4 ms | 18.7 | 68.5 / 138.7 ms |
  | Before, CPU | 28.0 / 32.7 ms | 30.0 | 32.0 / 54.6 ms |
  | After, GPU (+ 90-seat logic 1.7 / 3.1 ms) | 16.3 / 29.8 ms | 29.8 | 19.4 / 32.5 ms |
  | After, GPU + liveness every 0.5 s | 16.7 / 35.2 ms | 29.8 | 20.2 / 38.6 ms |
  | After, CPU | 27.4 / 31.6 ms | 29.3 | 32.6 / 53.5 ms |

- Live `count.py --show` (25 s each, log lines every 3 s): before ~20 FPS and 30-75 ms frame
  age; after 28.9-30.2 FPS and 14-40 ms. With `--face-liveness`: before 16-21 FPS / 39-95 ms;
  after 26.5-28 FPS / 19-48 ms. Root cause of the old gap: a fixed `sleep(1/fps)` after each
  frame drifted out of phase with the camera. During the liveness run, `count: 0` with
  `fake faces 1` was logged, consistent with a real face being scored fake.
- Profiling (40 webcam frames): YuNet 13.3 ms per frame, MiniFASNet 1.3 ms per face,
  YOLO FP32 8.2 ms vs FP16 9.6 ms in isolation, so FP16 was not adopted.

Still not measured: any real bus result (people, per-seat, false-empty, unknown rate),
automatic chair-proposal quality on bus seats, multi-camera with real cameras, physical
unplug/replug, Raspberry Pi 5 performance.

## Update: public seat datasets and first seat model (31 October 2026, evening)

- Datasets (downloaded by the user from Roboflow Universe): Inside Bus View v5 (1,378 images,
  Public Domain) and VISTA v1 (1,088 images from 452 originals, CC BY 4.0 with a research-only
  note). kdglab bus-seat-detection was inspected and excluded (people in 191 of 366 images while
  only empty seats are labelled; multi-seat boxes).
- Leakage found and removed: 81% of Inside Bus View's own val/test images were within 20 of 256
  hash bits of a training image. `train.py resplit` (hash groups + augmented copies of one photo)
  gave 1,724 / 370 / 372 images with 0% near-duplicates across splits and no original in two splits.
- Training: yolov8n, imgsz 960, batch 8, RTX 3050. Stopped at epoch 51 (exit 1, cause unknown),
  resumed, then stopped at epoch 76 when the laptop entered Modern Standby (17:29). Best epoch 75.
- Validation / test (confidence 0.35, IoU 0.5): see the results table in README "Start with public
  bus-seat datasets". Test, run once: occupied P/R 0.900/0.905 (Inside Bus View) and 0.872/0.904
  (VISTA); empty P/R 0.896/0.879 and 0.962/0.982; "empty" boxes on occupied seats 3 of 3,311 and
  8 of 1,403; mAP@50 0.920.
- An evaluation script without a `__main__` guard hung on Windows (data-loader worker processes
  re-imported it); fixed, then the val evaluation took 48 s.
- `python -m pytest tests -q`: **57 passed**.
- Not measured: anything on GEHU buses; the seat model is not used by `count.py`.

## Update: flicker, face pose, distance (31 October 2026, late afternoon)

- `python -m pytest tests -q`: **40 passed**; `python tests/smoke_pipeline.py`: SMOKE PASS
  with the new defaults (720p request, `imgsz 960`).
- Count flicker with a photo (webcam, 25 s per-frame log): the photo's person box swung between
  confidence 0.16 and 0.86 while it moved, and the old 3-frame median covered 0.1 s at 30 FPS.
  Replaced by a 2 s median that changes only after 1 s (synthetic tests: a photo detected in every
  other frame changes the count at most once in 5 s; a real arrival shows within 1-2 s).
- Head pose (webcam, one person): looking straight pitch 0.55-0.65; looking down up to 0.90; no
  real face scored fake in that controlled run. Pose gate and 1.5 s voting added anyway, because
  single bad checks were dropping a real person in normal use.
- Distance at 720p, after fixing a coordinate bug found by this same test: real face scored fake in
  3% of checks at ~1 m, 0-23% at 2-4 m (60-100+ px faces). A printed photo was scored **real**
  in 97-100% of checks at 1-2 m. Face liveness therefore does not reliably reject that photo.
- Simulated far-person detection (frames shrunk onto a plain canvas, not a bus): `imgsz 640`
  20/20 at 41 px, 7/20 at 32 px; `imgsz 960` 20/20 at 32 px; both 0/20 at 24 px.
- Speed at 720p with face liveness: 20.2 FPS, p95 107 ms before the background thread; 28-29 FPS,
  p95 32-35 ms after (benchmark); live `count.py` 27.5-29.8 FPS, 12-57 ms frame age.

## Earlier results (morning, before the seat-state rework)

Environment: Windows laptop, Python 3.13.15 in `vision/.venv`, PyTorch 2.10.0+cu128,
torchvision 0.25.0+cu128, Ultralytics 8.4.194, OpenCV 4.14.0. NVIDIA RTX 3050 6GB
was detected and `torch.cuda.is_available()` returned true. Inference tests used CPU.

## Completed

- `python -m pytest tests -q`: **8 passed in 2.13 seconds**. Includes geometry,
  per-seat smoothing, invalid maps, stationary/moving/unknown-motion fusion, stale
  observations, partial coverage, HTTP schema/bus isolation, HTTP 503 recovery,
  stale publish expiry, simulated capture reconnect/file looping, evaluation arithmetic,
  and simulated calibration mouse editing with JSON-only save.
- One dependency deprecation warning: Starlette's test client recommends `httpx2`;
  installed `httpx` works and all API tests pass. No runtime failure observed.
- Webcam: `count.py --bus 14 --source 0 --show --interval 2
  --backend http://127.0.0.1:8999 --duration 45` completed with exit code 0.
  Repeated live observations reported count 1 while delivery repeatedly timed out;
  the inference loop continued. This is not a manually labelled accuracy measurement.
  No frames were saved. An earlier 20-second startup run discarded its first stale
  observation after slow warmup; the warmed rerun produced counts normally.
- `python tests/smoke_pipeline.py`: passed. A generated 3-second video looped during
  an 8-second inference run, real YOLOv8n detected zero people, and the two synthetic
  seat regions were reported free via HTTP 200 to the actual local FastAPI bridge.
  `/fusion` correctly reported partial coverage with unknown whole-bus availability.
  A separately injected numeric full-map observation produced camera availability 0.
  This injection verifies policy and transport, not real full-bus vision accuracy.
- Evaluation smoke test: sampled 3 synthetic frames with 8 total context inferences,
  exported blank manual-label columns and both rules, temporarily saved 3 synthetic
  labelling images, then deleted all 3 using the cleanup command. The generated video
  was also removed. Ignored numeric CSV/metadata and synthetic map remain locally.
- Synthetic CPU pipeline throughput: **31.61 FPS**, measured after warmup at `imgsz=640`,
  confidence .35, window 5, on 640x480 generated empty imagery. Includes geometry and
  both smoothing rules; excludes decode/display/network. Only 8 timed inference calls;
  this is not a representative real-bus benchmark or Raspberry Pi estimate.
- Python compilation passed. Source review found frame writes only in opt-in offline
  evaluation and generated test fixtures; live counting/calibration have no image writes.

The sandbox-isolated first test attempt could not complete local HTTP tests; it was
stopped and the complete suite was rerun successfully outside sandbox isolation.

## Pending / not measured

- Actual bus calibration and a human-operated calibration GUI review.
- Real bus people exact-match %, within +/-1 %, MAE, per-seat accuracy, and free-total accuracy.
- Real bus CPU FPS and Raspberry Pi 5 speed/power/temperature.
- Rule selection or tuning on a validation split, followed by held-out test results.
- Physical camera unplug/replug. Reconnect logic is tested with simulated capture failure;
  a native camera driver hang is not covered.
- Actual ESP32/MQTT input and IR recalibration protocol.
- Team backend `POST /buses/14/count` and `GET /buses/14` / `seat_source: camera`.
  The GitHub repository was empty and contained no backend to run.
- Student allocation message "Bus 14 full, take Bus 15" in the team's UI/backend.
- Complete multi-camera bus coverage and standing-passenger ambiguity.

No "90%+" accuracy claim is made. No production service, hardware, or team backend
was changed or represented as completed.
