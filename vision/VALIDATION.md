# Executed validation — 31 October 2026

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
