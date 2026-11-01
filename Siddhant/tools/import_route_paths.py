"""Bring the approved road paths from the campus GPS project (Route Setup, "verified") into this website.

Reads the GPS project's export (GPS/data/stop-locations.json: routes with geometry [lng, lat], first stop -> campus)
and this backend's routes (read-only), matches them by first stop name, and checks that every one of our stops lies
on the path (within --max-offset-m) before accepting it. Writes frontend/web/public/route-paths.json:

  {"routes": {"101": {"name": ..., "gps_route": ..., "path": [[lat, lng], ...]  (first pickup -> campus),
                      "max_stop_offset_m": 42}}, ...}

The map then draws that path, buses are placed and timed along it, and tools/test_drive.py drives it.
No database is changed.

Usage (from repo root):
  backend/.venv/Scripts/python tools/import_route_paths.py [--gps-export ../GPS/data/stop-locations.json]
"""
import argparse
import asyncio
import difflib
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "web" / "public" / "route-paths.json"


def norm(name):
    """'Ghanta Ghar (Clock Tower)' -> {'ghanta ghar clock tower', 'clock tower', 'ghanta ghar'}: every way a stop is named."""
    s = name.lower()
    names = {re.sub(r"[^a-z0-9]+", " ", s).strip()}
    names |= {re.sub(r"[^a-z0-9]+", " ", part).strip() for part in re.split(r"[()]", s) if part.strip()}
    return {n for n in names if n}


def same_place(a, b):
    """Stop names that refer to the same place, allowing spelling variants (Asley / Astley Hall)."""
    return any(x == y or difflib.SequenceMatcher(None, x, y).ratio() >= 0.85 for x in norm(a) for y in norm(b))


def offset_m(path, p):
    """Metres from point p (lat, lng) to the nearest point of the path (list of (lat, lng))."""
    k, m = math.cos(math.radians(p[0])) * 111320, 110570
    best = math.inf
    for a, b in zip(path, path[1:]):
        ax, ay, bx, by = (a[1] - p[1]) * k, (a[0] - p[0]) * m, (b[1] - p[1]) * k, (b[0] - p[0]) * m
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def match(our_routes, gps_routes, max_offset_m):
    """(accepted {route_id: entry}, report lines). Each approved GPS path goes to our route with the same first stop,
    and only if every one of our stops on that route is within max_offset_m of the path."""
    accepted, report = {}, []
    for g in gps_routes:
        if not g.get("geometry") or g.get("geometry_status") != "verified":
            continue
        first = g["name"].split("→")[0].strip()
        path = [(lat, lng) for lng, lat in g["geometry"]]
        ours = [r for r in our_routes if r["stop_points"] and same_place(r["stop_points"][0]["name"], first)]
        if not ours:
            report.append(f"  no route of ours starts at {first!r}: {g['name']} skipped")
            continue
        for r in ours:
            worst = max(offset_m(path, (p["lat"], p["lng"])) for p in r["stop_points"])
            if worst > max_offset_m:
                report.append(f"  {r['id']} {r['name']}: a stop is {worst:.0f} m from {g['name']}'s path - NOT used")
                continue
            accepted[str(r["id"])] = {"name": r["name"], "gps_route": g["name"], "path": [[round(a, 6), round(b, 6)] for a, b in path],
                                      "max_stop_offset_m": round(worst)}
            report.append(f"  {r['id']} {r['name']} <- {g['name']} ({len(path)} points, stops within {worst:.0f} m)")
    return accepted, report


async def our_routes():
    sys.path.insert(0, str(ROOT / "backend"))
    from dotenv import load_dotenv
    load_dotenv(ROOT / "backend" / ".env")
    import db
    await db.connect(os.environ["DATABASE_URL"])
    try:
        routes, _ = await db.load_routes()
        return list(routes.values())
    finally:
        await db.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gps-export", default=str(ROOT.parent / "GPS" / "data" / "stop-locations.json"))
    ap.add_argument("--max-offset-m", type=float, default=400)
    args = ap.parse_args()
    gps = json.loads(Path(args.gps_export).read_text(encoding="utf-8"))
    accepted, report = match(asyncio.run(our_routes()), gps["routes"], args.max_offset_m)
    OUT.write_text(json.dumps({"source": Path(args.gps_export).name, "exported_at": gps.get("exported_at"), "routes": accepted},
                              separators=(",", ":")), encoding="utf-8")
    print("\n".join(report))
    print(f"Wrote {len(accepted)} approved route paths to {OUT}")


if __name__ == "__main__":
    main()
