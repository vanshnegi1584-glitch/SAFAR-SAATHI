# SAFAR-SAATHI

AI smart campus bus system for Graphic Era Hill University, SAARTHI'26.
The newer team architecture calls the system **TransitLink**; this repository retains
the team's SafarSaathi name. The repository was empty when this module was started.

## Team responsibilities

| Owner | Responsibility | Proposed stack from the new blueprint |
| --- | --- | --- |
| Rahul | Directional IR counters, GPS, edge telemetry | ESP32, FreeRTOS, MQTT |
| Vansh | Passenger detection, visible seat occupancy, IR/CV fusion | Python 3.13, OpenCV, YOLOv8n, PyTorch, FastAPI bridge |
| Siddhant | Backend, database, queueing, allocation, fallback routes | Node.js, Express, Socket.io, Supabase/PostGIS, Redis |
| Vidhu | Student app and dispatcher UI | Next.js, Expo, Zustand, React Query |

Only Vansh's `vision/` module is implemented here. The backend, hardware firmware,
database, and frontend remain the other teammates' work. DeepSORT appears in the
blueprint's stack, but is not needed for fixed seat polygons; it has not been added
without evidence that tracking improves this task.

## Data flow

1. Rahul's device publishes GPS speed and directional IR passenger counts every 2 seconds.
2. The in-bus camera detects people and evaluates calibrated seat polygons at 1 FPS.
3. A local fusion service compares IR-derived availability with whole-bus camera availability.
4. On significant disagreement it trusts CV while stationary and IR while moving.
5. Siddhant consumes numeric results for availability, student allocation, and alerts.

The vision process retains frames only in RAM and sends numeric observations, never
frames or faces. Seat maps contain coordinates only. Offline evaluation can explicitly
export temporary labelling frames; that exception must not be enabled in deployment.
This engineering behavior does not itself certify legal compliance.

## Run Vansh's module

From `vision/` in PowerShell, after the setup in [vision/README.md](vision/README.md):

```bash
.\.venv\Scripts\python.exe count.py --bus 14 --source 0 --show
```

```bash
.\.venv\Scripts\python.exe calibrate.py --bus 14 --source 0 --capacity 4 --reference
```

The first counts people from the webcam with a preview window (Q to stop); the second marks seats
on a frame of empty seats so `count.py --seatmap seatmap_bus14.json` can report OCCUPIED, EMPTY and
UNKNOWN seats. See [vision/README.md](vision/README.md) for installation, calibrating 80-90-seat
buses, camera and distance settings, face liveness and its limits, fusion integration,
evaluation, the fleet file built from the transport schedule (seats per bus, no driver
details), training on your own bus photos, and measured validation status.

## Integration contracts

The new blueprint specifies an MQTT telemetry payload but **does not specify** an MQTT
broker/topic, authentication, CV HTTP endpoint, or IR reset command. Therefore this
module provides a documented local HTTP bridge. Rahul or Siddhant forwards decoded
telemetry to it; this repository does not invent a production MQTT integration.
Use one bridge instance per bus with matching bus ID and capacity.

The earlier requested API is supported as an optional compatibility output:

`POST /buses/{id}/count`

```json
{"count": 37}
```

or, with calibrated seats:

```json
{"count": 37, "seats_free": 5, "seats_total": 40}
```

Both seat fields must be sent together; free must not exceed total. `seats_total` counts
seats the camera **verified** in that observation (EMPTY or OCCUPIED); seats that are blocked
or uncertain (UNKNOWN) are left out, so they are never reported free. No fusion metadata
is appended to this API. Its actual backend is **not present or verified in this repo**.

Expected earlier `GET /buses/{id}` seat-source semantics:

| `seat_source` | Meaning |
| --- | --- |
| `camera` | Every configured seat is camera-verified (`seats_total == capacity`) |
| `camera_partial` | Only some seats verified (unmapped or UNKNOWN); backend estimates the remainder |
| `people_count` | No seat map supplied |

The local `/fusion` response has its own `source` field (`camera`, `ir`, `unavailable`);
it is not the earlier backend's `seat_source`. A seated-occupancy camera does not
measure standing passengers accurately enough to reset an IR passenger counter.

## Team demo acceptance script

1. Configure Bus 14 with capacity 40 in Siddhant's backend and a suitable Bus 15 alternative.
2. Calibrate the seats actually visible. A whole-bus `camera` claim requires 40 genuine,
   distinct visible seats; do not duplicate polygons to reach 40.
3. Start the fusion bridge and camera, then forward fresh IR/GPS telemetry.
4. Check numeric counts and source using `/fusion`, and if supported, `GET /buses/14`.
5. Occupy all mapped seats; wait at least the seat dwell time (about 2 seconds by default).
6. With full coverage, verify zero free seats and `seat_source: camera` in the team backend.
7. Register/allocate another student through the team's app; verify
   **"Bus 14 full, take Bus 15"**. Allocation and that message are backend/UI responsibilities.
8. Disconnect/reconnect the backend and camera and verify recovery without restarting CV.

Steps involving a real bus, hardware, backend, or student app are pending team integration.
The pitch's "90%+ match" is a target, not a demonstrated result.
