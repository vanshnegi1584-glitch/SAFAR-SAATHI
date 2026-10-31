# Vansh's AI/CV and sensor-fusion module

Python 3.13, YOLOv8n person detection, calibrated visible seats, median smoothing,
and the stationary/moving fusion policy from section 4 of the TransitLink blueprint.
No custom training or tracking. COCO chair detection only proposes calibration regions;
runtime empty-seat detection is a geometric occupancy heuristic, not a trained bus-seat classifier.

## Setup (Windows 11 / Git Bash)

From the repository root:

```bash
py -3.13 -m venv vision/.venv
# NVIDIA GPU, compatible driver:
vision/.venv/Scripts/python -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
# On a CPU-only machine use the same command with --index-url https://download.pytorch.org/whl/cpu
vision/.venv/Scripts/python -m pip install -r vision/requirements.txt
cd vision
source .venv/Scripts/activate
python -c "import sys,torch; print(sys.version); print(torch.cuda.is_available())"
```

If `py` cannot find 3.13, install it or use `uv python install 3.13` and
`uv venv --python 3.13 vision/.venv` from the repo root. This workstation's created
venv uses Python 3.13.15. Use the venv's interpreter explicitly if shell activation fails.
YOLOv8n weights download to the ignored `vision/yolov8n.pt` on first use; prepare them
with internet before the demo. No camera content is uploaded for inference.
The default is CPU so evaluation and deployment behavior are explicit; use `--device 0`
for the laptop's NVIDIA GPU. See the [official PyTorch installer](https://pytorch.org/get-started/locally/)
and [Ultralytics prediction options](https://docs.ultralytics.com/modes/predict/).

## Calibrate an empty bus

```bash
python calibrate.py --bus 14 --source empty_bus.jpg
# A video uses its first frame; a camera accepts --source 0.
python calibrate.py --bus 14 --source empty_bus.jpg --edit seatmap_bus14.json --no-auto
```

The model proposes COCO class 56 (`chair`) boxes; bus seats can be missed or proposed
incorrectly, so inspect every region. Mark the seated hip region, avoid aisle space.

- Left-click successive vertices; Enter completes a convex polygon in perimeter order.
- Right-click a polygon to select it; left-drag its corner handles to adjust it.
- D deletes the selected polygon; N deselects/clears pending points.
- Backspace removes the last pending point. S saves. Q/Escape closes.

Seats are numbered in list order; deleting renumbers them. Finish edits before labelling.
Saves `seatmap_bus14.json` with `image_size: [width,height]` and
`seats: [{seat_id, polygon}]`. It never saves the calibration image. A fixed camera
is required: recalibrate after movement, zoom, cropping, or angle changes. Uniform
resolution scaling is supported; changed aspect ratio is rejected. Re-map occluded or
unseen seats only after arranging a camera view where they are actually visible.

## Count people and visible free seats

```bash
python count.py --bus 14 --source 0 --show --interval 5
python count.py --bus 14 --source 0 --seatmap seatmap_bus14.json --show --fusion-url http://127.0.0.1:8010
python count.py --bus 14 --source clip.mp4 --seatmap seatmap_bus14.json --show --backend http://LEAD-IP:8000
```

Files loop at their recorded frame rate; live sources are continuously drained so the
1 FPS inference uses a recent frame. Camera failures reopen after a delay. Each output
has an independent worker, request timeouts, and retries; only the latest reading is
kept and stale readings expire. No durable queue or video writer exists in the runtime.
Stop with Ctrl+C or Q in the debug window. `--duration 20` bounds smoke tests.
Native camera drivers can still hang or terminate a process; retry logic is not a
guarantee against OS/driver failure or power loss.

Flags: `--capacity 40`, `--conf .35`, `--imgsz 640`, `--window 5` (positive odd),
`--sample-fps 1`, `--rule hip|iou`, `--iou .15`, `--device cpu|0`, `--weights path.pt`.
People are clamped to `[0, 2*capacity]` to allow standing passengers. Without a map,
only `count` is sent. With a map, both seat fields are sent. Green polygons mean
apparently free, red mean occupied; this is not proof a seat is unblocked or usable.

The provisional default is the lower-middle point at `(box center x, y1 + .65*height)`
inside a polygon. Alternative `iou` compares polygon/whole-person-box intersection over
union. Both can misclassify standing people or hidden seats. The default is **not yet
selected by measured accuracy**. Every seat and the people count have a median window;
warmup ties are conservative (occupied). Outages reset history before fresh observations.

## Sensor fusion / teammate handoff

Start the local bridge (one bus, one worker):

```bash
VISION_BUS_ID=14 VISION_CAPACITY=40 python -m uvicorn service:app --host 127.0.0.1 --port 8010
```

PowerShell uses `$env:VISION_BUS_ID='14'` and `$env:VISION_CAPACITY='40'` before the command.
Interactive docs: `http://127.0.0.1:8010/docs`. The service is an in-memory local integration
bridge, not the team's production backend. Restart clears state. Do not use multiple
workers: they would have independent snapshots. Keep it on localhost or place a secured,
authenticated gateway in front of it for remote use.

Rahul/Siddhant forwards the blueprint telemetry as `POST /telemetry`:

```json
{"bus_id":"14","timestamp":1793422800.0,"gps":{"lat":30.3165,"lon":78.0322,"speed":0.0,"sats":8},"pax":{"in_count":45,"out_count":12,"net_current":33},"sos_active":false}
```

Replace the example timestamp with the current Unix time; synchronize device clocks.
The blueprint uses `B-402`, while the earlier demo uses `14`; set matching IDs on all
components. Never silently alias them. GPS and passenger data are accepted; no media
fields are accepted. Unknown fields, invalid values, wrong buses, stale/future timestamps,
and out-of-order updates are rejected. The camera posts to `/vision` using `--fusion-url`:

```json
{"bus_id":"14","timestamp":1793422800.0,"count":37,"seats_free":5,"seats_total":40}
```

Siddhant polls `GET /fusion` for `seats_free`, `source`, `recalibration_required`,
`expected_empty`, `visual_empty_seats`, `visual_seats_total`, `deviation`, and `motion`.
Null availability means unknown, not zero/full. Readings expire after 10 seconds.

| Condition | Decision |
| --- | --- |
| Fresh IR | Expected empty = max(0, capacity - IR net count) |
| Full camera map, absolute deviation > 3 seats, GPS speed <= 1 km/h and >= 4 satellites | Trust camera; raise recalibration flag |
| Same disagreement while moving or motion unknown | Trust IR; raise recalibration flag |
| Both agree within threshold | Use IR baseline |
| Stale/missing IR, fresh whole-bus camera | Use camera |
| Partial map | Return visible camera counts, never extrapolate them or compare against whole-bus IR |
| No usable whole-bus source | Return unavailable/null |

Thresholds live in `FusionConfig`; these are explicit engineering defaults, not tuned
values. `recalibration_required` is advisory; no hardware counter is overwritten. A full
seat count cannot tell how many standing passengers exist. Rahul and Siddhant must agree
on any safe reset protocol and transport topic. Latest-only state rejects replayed old
telemetry after a network partition. MQTT subscription, persistence, and production auth
belong to the team's integration and are not implemented here.

## Honest evaluation

Use representative, authorized bus footage. Keep validation and final test footage
separate (prefer different trips). Do not tune on reported test frames.

```bash
python evaluate.py sample --video test_bus.mp4 --seatmap seatmap_bus14.json --n 20 --split test --output evaluation/test
# Optional offline-only temporary images for manual labelling:
python evaluate.py sample --video test_bus.mp4 --seatmap seatmap_bus14.json --n 20 --split test --output evaluation/test_with_frames --save-frames
python evaluate.py report --csv evaluation/test/labels.csv
python evaluate.py cleanup --folder evaluation/test_with_frames
```

Fill `people_manual` and every `manual_seat_ID` (1 occupied, 0 empty) in `labels.csv`.
Count only visible people; annotate seat usability consistently. Do not guess labels for
occluded seats: use a separate ground-truth view or report the limitation. Each sampled
frame includes up to `window` preceding 1 Hz inference observations for smoothing.
Both rules use exactly the same detections. Exports never overwrite an existing folder.

Reports contain people exact-match %, within +/-1 %, MAE, per-seat accuracy, and
free-total exact-match % for each rule, with labelled denominators. Missing labels fail
the report by default; `--allow-partial` explicitly gives a provisional result. CPU FPS
is saved in `metadata.json`, excluding warmup, decoding, display, and network but including
inference, geometry, and both smoothing rules. It is not the configured 1 FPS sample rate.
Sampled frames are optional, git-ignored under `vision/evaluation/`, and deleted by cleanup.
Keep output in that ignored folder; other destinations are the operator's responsibility.

If validation results are bad, compare confidence, image size, window length, and rule
on validation footage only. Record before/after parameters and validation metrics.
Freeze the chosen settings, then run the separate held-out test once. No tuning or
rule superiority is claimed yet. Twenty frames are only a small demo evaluation.

## Validation status

Real bus passenger accuracy: **not measured**.
Real bus per-seat accuracy and free-total accuracy: **not measured**.
Real bus CPU FPS: **not measured**.
Synthetic empty-video CPU smoke timing: **31.61 FPS** over 8 timed inference calls;
this is not representative bus performance (see `VALIDATION.md`).
Before/after tuning: **not measured; no tuning performed**.
The 90%+ pitch claim remains an unverified target.

Run automated software checks with `python -m pytest tests -q`. They exercise geometry,
smoothing, stale/partial sensor fusion, schema validation, retry behavior, and metric
arithmetic using synthetic data. They do not establish model accuracy.
See `VALIDATION.md` for this workstation's executed checks and pending acceptance items.

## Limits and deployment

Crowding, overlapping bodies, low light, motion blur, wide-angle distortion, a poor camera
angle, and standing passengers covering seats can all break occupancy inference. A
person can overlap multiple polygons. Chair proposals can detect unrelated objects.
Unseen seats are not detected. A partial map cannot support a whole-bus "full" claim.

Target deployment: Raspberry Pi 5 and a fixed ceiling-mounted wide-angle camera; likely
2-3 cameras for complete bus coverage. Pi performance, power, and thermals are not
measured. Multi-camera seat-ID deduplication and people-count fusion are not implemented:
do not add separate camera totals or send concurrent independent counts for one bus.
Keep one authoritative stream per bus until a multi-camera aggregator is designed.
