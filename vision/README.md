# Vansh's AI/CV and sensor-fusion module

Counts passengers and reports which calibrated bus seats are **OCCUPIED**, **EMPTY** or
**UNKNOWN**, then hands numbers (never images) to the team backend and the IR fusion bridge.

- People are found by **full-body YOLOv8n person detection**. A face is never required: backs
  of heads, masks and partial bodies count when the body is visible.
- Seats come from a **calibration workflow** (perspective grid, optional chair proposals, manual
  correction), because yolov8n has `person`, `chair` and `couch` classes but **no bus-seat class**.
- A seat is EMPTY only on positive evidence; blocked or uncertain seats are UNKNOWN, never free.
- Results are smoothed over time, so one bad frame cannot flip a seat or the people count.
- No custom training, no identity tracking, no face recognition. Empty-seat detection is a
  geometric heuristic, not a trained classifier, and has **not been measured on bus footage**.

## Quick start (Windows PowerShell, from `vision/`)

```bash
.\.venv\Scripts\python.exe count.py --bus 14 --source 0 --show
```

```bash
.\.venv\Scripts\python.exe calibrate.py --bus 14 --source 0 --capacity 4 --reference
```

```bash
.\.venv\Scripts\python.exe count.py --bus 14 --source 0 --seatmap seatmap_bus14.json --show
```

1. The first command counts people from the webcam and opens a preview window.
2. The second captures one frame of **empty** seats, lets you mark them (press **G** for a grid,
   **S** to save) and writes `seatmap_bus14.json`.
3. The third adds seat states. Stop any of them with **Q** in the window or **Ctrl+C**.

`python -m pytest tests -q` runs the automated checks; `python benchmark.py` measures speed.

## Setup (Windows 11)

From the repository root (Git Bash shown; in PowerShell use `vision\.venv\Scripts\python.exe`):

```bash
py -3.13 -m venv vision/.venv
# NVIDIA GPU, compatible driver:
vision/.venv/Scripts/python -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
# On a CPU-only machine use the same command with --index-url https://download.pytorch.org/whl/cpu
vision/.venv/Scripts/python -m pip install -r vision/requirements.txt
vision/.venv/Scripts/python -c "import sys,torch; print(sys.version); print(torch.cuda.is_available())"
```

If `py` cannot find 3.13, use `uv python install 3.13` and `uv venv --python 3.13 vision/.venv`.
YOLOv8n weights download to the git-ignored `vision/yolov8n.pt` on first use; do this with
internet before a demo. No camera content is uploaded anywhere for inference.
`count.py` and `benchmark.py` use `--device auto` (NVIDIA GPU when CUDA is available, else CPU);
`evaluate.py` always uses CPU so its results are comparable. Optional face-liveness models are
listed under [Photos, screens and face liveness](#photos-screens-and-face-liveness).
References: [PyTorch installer](https://pytorch.org/get-started/locally/),
[Ultralytics prediction options](https://docs.ultralytics.com/modes/predict/).

## How it works

```
camera thread (newest frame only, reconnects)
   -> YOLO: people + phones/laptops/TVs in one pass
   -> drop people inside screens; low-confidence people become "uncertain"
   -> [optional, background thread] face liveness on head regions
   -> assign each person to at most one seat -> OCCUPIED / EMPTY / UNKNOWN per seat
   -> time-based smoothing of seats and of the people count
   -> publish numbers to the backend and/or the local fusion bridge
```

Frames live only in RAM. Seat maps hold coordinates and optional colour statistics, no images.

## Calibrate a bus (any capacity, e.g. 80-90 seats)

Calibrate once per fixed camera; the JSON map is reused on every restart.

```bash
# One camera covering seats 1-45 of a 90-seat bus, using a photo of the EMPTY bus:
python calibrate.py --bus 14 --source empty_bus.jpg --capacity 90 --camera-id front --first-id 1 --reference
# A second camera covering the rest; IDs continue so no physical seat gets two IDs:
python calibrate.py --bus 14 --source rear_empty.jpg --capacity 90 --camera-id rear --first-id 46 --output seatmap_bus14_rear.json --reference
# Adjust later (re-run with --reference to refresh empty-seat references):
python calibrate.py --bus 14 --source empty_bus.jpg --edit seatmap_bus14.json --no-auto
```

A live camera (`--source 0`) is opened at `--camera-size` (default 1280x720, the same as
`count.py`) and skips 15 frames so exposure settles; a video uses its first frame.

**Grid (recommended for rows of bus seats).** Click a seat block's 4 corners, front-left,
front-right, back-right, back-left, press **G**, and type `rows x columns` in the terminal
(e.g. `11x2` for the left side, `11x3` for the right). A homography splits the block into one
polygon per seat, so far rows come out smaller than near rows, and each cell is shrunk by 8% so
neighbours and the aisle do not overlap. Seats are labelled `B<block>R<row>C<col>`. Drag corners
of any cell that does not match a real seat and **D**elete cells for missing seats (doors,
wheelchair bays). Never draw cells for seats you cannot actually see: they would be treated
as visible.

**Automatic proposals.** Without `--no-auto`, chair/couch boxes from yolov8n are offered as
starting polygons (de-duplicated across classes). On real bus seats they are often missed or
merged into a row; treat them as hints. Their accuracy on bus seats is **not measured**.

| Key | Action |
| --- | --- |
| Left-click, Enter | Add vertices; Enter completes a convex polygon |
| G | Grid from 4 pending corners |
| Right-click, drag | Select a polygon; drag its corners |
| D / N / Backspace | Delete selected / deselect / undo last point |
| S / Q, Esc | Validate and save / close |

Saving rejects maps where two seats overlap by more than 50% (a duplicated seat) or that have
more seats than `capacity`. The map stores `image_size`, `bus_id`, `capacity`, `camera_id` and
`seats: [{seat_id, polygon, label?, empty_reference?}]`. `empty_reference` is a 128-number
hue/saturation histogram of each seat region, recorded with `--reference` only for seats with
no person or uncertain evidence on them. Seats are numbered in list order from `--first-id`;
deleting renumbers later seats, so finish edits before labelling. Recalibrate after the camera
moves, zooms or changes angle. Uniform resolution scaling is fine; a changed aspect ratio
(e.g. a 640x480 map used at 1280x720) is rejected with both sizes in the message. Old maps
(only `image_size` and `seats`) still load.

## Count people and seat states

```bash
python count.py --bus 14 --source 0 --show --interval 5
python count.py --bus 14 --source 0 --seatmap seatmap_bus14.json --show --fusion-url http://127.0.0.1:8010
python count.py --bus 14 --source clip.mp4 --seatmap seatmap_bus14.json --show --backend http://LEAD-IP:8000
```

**People** are YOLO `person` boxes at confidence >= `--conf` (0.35). Boxes between `--weak-conf`
(0.2) and `--conf` are *uncertain*: never counted, but a seat they touch becomes UNKNOWN.

**Seat states**, per observation:

1. Each counted person is assigned to at most one seat, best score first. With `--rule hip`
   (default) the point `(box centre x, y1 + .65*height)` must lie inside the seat polygon;
   `--rule iou` needs box/polygon IoU >= `--iou` (0.15). One person never occupies two seats.
2. **OCCUPIED**: a person is assigned to the seat.
3. **UNKNOWN**: uncertain evidence on the seat; or another person's box covers at least
   `--occlusion` (50%) of it (someone standing in front, the row in front); or, with an
   `empty_reference`, the seat's colours no longer correlate >= `--reference-threshold` (0.5)
   with the empty bus (a bag, a passenger the detector missed, or a lighting change).
4. **EMPTY**: none of the above, i.e. the seat is visible and looks empty.

**Seat smoothing** is time-based, so it behaves the same at 1 or 30 FPS. A seat changes state
once the new state makes up >= `--agree` (70%) of observations spanning `--occupy-seconds` (1.0),
`--vacate-seconds` (2.0) or `--unknown-seconds` (2.0); in practice after about 0.7-1x that time.
Seats start UNKNOWN. After `--outage-seconds` (5) without fresh frames, every seat becomes
UNKNOWN, pending readings are cleared, nothing is published, and the camera keeps reconnecting.

**People count smoothing.** The count shown and published is the median of the last
`--count-seconds` (2.0) of observations (ties round up), and it changes only after that median
has differed from the shown value for `--count-hold` (1.0) s. A detection that comes and goes,
such as a moving photo of a person (measured swinging between confidence 0.16 and 0.86), no
longer toggles the count. A real change appears after about 1-2 s at 30 FPS, or on the third
observation at 1 FPS. The preview and log also show the unsmoothed `raw` count.

**What is published** (numbers only; never frames, faces or seat images):

| Field | Meaning |
| --- | --- |
| `count` | Smoothed people count, clamped to `[0, 2*capacity]` |
| `seats_free` | Seats currently **EMPTY** (camera-verified) |
| `seats_total` | Seats currently **verified** (EMPTY + OCCUPIED); UNKNOWN seats are excluded |
| bridge only: `seats_unknown`, `seats_mapped`, `camera_id`, `seat_states` | Partial coverage and multi-camera merging |

`POST /buses/{id}/count` keeps exactly `count`, `seats_free`, `seats_total` (sent together,
free <= total, omitted when no seat is verified). **Semantics change:** `seats_total` used to mean
"seats mapped"; it now means "seats verified in this observation", so blocked seats are never
reported free. The `seat_source` rule still works: `seats_total == capacity` only when every bus
seat is verified (`camera`); otherwise the backend estimates the rest (`camera_partial`).

**Capacity vs coverage.** `--capacity` (default: the map's `capacity`, else 40) is the whole bus.
Example log for a 60-seat bus where one camera maps 35 seats:
`seats empty 12 occupied 21 unknown 2 of 35 mapped, 27 of 60 unverified`.
Only the 33 verified seats are camera results; the other 27 were not visually verified, and
whole-bus availability then comes from IR via `/fusion` (`source: ir`). Without a seat map only
`count` is sent, and the preview shows a display-only `capacity - people` estimate that treats
standing people as seated.

**Preview** (`--show`):

| Drawn | Meaning |
| --- | --- |
| Blue box | Counted person |
| Thin yellow box | Uncertain person (low confidence or suspected fake), not counted |
| Magenta box | Phone, laptop or TV |
| Red / green / yellow `?` seat | Occupied / empty / unknown |
| Green / red / grey face box | Face judged real / fake / not judged (`--face-liveness` only) |

The status lines show the smoothed and raw counts, seat totals, FPS, frame age and device.

**Camera handling.** Capture runs in its own thread that keeps only the newest frame; the main
loop wakes as soon as a new frame arrives instead of sleeping a fixed period, which was the main
cause of the old lag. The model loads once and is warmed up before the first frame. A lost camera
reconnects without restarting the process (`Camera lost` / `Camera connected after reconnect`).
A missing file or bad source fails at start with a message. `--duration 20` bounds a test run.
Native camera drivers can still hang a process.

## Distance and camera settings

Defaults: `--camera-size 1280x720` and `--imgsz 960`. This webcam gives at most 1280x720 at
30 FPS (Windows MSMF with MJPG; DirectShow drops to 10 FPS at 720p; 1080p is not supported).
If a camera cannot give the requested size, a warning names the size it gave;
`--camera-size native` keeps the driver default.

Why: assuming a ~70 deg lens (not measured) and ~0.9 m of visible seated body, a passenger 10 m
away is about 82 px tall at 720p but about 41 px at 640x480. In a **simulated** test (real webcam
frames of one person shrunk onto a plain canvas, 20 frames per size), `imgsz 640` found 20/20
people at 41 px but 7/20 at 32 px; `imgsz 960` found 20/20 at 32 px; both found 0/20 at 24 px.
A crowded bus with occlusion and motion blur is harder than this test. `--imgsz 1280` costs about
4 ms more per frame on this GPU than 960 and may help very distant rows; measure on your footage.

## Photos, screens and face liveness

**A photo of a person is a person to YOLO** (a printed photo scored about 0.8 in a webcam test).
Three mechanisms limit the damage; none of them makes photos impossible.

**Screen filter (always on).** The same YOLO pass finds phones, laptops and TVs (COCO 67, 63, 62,
at confidence `min(conf, .25)`); a person box at least 70% inside one is dropped. A real person
holding a phone is kept. It fails when the device itself is not detected (in the webcam tests
the held phone was detected only now and then), for printed photos, and may drop a real person in
front of a TV. `--no-screen-filter` disables it to measure the baseline. Effect on accuracy:
**not measured**.

**Count smoothing (always on)** stops a borderline photo from making the count flicker; see above.

**Face liveness (`--face-liveness`, off by default).** Supplementary, never required:

- Faces are searched in each counted person's head region, enlarged to about 192 px, on the
  full-resolution frame (YuNet). Each face crop (2.7x the face box, 80x80) is scored real or
  fake by MiniFASNetV2.
- Checks run on a **background thread** every `--liveness-interval` (0.3 s), so the camera loop
  never waits for them; in between, the latest results are reused.
- **Only judgeable faces are judged.** Faces under 40 px, turned more than `--face-max-yaw` (0.35),
  or with pitch outside `--face-pitch` (0.45,0.75) are drawn grey "not judged", and the person
  counts from the body. Pose comes from YuNet's 5 landmarks: after undoing head roll, `pitch` is
  where the nose tip sits between the eye line (0) and the mouth line (1), and `yaw` is the nose
  offset in eye distances. Measured on one person: looking straight gave pitch 0.55-0.65, looking
  down up to 0.90.
- **Scores are voted over time.** Faces are matched between checks by box overlap (no identity);
  a face is fake only if the median of its scores over 1.5 s, with at least 2 checks, is below
  `--live-threshold` (0.5). One bad check cannot drop a real passenger.
- A person whose judged faces all look fake is not counted, and any seat it touches becomes
  UNKNOWN, never EMPTY. It stays excluded for `--spoof-memory` (3 s) while its face is briefly
  missed, unless a real face is found in that box.

```bash
python count.py --bus 14 --source 0 --show --face-liveness --capacity 4
```

**Measured limits of face liveness with this webcam** (one person, a sanity check, not validation):

- At 720p a real face was scored fake in 3% of checks at ~1 m and 0-23% at 2-4 m.
- At 720p **a printed photo was scored real** in 97-100% of checks at 1-2 m. At 640x480 the same
  photo was called fake, most likely because its ~30 px face was blurry, which would also happen
  to a real student far away. That is why faces under 40 px are no longer judged.
- A face 10 m away is about 14 px at 720p (7 px at 640x480): too small to judge at all.
- So `--face-liveness` **cannot be relied on to reject photos** here. Reliable photo/screen
  rejection needs other hardware, for example an infrared camera (phone screens look dark in
  near-IR) or a depth camera.

**Privacy:** with `--face-liveness` the process detects and classifies faces. Face crops stay in
RAM, are never saved, logged or sent, and no identity is computed; only counts leave the process.
This is still biometric-adjacent processing, so the team must agree before enabling it in a bus.

**Model files** (only for `--face-liveness`): put both in `vision/models/` (git-ignored) and check
their SHA-256:

| File | Source | License | SHA-256 |
| --- | --- | --- | --- |
| `face_detection_yunet_2023mar.onnx` (233 KB) | github.com/opencv/opencv_zoo `models/face_detection_yunet` | MIT | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `MiniFASNetV2.onnx` (1.7 MB) | github.com/yakhyo/face-anti-spoofing release `weights`, converted from minivision-ai/Silent-Face-Anti-Spoofing | Apache-2.0 | `b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907` |

## `count.py` options

None of these thresholds has been tuned on bus footage; they are engineering defaults.

| Group | Option (default) |
| --- | --- |
| Input | `--source` (0), `--camera-size` (1280x720), `--sample-fps` (30 with `--show`, else 1), `--duration` |
| Bus | `--bus` (14), `--capacity` (map, else 40), `--seatmap`, `--camera-id` (map, else main) |
| Detection | `--conf` (0.35), `--weak-conf` (0.2), `--imgsz` (960), `--device` (auto), `--weights`, `--no-screen-filter` |
| Seats | `--rule` (hip), `--iou` (0.15), `--occlusion` (0.5), `--reference-threshold` (0.5), `--no-reference` |
| Smoothing | `--occupy-seconds` (1.0), `--vacate-seconds` (2.0), `--unknown-seconds` (2.0), `--agree` (0.7), `--outage-seconds` (5), `--count-seconds` (2.0), `--count-hold` (1.0) |
| Face liveness | `--face-liveness`, `--live-threshold` (0.5), `--liveness-interval` (0.3), `--spoof-memory` (3), `--face-max-yaw` (0.35), `--face-pitch` (0.45,0.75) |
| Output | `--interval` (5 s between log lines and posts), `--backend`, `--fusion-url`, `--show` |

Run `python count.py --help` for the descriptions. The old `--window` (frames) option of
`count.py` was replaced by `--count-seconds` / `--count-hold`.

## Sensor fusion / teammate handoff

Start the local bridge (one bus, one worker):

```bash
VISION_BUS_ID=14 VISION_CAPACITY=40 python -m uvicorn service:app --host 127.0.0.1 --port 8010
```

PowerShell uses `$env:VISION_BUS_ID='14'` and `$env:VISION_CAPACITY='40'` before the command.
Interactive docs: `http://127.0.0.1:8010/docs`. The service is an in-memory local integration
bridge, not the team's production backend. Restart clears state. Do not use multiple workers:
they would have independent snapshots. Keep it on localhost or put a secured, authenticated
gateway in front of it for remote use.

Rahul/Siddhant forwards the blueprint telemetry as `POST /telemetry`:

```json
{"bus_id":"14","timestamp":1793422800.0,"gps":{"lat":30.3165,"lon":78.0322,"speed":0.0,"sats":8},"pax":{"in_count":45,"out_count":12,"net_current":33},"sos_active":false}
```

Replace the example timestamp with the current Unix time; synchronize device clocks. The
blueprint uses `B-402`, while the earlier demo uses `14`; set matching IDs on all components and
never silently alias them. GPS and passenger data are accepted; no media fields are accepted.
Unknown fields, invalid values, wrong buses, stale/future timestamps and out-of-order updates are
rejected. The camera posts to `/vision` using `--fusion-url`:

```json
{"bus_id":"14","timestamp":1793422800.0,"count":37,"seats_free":5,"seats_total":38,
 "camera_id":"front","seats_unknown":2,"seats_mapped":40,
 "seat_states":{"1":"empty","2":"occupied","3":"unknown","...":"..."}}
```

The last four fields are optional, so the earlier 3-field payload is still accepted. The bridge
checks that `seats_mapped = seats_total + seats_unknown` and that `seat_states` agree with the
counts. Siddhant polls `GET /fusion` for `seats_free`, `source`, `recalibration_required`,
`expected_empty`, `visual_empty_seats`, `visual_seats_total`, `visual_unknown_seats`,
`visual_seats_mapped`, `cameras`, `deviation` and `motion` (the new keys are additive). Null
availability means unknown, not zero or full. Readings expire after 10 seconds.

**Multiple cameras.** Run one `count.py` per camera, each with its own map (`camera_id`, seat IDs
from `--first-id`), all posting to the same bridge. The bridge keeps the latest fresh reading per
camera and merges seats **by seat ID**, so a seat seen by two cameras counts once: OCCUPIED from
any camera wins, then EMPTY, else UNKNOWN. People counts from overlapping views cannot be added,
so the largest single-camera count is used (a lower bound). Seat IDs must refer to the same
physical seat in every map; the bridge cannot detect two different IDs given to one seat.

| Condition | Decision |
| --- | --- |
| Fresh IR | Expected empty = max(0, capacity - IR net count) |
| Full camera map, absolute deviation > 3 seats, GPS speed <= 1 km/h and >= 4 satellites | Trust camera; raise recalibration flag |
| Same disagreement while moving or motion unknown | Trust IR; raise recalibration flag |
| Both agree within threshold | Use IR baseline |
| Stale/missing IR, fresh whole-bus camera | Use camera |
| Partial map or any UNKNOWN seat | Return verified camera counts, never extrapolate them or compare against whole-bus IR |
| No usable whole-bus source | Return unavailable/null |

Thresholds live in `FusionConfig`; they are explicit engineering defaults, not tuned values.
`recalibration_required` is advisory; no hardware counter is overwritten. A full seat count
cannot tell how many standing passengers exist. Rahul and Siddhant must agree on any safe reset
protocol and transport topic. Latest-only state rejects replayed old telemetry after a network
partition. MQTT subscription, persistence and production auth belong to the team's integration
and are not implemented here.

## Honest evaluation

Use representative, authorized bus footage. Keep validation and final test footage separate
(prefer different trips). Do not tune on reported test frames.

```bash
python evaluate.py sample --video test_bus.mp4 --seatmap seatmap_bus14.json --n 20 --split test --output evaluation/test
# Optional offline-only temporary images for manual labelling:
python evaluate.py sample --video test_bus.mp4 --seatmap seatmap_bus14.json --n 20 --split test --output evaluation/test_with_frames --save-frames
python evaluate.py report --csv evaluation/test/labels.csv
python evaluate.py cleanup --folder evaluation/test_with_frames
```

Fill `people_manual` and every `manual_seat_ID` (1 occupied, 0 empty) in `labels.csv`;
predictions are `1`, `0`, or `u` (UNKNOWN). Count only visible people and annotate seat usability
consistently. Do not guess labels for occluded seats: use a separate ground-truth view or report
the limitation. Each sampled frame includes up to `--window` (5) preceding 1 Hz observations for
smoothing. Both rules use exactly the same detections. Exports never overwrite an existing folder.

Reports give people exact-match %, within +/-1 %, MAE, and per rule: accuracy over decided seats,
`unknown_percent`, **`false_empty_seats`** (reported empty while occupied, the costliest error),
and free-total exact-match % over frames with no UNKNOWN seat. Missing labels fail the report by
default; `--allow-partial` gives an explicitly provisional result. CPU FPS is saved in
`metadata.json` (inference, geometry and both rules; excludes warm-up, decoding, display and
network). Sampled frames are optional, git-ignored under `vision/evaluation/`, and deleted by
cleanup; other output destinations are the operator's responsibility.

If validation results are bad, compare confidence, image size, smoothing and rule on validation
footage only. Record before/after parameters and metrics, freeze the settings, then run the
separate held-out test once. No tuning or rule superiority is claimed yet. Twenty frames are
only a small demo evaluation.

## Measure speed

```bash
python benchmark.py                      # 720p, imgsz 960, GPU if available, 90-seat synthetic grid
python benchmark.py --face-liveness      # include background face checks
python benchmark.py --device cpu --camera-size native --imgsz 640
```

It reports camera FPS, processed FPS, frames skipped as stale, and mean/p95 times for detection,
seat logic (association, states, tracker on an `--grid-seats` grid, default 18x5 = 90) and
drawing, plus frame age from capture to result. Runs vary by a few FPS (webcam exposure, other
programs), so compare several runs.

## Validation status

Real bus passenger accuracy, per-seat accuracy, false-empty rate and unknown rate: **not
measured**. Real bus FPS and Raspberry Pi 5 speed: **not measured**. No threshold has been tuned.
The 90%+ pitch claim remains an unverified target. Details of every executed check are in
[`VALIDATION.md`](VALIDATION.md).

Measured on this laptop's **webcam (not a bus)**, RTX 3050, `benchmark.py` (150 frames after
warm-up) and live `count.py --show` logs:

| | Before | After |
| --- | --- | --- |
| `count.py --show`, 640x480 | ~20 FPS, frame age 30-75 ms | 29-30 FPS, 14-40 ms |
| `count.py --show --face-liveness`, 640x480 | 16-21 FPS, 39-95 ms | 26.5-28 FPS, 19-48 ms |
| Detection + liveness at 720p (benchmark) | 20.2 FPS, p95 107 ms | 28-29 FPS, p95 32-35 ms |
| `count.py --show --face-liveness`, 720p, imgsz 960 | n/a | 27.5-29.8 FPS, 12-57 ms |
| YOLO per frame at 720p, GPU: imgsz 640 / 960 / 1280 | | 14.9 / 17.0 / 21.0 ms |
| YOLO per frame at 640x480, CPU (mean / p95) | 28.0 / 32.7 ms | 27.4 / 31.6 ms |
| Seat logic for 90 synthetic seats (mean / p95) | n/a | 1.7 / 3.1 ms |
| First observation after start | 2.5 s old (warm-up on it) | warm-up before the first frame |

Seat update latency is set by the dwell times, not processing: about 0.7-1 s to OCCUPIED and
1.4-2 s to EMPTY (scenario test G). FP16 was measured at 9.6 ms vs 8.2 ms for FP32 YOLO on this
GPU, so it was not adopted.

`python -m pytest tests -q` runs 40 tests, including synthetic scenarios A-L in
`tests/test_occupancy.py` (empty bus, faceless and partial passengers, blocked seats, enter/leave
timing, 80- and 90-seat maps, partial coverage, two-camera merging, camera reconnect, count
flicker, head pose, face voting, coordinate mapping). They use generated geometry and fake
cameras, so they test logic, not detector accuracy. `python tests/smoke_pipeline.py` runs real
YOLO on a generated video through the real bridge.

## Limits and deployment

- **One camera rarely sees 80-90 seats.** From the front, rear rows are hidden behind seat backs
  and passengers, and a ceiling wide-angle lens distorts the far rows. Map only seats you can see
  and plan 2-3 cameras for full coverage. Unmapped seats are reported as unverified, never invented.
- Hip-point association can confuse a standing passenger with the seat behind them, and a
  passenger leaning across the aisle with the wrong seat. Pose estimation (`yolov8n-pose`) could
  help, but needs an extra model and validation footage to prove it; it is not included.
- Occlusion uses rectangular person boxes, which overstate coverage; crowded rows may show many
  UNKNOWN seats. Tune `--occlusion` on validation footage.
- Empty references are colour statistics: sunlight, night lighting and seat covers change them
  and push seats to UNKNOWN (safe, but less useful). Re-record references per lighting condition
  or use `--no-reference`.
- Photos of people are counted unless the device showing them is detected; see
  [Photos, screens and face liveness](#photos-screens-and-face-liveness).
- Crowding, low light, motion blur and poor angles still break person detection.
- Target deployment: Raspberry Pi 5 with a fixed ceiling camera. Pi performance, power and
  thermals are not measured; use `--sample-fps 1` there and measure with
  `python benchmark.py --device cpu`.
