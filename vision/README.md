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

## Bus fleet (seats per bus from the transport schedule)

`fleet.json` lists every bus's number, registration, route, shift and **seats** (capacity),
built from the transport department's schedule CSV:

```bash
python fleet.py build --schedule ../SafarSaathi_Bus_Schedule.csv
python fleet.py show --bus 14
```

The schedule has 97 buses on 30 routes with 40-60 seats each (4,786 in total). It also contains
drivers' names and phone numbers: `fleet.py` **does not copy them**, and the schedule CSV is
git-ignored so it is never pushed. Re-run `build` whenever the schedule changes.

With `fleet.json` present, capacity no longer has to be typed:

- `count.py` uses `--capacity` if given; otherwise the seat map's capacity and the fleet's seats for
  `--bus` must agree (a map calibrated for a 45-seat bus is refused on a 41-seat bus); otherwise
  the fleet value; otherwise 40. The log says which source was used.
- `calibrate.py` stores the fleet's seats for `--bus` in the map unless `--capacity` is given.
- The bridge (`service.py`) uses `VISION_CAPACITY` if set, else the fleet's seats for `VISION_BUS_ID`.
  Before this, a 60-seat bus on the default 40 would have had its camera readings rejected.
- `--fleet none` ignores the file.

The schedule's seat numbers are capacities, not training data: they contain no images, so they
cannot teach a detector what a seat looks like. Training is covered in
[Train on your own bus photos](#train-on-your-own-bus-photos).

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

**One person, one box, one ID.** Two steps keep a single body from counting twice:

- *Duplicate boxes:* a box at least 85% inside a person box twice its size or larger (for example an
  arm or upper body when someone raises a hand) is dropped; `duplicates removed` in the log counts
  them. Kept strict so a person partly hidden behind another, whose box sticks out of the front
  person's box, still counts. `--no-dedupe` turns it off.
- *Anonymous tracking IDs:* each box is matched to the previous frame's boxes by overlap and keeps its
  ID (P1, P2, ...), shown in the preview; a new person gets a new ID and IDs are never reused. A box
  counts only after `--track-confirm` (3) sightings, so a false box that appears for a frame or two
  is ignored, while a real person the detector catches every other frame still counts. An ID survives
  `--track-forget` (1.0 s) out of view; after that, a returning person gets a new ID.
- *Overlapping people:* YOLO keeps two boxes unless they overlap (IoU) at least 0.7, so a close-up
  body sometimes got two boxes overlapping 60-70%; `--nms-iou` (0.6) merges those. A box around two
  or more whole-height people standing side by side (a "group" box) is dropped and their own boxes
  kept, so two touching people no longer count as three.
- *Smaller boxes:* tracking and the preview use boxes cut by `--box-shrink` (8%) of the width on each
  side and 3% of the height top and bottom, since YOLO's boxes include spread arms and margin and
  neighbours' boxes overlapped when the people did not. Seat logic keeps the full boxes. `0` turns it off.

- *A hand near the camera (head check):* a hand or arm held close to the lens can be boxed as a
  second person standing beside its owner, with the two boxes only touching, which no overlap
  rule can tell apart from two people. Each head (nose/eyes/ears, or shoulders when someone turns
  their back, from the YOLOv8n pose model) belongs to exactly one box; a box at least 30% of the
  frame tall with no head of its own, touching a box that has one, is dropped. The pose model runs
  only on frames where a big box touches another (about 10 ms each on the RTX 3050), so ordinary
  frames cost nothing, and small far-away people are never judged. Needs `yolov8n-pose.pt` in this
  folder (download once: `python -c "from ultralytics import YOLO; YOLO('yolov8n-pose.pt')"`);
  without it the counter warns and runs without the check. `--no-head-check` turns it off.
  Measured on a 55 s webcam recording (numbers only, replayed): hand held up beside the face, 1
  person: frames with 2+ boxes **107 of 279 before, 0 after**; waving near the camera: 79 of 241
  before, 5 after; two real people side by side: one extra frame (of 244) lost a person; back
  turned: both people kept.
- *Collisions:* when two people bump or cross, the detector may briefly show one merged box or lose
  the person behind. A counted person who is lost then takes back the nearest leftover box of similar
  height within one box width of where they were, so they keep their ID instead of getting a new one.

Collision check (45 s recording, exactly 2 people crossing, overlapping and bumping, replayed
offline): the shown count was **never** 3 (0% of frames, before and after), distinct IDs fell from
6 to 5, and the count read 1 in 8% of frames, when one person was completely hidden behind the other.
Tried and **rejected** on the same recordings: still counting a person for 0.5-1 s after they vanish
behind someone (fixed the drop to 1, but added a false +1 in 10-51% of frames), motion prediction
(IDs got worse, 6 to 12) and a longer wait for boxes that appear overlapping someone (more drops to 1).
A camera mounted high, looking down the aisle, hides fewer people behind others than a webcam at
head height.

Overlap check on a 38 s webcam recording (box numbers only, replayed offline): with 4 people walking
past each other the count was exactly 4 in 100% of frames (99% before). In the "one half behind
another" part, people were also entering and leaving, so the true count per frame is uncertain and
that part is **not scored**. One short recording, not a benchmark.

These IDs come from body-box positions only. No face, appearance or identity is stored, so the
system cannot and does not recognise who someone is or whether they were seen before. People who
cross paths closely can swap IDs; the count is unaffected. Matching also accepts a box that mostly
contains the previous one, because IoU alone dropped when an arm went up and the person got a new ID.
Live webcam check with 3-5 people moving and raising hands: before that change IDs ran from P21 to
P38 in about 25 s; after it, P1-P4 stayed the same for the next 18 s (one person left, P3 ended).
Two short runs, not a benchmark. A measured hand-raise test on the webcam
did not reproduce overlapping duplicate boxes (the extra box was a separate object in view), so the
duplicate rule's effect on real footage is **not measured** yet.

**People count smoothing.** The count shown and published is the median of the last
`--count-seconds` (2.0) of observations (ties round up), and it changes only after that median
has differed from the shown value for `--count-hold` (1.0) s. A detection that comes and goes,
such as a moving photo of a person (measured swinging between confidence 0.16 and 0.86), no
longer toggles the count. A real change appears after about 1-2 s at 30 FPS, or on the third
observation at 1 FPS. The preview and log also show the unsmoothed `raw` count.

**Fast vs steady (`--responsive`).** The boxes in the preview are drawn on every frame without
delay; only the *numbers* are smoothed. Simulated at 30 FPS (a real change, and a borderline
detection that comes and goes):

| Setting | Count reacts after | Flicker per 10 s (worst case: detection in ~40% of frames) | Seats change after |
| --- | --- | --- | --- |
| Default (steady) | 1.97 s | 0 | 1.0 s occupied / 2.0 s empty |
| `--responsive` | 1.00 s | up to 2 | 0.7 s occupied / 1.5 s empty |

Use `--responsive` for live viewing and demos; keep the default for what is sent to the backend.
Any `--count-seconds`, `--count-hold`, `--occupy-seconds` or `--vacate-seconds` you pass still wins.

**Frame rate and delay.** This webcam sends at most 30 FPS, so no setting can show more; the
pipeline already processes ~29 of them. Measured frame age (arrival to result) is about 15-70 ms;
the camera's own internal delay before a frame arrives is not measurable here. For better
detection of small or distant people at the same frame rate, `--imgsz 1280` measured 28.7 FPS and
21-28 ms frame age on this laptop's GPU (while a training run was also using it). Low light makes
webcams lower their own frame rate, so good lighting also keeps the FPS up.

```bash
python count.py --bus 14 --source 0 --show --responsive --imgsz 1280
```

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

**Capacity vs coverage.** `--capacity` (default: the map's `capacity`, else the fleet's seats for `--bus`, else 40) is the whole bus.
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
| Bus | `--bus` (14), `--capacity` (map, else fleet seats for the bus, else 40), `--fleet` (fleet.json), `--seatmap`, `--camera-id` (map, else main) |
| Detection | `--conf` (0.35), `--weak-conf` (0.2), `--imgsz` (960), `--device` (auto), `--weights`, `--no-screen-filter` |
| Seats | `--rule` (hip), `--iou` (0.15), `--occlusion` (0.5), `--reference-threshold` (0.5), `--no-reference` |
| Smoothing | `--responsive`, `--occupy-seconds` (1.0; 0.7 responsive), `--vacate-seconds` (2.0; 1.5), `--unknown-seconds` (2.0), `--agree` (0.7), `--outage-seconds` (5), `--count-seconds` (2.0; 1.0), `--count-hold` (1.0; 0.5) |
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
Without `VISION_CAPACITY`, the bridge takes the bus's seats from `fleet.json` (42 for bus 14).
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

**People on board.** `/fusion` also returns `people_on_board`, `people_source` and `camera_people`.
`people_source` is `ir` when Rahul's door counters are fresh (they see every boarding, whole bus),
else `camera` (only the people in view, so a lower bound), else `unavailable`. These are anonymous
counts: no face or identity is ever sent or tracked.

**Live GPS app (Vidhu's `GPS` repo).** Its tracking server already polls each bus's `/fusion` and
relays seats, and on its `feat/people-on-board` branch also the people count, to the same rooms as
that bus's live location, so the student app and dispatcher map show "N people on board" next to
the bus. Configure it with the bus's tracking id and this bridge's address, and start the bridge
with that bus's **fleet number** (its seats then come from `fleet.json` and must match the schedule):

```bash
# vision PC, bus 18 (registration UK07PA1696, 41 seats)
VISION_BUS_ID=18 python -m uvicorn service:app --host 0.0.0.0 --port 8010
python count.py --bus 18 --source 0 --fusion-url http://127.0.0.1:8010
# GPS tracking server .env
SEAT_SOURCES={"bus-uk07pa1696":"http://<vision PC address>:8010"}
```

Checked end to end on this laptop (webcam -> `count.py` -> bridge -> the GPS server's real
`SeatPoller` over HTTP): the event carried `people_on_board` with `people_source: camera`. The full
GPS server and app were **not** run: they need the database repo ("Bus Management System") with
its Supabase migrations, which is not on this machine.

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

## Train on your own bus photos

The stock yolov8n was trained on everyday photos, not bus interiors seen from a ceiling camera,
and it has no bus-seat class. Fine-tuning on labelled frames from your buses can improve person
detection there and add a `seat` class for automatic calibration proposals. **This needs real
labelled images; the pipeline is ready, the data is not.** It has been run end to end only on a
synthetic dataset (coloured shapes), which proves the steps work, not that a model is good.

```bash
# 1. Sample frames from recorded trips (one video per trip; faces are blurred by default)
python train.py extract --video recordings/bus14_morning.mp4 --every 2
python train.py extract --video recordings/bus14_evening.mp4 --every 2
# 2. Label datasets/unlabelled/ in any tool that exports YOLO .txt files (e.g. Label Studio, CVAT)
# 3. Split by trip, check, train, evaluate
python train.py split --images datasets/unlabelled --labels datasets/labels
python train.py check
python train.py train --epochs 100
python train.py evaluate --weights runs/bus/weights/best.pt --baseline yolov8n.pt --split val
# 4. Use it
python count.py --weights runs/bus/weights/best.pt --show
```

**What to record.** Video from the camera position you will deploy, on several different trips:
morning and evening light, empty, half-full and crowded, people seated, standing and leaning,
backs of heads, masks, bags on seats. Several hundred labelled frames over 10 or more trips is a
reasonable first target; more variety matters more than more frames of the same trip. Record only
with permission, keep everything in the git-ignored `vision/datasets/`, and do not share it.

**How to label** (classes in this order: `0 person`, `1 seat`):

- `person`: a box around the **visible** part of every person, including partial bodies, people
  facing away and standing passengers. Skip people who are less than about a quarter visible.
- `seat`: a box around each **individual** seat (never a whole row), when at least about a third of
  it is visible, occupied or not.
- Be consistent: the model learns your labelling rules, including their mistakes.

**What each step guards against:**

| Step | Check |
| --- | --- |
| `extract` | Faces pixelated (needs the YuNet model file; `--no-blur-faces` only for consented footage); frames named `<trip>__f<frame>` |
| `split` | Whole trips go to one split, because frames of one trip are near-duplicates and would leak test data into training; needs at least 3 trips; never overwrites a dataset |
| `check` | Malformed lines, class ids out of range, coordinates outside 0-1, images without labels, identical images in two splits, a class with no training boxes |
| `train` | Runs `check` first; fixed seed; stops after `--patience` (20) epochs without validation improvement; saves under the git-ignored `vision/runs/` |
| `evaluate` | Precision, recall and F1 per class at IoU 0.5, and people-count error per image, for your model **and** the stock model on the same images |

Choose settings on the `val` split; run `--split test` once at the end and report that number.
The first training run downloads a small font (Arial.ttf) used by Ultralytics, so it needs internet.
On this laptop's RTX 3050 (6 GB), `--imgsz 960 --batch 8` is the starting point; lower `--batch` if
memory runs out. `count.py` finds classes **by name**, so a model with `person` and `seat` works
directly; it has no phone class, so the screen filter turns itself off with such a model.

### Start with public bus-seat datasets

Checked on Roboflow Universe on 31 October 2026 (numbers and licences as shown on each page):

| Dataset | Images | Classes | Licence | Notes |
| --- | --- | --- | --- | --- |
| [Inside Bus View](https://universe.roboflow.com/seat-occupancy/inside-bus-view) (v5) | 1,378 | Occupied, Unoccupied | Public Domain | Inside a bus; no published description of where or how it was recorded |
| [VISTA](https://universe.roboflow.com/bahadej-1ew2i/vista-model) | 452 | Occupied, Unoccupied | CC BY 4.0, but its description says research use only, no redistribution or commercial use | Wide-angle CCTV inside a Philippine bus, various lighting; includes some images from other public datasets |
| [bus-seat-detection](https://universe.roboflow.com/kdglab/bus-seat-detection) | 152 (366 in the export with augmentation) | empty-seat-frontal | CC BY 4.0 | **Not used** (inspected): 191 of 366 images contain people while only empty seats are labelled; some boxes cover two seats at once, a seat with a backpack is labelled empty, and some boxes are not on seats. Training on it would teach the model that occupied seats are background. Usable only after re-labelling to the rules above |

These label **seats as occupied or empty**, not people, so they train a separate **seat-state
model** with classes `occupied_seat, empty_seat`, not the `person, seat` model above.

**Download (you, signed in):** Roboflow requires an account to download. Open each dataset, go to
*Dataset* -> latest version -> *Download Dataset*, choose the **YOLOv8** format, download the zip,
and save it in `vision/datasets/downloads/` (git-ignored). Then:

```bash
python train.py import --source datasets/downloads/inside-bus-view.zip --name insidebus --map Occupied=occupied_seat,Unoccupied=empty_seat
python train.py import --source datasets/downloads/vista.zip --name vista --map Occupied=occupied_seat,Unoccupied=empty_seat
python train.py resplit --data datasets/seats/data.yaml --output datasets/seats_grouped
python train.py check --data datasets/seats_grouped/data.yaml
python train.py train --data datasets/seats_grouped/data.yaml --name seats --epochs 100
python train.py evaluate --weights runs/seats/weights/best.pt --data datasets/seats_grouped/data.yaml --split val
```

**Why `resplit`: the downloaded splits leak.** Measured with a 256-bit image hash (two unrelated
images differ in ~118 bits): 81% of Inside Bus View's own val and test images are within 20 bits of
a training image, i.e. neighbouring frames of the same videos. VISTA's were 7-18%, and 318 of its 452
original photos also appear as 2 extra flipped/cropped copies, which a hash cannot match.
`resplit` groups images that are within 20 bits of each other (same source), plus all copies of one
original photo (by Roboflow's `<original>_jpg.rf.<id>` names), and puts each whole group in one
split. On these two datasets it gave 1,724 / 370 / 372 images, 0% near-duplicates across splits and
no original photo in two splits. Frames from one video that differ by more than 20 bits can still
land in different splits, so treat scores as an upper bound for a *new* bus.

Polygon rows in an export (81 in Inside Bus View, from seats outlined instead of boxed) are
converted to their bounding boxes on import. Images: Inside Bus View 2560x1440, VISTA 640x360.

**Results of the first seat model** (yolov8n fine-tuned at imgsz 960 on Inside Bus View + VISTA
after `resplit`; best checkpoint at epoch 75; the run was cut off at epoch 76, see below). Measured
at confidence 0.35 and IoU 0.5 with `train.py evaluate`/`confusion`; the test split was run once,
after validation, with no settings changed:

| Split, source | Occupied P / R | Empty P / R | "Empty" boxes on an occupied seat | Seats with no box |
| --- | --- | --- | --- | --- |
| val, Inside Bus View (195 img) | 0.917 / 0.914 | 0.863 / 0.820 | 0 of 2,111 | 443 occ, 399 empty |
| val, VISTA (175 img) | 0.896 / 0.907 | 0.959 / 0.970 | 9 of 1,467 (0.61%) | 143 occ, 42 empty |
| **test, Inside Bus View (219 img)** | 0.900 / 0.905 | 0.896 / 0.879 | **3 of 3,311 (0.09%)** | 459 occ, 407 empty |
| **test, VISTA (153 img)** | 0.872 / 0.904 | 0.962 / 0.982 | **8 of 1,403 (0.57%)** | 123 occ, 23 empty |

Ultralytics mAP@50 / mAP@50-95: val 0.931 / 0.578, test 0.920 / 0.550. Reading it for this
project: calling an occupied seat empty (the costly error) was rare; the common errors are missed
seats (about 9% of occupied and 12-18% of empty seats on Inside Bus View get no box) and "empty"
boxes on places with no labelled seat (255 val / 326 test on Inside Bus View, cause not inspected).
These are scores on **these two buses' footage**, split by visual similarity; they are not a score
for GEHU buses.

```bash
python train.py confusion --weights runs/seats/weights/best.pt --split test
```

**Long runs and laptop sleep.** Windows Modern Standby stopped one training run (last checkpoint
17:27, standby 17:29) and an evaluation (started 19:03, standby 19:05). Keep the laptop plugged in
and the lid open, set "When plugged in, put my device to sleep after" to *Never* while training,
and resume an interrupted run with `python train.py train --resume runs/seats/weights/last.pt`.
An earlier stop at epoch 51 (exit code 1, no message, no standby event) remains unexplained.

`import` unzips each archive into its own folder (refusing paths that would escape it), maps class
**names** (every source class must be mapped, or explicitly `=drop`), prefixes files with `--name`,
and merges into `datasets/seats/`. Use the zip file names you actually saved.

**What this can and cannot tell you:**

- These exports come pre-split and carry no trip information, so frames from one video may be in
  both train and test; their scores can be **optimistic**. The leakage check only catches exact
  duplicates.
- They show other buses, seats and camera positions. A model that scores well on them can still
  fail on GEHU buses, so the only score that counts is one on **your own labelled bus frames**,
  which this data does not replace. Use it to get started, then add your own trips.
- A seat-state model has no `person` class, so `count.py --weights` refuses it (person counting
  stays on yolov8n). Using its occupied/empty boxes as extra evidence for calibrated seats, for
  example passengers hidden behind seat backs, is a possible next step and is **not implemented**.
- Keep VISTA's research-only condition: use it for this academic project, do not redistribute it,
  and do not commit downloaded data (`vision/datasets/` is git-ignored).

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

`python -m pytest tests -q` runs 51 tests, including synthetic scenarios A-L in
`tests/test_occupancy.py` (empty bus, faceless and partial passengers, blocked seats, enter/leave
timing, 80- and 90-seat maps, partial coverage, two-camera merging, camera reconnect, count
flicker, head pose, face voting, coordinate mapping), plus the fleet file and the training
pipeline's split, label and leakage checks. They use generated geometry and fake
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
