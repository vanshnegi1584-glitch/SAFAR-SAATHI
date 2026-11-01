"""TEST ONLY: drives full buses along their route by GPS, so a test can watch a bus leave when it fills up.

Every 2 s it reads GET /buses. For buses on --route:
  - status "boarding" (and not yet driven): parked at the campus depot, so the map shows it at GEU while it fills;
  - status "full": driven out of campus along the route (campus -> the stop nearest campus -> ... -> the first
    pickup, e.g. GEU -> ISBT -> Saharanpur Chowk -> Darshan Lal Chowk -> Ghanta Ghar), pausing at every stop;
  - status "departed" (on its trip when the driver starts, e.g. after a restart): carried on from where it is.
Positions go to POST /feeds/gps/{bus} with GPS_FEED_KEY (backend/.env), so the geofence starts the trip as the bus
leaves the depot and marks each stop, exactly as with a real phone. A driven bus is left at the last stop.

Usage (from repo root):
  backend/.venv/Scripts/python tools/test_drive.py --route 101 [--speed-kmh 60] [--dwell-s 8] [--backend http://127.0.0.1:8000]
"""
import argparse
import asyncio
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
load_dotenv(BACKEND_DIR / ".env")
OSRM = "https://router.project-osrm.org/route/v1/driving/"


def metres(a, b):
    """Metres between two (lat, lng) points (equirectangular; fine at city scale)."""
    k = math.cos(math.radians((a[0] + b[0]) / 2)) * 111320
    return math.hypot((b[1] - a[1]) * k, (b[0] - a[0]) * 110570)


def _along(line, p):
    """Metres along a polyline [(lat, lng)] to the point nearest p."""
    k, m = math.cos(math.radians(p[0])) * 111320, 110570
    best, done = (math.inf, 0.0), 0.0
    for a, b in zip(line, line[1:]):
        ax, ay, bx, by = (a[1] - p[1]) * k, (a[0] - p[0]) * m, (b[1] - p[1]) * k, (b[0] - p[0]) * m
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
        off = math.hypot(ax + t * dx, ay + t * dy)
        if off < best[0]:
            best = (off, done + t * metres(a, b))
        done += metres(a, b)
    return best[1]


def drive_points(campus, stop_points, speed_mps, step_s, dwell_s, road_path=None):
    """The fixes for one outbound run, one per `step_s`, holding `dwell_s` at every stop: campus first, then the
    route's stops from the one nearest campus to the far end (stop_points are stored far end first).
    With `road_path` (the approved road path, [(lat, lng)] first pickup -> campus) the bus follows that road and
    waits where each stop meets it; without it, straight lines from stop to stop."""
    step_m = speed_mps * step_s
    hold = max(1, round(dwell_s / step_s))
    out = [campus, campus]  # two fixes inside the depot: the geofence needs consecutive fixes
    if road_path and len(road_path) >= 2:
        line = [tuple(p) for p in reversed(road_path)]          # campus -> far end, along the road
        if metres(campus, line[0]) > 1:
            line.insert(0, campus)
        cum = [0.0]
        for a, b in zip(line, line[1:]):
            cum.append(cum[-1] + metres(a, b))
        stops_at = sorted(_along(line, (p["lat"], p["lng"])) for p in stop_points)
        def point(d):  # position d metres along the road
            i = next((j for j in range(1, len(cum)) if cum[j] >= d), len(cum) - 1)
            seg = cum[i] - cum[i - 1] or 1
            t = (d - cum[i - 1]) / seg
            a, b = line[i - 1], line[i]
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        d, s = 0.0, 0
        while d < cum[-1]:
            target = min(d + step_m, cum[-1])
            if s < len(stops_at) and stops_at[s] <= target:  # reach the stop exactly, then wait there
                out += [point(stops_at[s])] * (1 + hold)
                d, s = stops_at[s], s + 1
                continue
            d = target
            out.append(point(d))
        return out
    path = [campus] + [(p["lat"], p["lng"]) for p in reversed(stop_points)]
    for a, b in zip(path, path[1:]):
        n = max(1, math.ceil(metres(a, b) / step_m))
        out += [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(1, n + 1)]
        out += [b] * hold  # waiting at the stop
    return out


def resume_points(points, at):
    """The rest of a run for a bus already on its trip at `at` (e.g. after the driver was restarted): from the fix
    nearest to where it is now. Skips the two depot fixes so a bus out on the road is never sent back to campus."""
    rest = points[2:]
    i = min(range(len(rest)), key=lambda j: metres(rest[j], at))
    return rest[i:]


def road_path_for(route_id):
    """The approved road path for a route from the website's route-paths.json (tools/import_route_paths.py), if any."""
    f = Path(__file__).resolve().parents[1] / "frontend" / "web" / "public" / "route-paths.json"
    try:
        entry = json.loads(f.read_text(encoding="utf-8"))["routes"].get(str(route_id))
    except (OSError, ValueError, KeyError):
        return None
    return [tuple(p) for p in entry["path"]] if entry else None


def map_campus():
    """The campus point the website draws routes from (frontend/web/src/geo.js), so the road asked for here is the map's."""
    m = re.search(r"CAMPUS\s*=\s*\[([\d.]+),\s*([\d.]+)\]", (ROOT / "frontend" / "web" / "src" / "geo.js").read_text(encoding="utf-8"))
    return (float(m[1]), float(m[2]))


def osrm_road(http, stops, campus):
    """For a route without an approved path: the road line the website draws for it (OSRM from campus through the stops,
    the same request as frontend/web/src/routing.js), as [(lat, lng)] first pickup -> campus; None if OSRM fails."""
    pts = [campus] + [(p["lat"], p["lng"]) for p in reversed(stops)]
    url = OSRM + ";".join(f"{lng},{lat}" for lat, lng in pts) + "?overview=full&geometries=geojson"
    try:
        line = http.get(url, timeout=15).raise_for_status().json()["routes"][0]["geometry"]["coordinates"]
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError):
        return None
    return [(lat, lng) for lng, lat in reversed(line)] if len(line) >= 2 else None


async def depot_position():
    sys.path.insert(0, str(BACKEND_DIR))
    import db  # the backend's own read of the depot the geofence uses
    await db.connect(os.environ["DATABASE_URL"])
    try:
        d = await db.load_depot()
        return (d["lat"], d["lng"]), d["name"]
    finally:
        await db.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--backend", default=os.environ.get("SAFAR_API", "http://127.0.0.1:8000"))
    ap.add_argument("--route", type=int, required=True, help="Only buses on this route (e.g. 101)")
    ap.add_argument("--speed-kmh", type=float, default=60, help="Test speed (faster than real traffic on purpose)")
    ap.add_argument("--dwell-s", type=float, default=8, help="Seconds held at each stop")
    ap.add_argument("--step-s", type=float, default=2)
    args = ap.parse_args()
    key = os.environ.get("GPS_FEED_KEY")
    if not key:
        raise SystemExit("Need GPS_FEED_KEY in backend/.env")
    campus, name = asyncio.run(depot_position())
    print(f"Test driver: route {args.route}, campus = {name} {campus}, {args.speed_kmh:g} km/h, {args.dwell_s:g} s per stop",
          flush=True)

    driving: dict[int, list] = {}   # bus id -> fixes still to send
    done: set[int] = set()          # buses already driven to the end (left there)
    with httpx.Client(timeout=5) as http:
        routes = {r["id"]: r for r in http.get(f"{args.backend}/routes").raise_for_status().json()}
        stops = routes[args.route]["stop_points"]
        road, how = road_path_for(args.route), "the approved road path"
        if not road:
            road, how = osrm_road(http, stops, map_campus()), "the road line drawn on the map (OSRM)"
        print("Route:", " -> ".join(["campus"] + [p["name"] for p in reversed(stops)]),
              f"(along {how}, {len(road)} points)" if road else "(no road line: straight between stops)", flush=True)

        def send(bus_id, at):
            r = http.post(f"{args.backend}/feeds/gps/{bus_id}", json={"lat": at[0], "lng": at[1], "accuracy_m": 8},
                          headers={"X-Feed-Key": key})
            if r.status_code != 200 or not r.json().get("accepted"):
                print(f"  bus {bus_id}: not accepted ({r.status_code} {r.text[:120]})", flush=True)

        tick = 0
        while True:
            started = time.monotonic()
            try:
                for b in http.get(f"{args.backend}/buses").raise_for_status().json():
                    bid = b["id"]
                    if b["route_id"] != args.route or bid in done:
                        continue
                    if bid in driving:
                        send(bid, driving[bid].pop(0))
                        if not driving[bid]:
                            del driving[bid]
                            done.add(bid)
                            print(f"*** Bus {bid} reached {stops[0]['name']} (end of the route)", flush=True)
                    elif b["status"] == "full":
                        driving[bid] = drive_points(campus, stops, args.speed_kmh / 3.6, args.step_s, args.dwell_s, road)
                        print(f"*** Bus {bid} is FULL ({b.get('occupancy')}/{b.get('capacity')}): driving it to "
                              f"{stops[0]['name']} ({len(driving[bid]) * args.step_s:.0f} s)", flush=True)
                        send(bid, driving[bid].pop(0))
                    elif b["status"] == "departed" and b.get("location"):  # on its trip already: carry on from there
                        at = (b["location"]["lat"], b["location"]["lng"])
                        driving[bid] = resume_points(drive_points(campus, stops, args.speed_kmh / 3.6, args.step_s,
                                                                  args.dwell_s, road), at)
                        print(f"*** Bus {bid} is already on its trip: carrying on to {stops[0]['name']} "
                              f"({len(driving[bid]) * args.step_s:.0f} s)", flush=True)
                        send(bid, driving[bid].pop(0))
                    elif b["status"] == "boarding" and tick % 3 == 0:
                        send(bid, campus)  # parked at GEU while students board
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                print(time.strftime("%H:%M:%S"), "error:", exc, flush=True)
            tick += 1
            time.sleep(max(0.0, args.step_s - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
