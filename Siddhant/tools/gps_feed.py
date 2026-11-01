"""Forward live bus positions from the campus GPS tracking server (Vidhu's driver-app GPS) into this backend.

Every 2 s it reads the tracking server's snapshot and posts each bus's NEW position to
POST /feeds/gps/{bus_number} with X-Feed-Key (GPS_FEED_KEY from backend/.env). Buses are matched by their
allotted number (tracking server "18" == this backend's bus 18). Location only: no passenger counts are
sent on that route, so it cannot disturb the door counter or the camera.

Optionally (--counts-from ir) it also forwards people-on-board readings from the tracking server to
POST /buses/{n}/count for buses whose count comes from that source; leave it off for buses whose camera
already posts to this backend directly (vision/count.py --backend), or the bus would get two counts.

Usage (from repo root):
  backend/.venv/Scripts/python tools/gps_feed.py --tracking http://localhost:4000 --tracking-token <token>
      [--backend http://localhost:8000] [--counts-from ir]
"""
import argparse
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / "backend" / ".env")


HEARTBEAT_S = 15  # re-send an unchanged count this often, so the backend keeps it fresh (each post is a DB write)


def forward_once(http: httpx.Client, tracking: str, token: str, backend: str, key: str,
                 counts_from: list[str], state: dict, now: float | None = None) -> list[str]:
    """One round: read the tracking server's snapshot, post each bus's new position (and, for buses counted by
    `counts_from`, its changed people count). `state` remembers what was sent; returns one short line per post."""
    now = time.monotonic() if now is None else now
    sent_fix, sent_count = state.setdefault("fix", {}), state.setdefault("count", {})
    snap = http.get(f"{tracking}/api/tracking/snapshot", headers={"Authorization": f"Bearer {token}"}).raise_for_status().json()
    number = {b["id"]: b["fleet_number"] for b in snap["buses"]}
    lines = []
    for e in snap["latest"]:
        n = number.get(e["bus_id"])
        if not n or not str(n).isdigit() or sent_fix.get(e["bus_id"]) == e["measured_at"]:
            continue
        lng, lat = e["location"]
        body = {"lat": lat, "lng": lng, "accuracy_m": e.get("accuracy_m")}
        if e.get("speed_mps") is not None:
            body["speed_kmh"] = min(150, round(e["speed_mps"] * 3.6, 1))
        r = http.post(f"{backend}/feeds/gps/{n}", json=body, headers={"X-Feed-Key": key})
        sent_fix[e["bus_id"]] = e["measured_at"]
        reply = r.json() if "json" in r.headers.get("content-type", "") else {}
        result = "ok" if r.status_code == 200 and reply.get("accepted") else reply.get("reason") or reply.get("detail") or r.status_code
        lines.append(f"{n}:{result}")
    for s in snap.get("seats") or []:
        n = number.get(s["bus_id"])
        if not n or not str(n).isdigit() or s.get("people_source") not in counts_from or s.get("people_on_board") is None:
            continue
        last = sent_count.get(s["bus_id"])
        if last and last[:2] == (s["people_on_board"], s.get("seats_free")) and now - last[2] < HEARTBEAT_S:
            continue
        body = {"count": s["people_on_board"]}
        if s.get("seats_free") is not None and s.get("capacity"):
            body |= {"seats_free": s["seats_free"], "seats_total": s["capacity"]}
        r = http.post(f"{backend}/buses/{n}/count", json=body)
        sent_count[s["bus_id"]] = (s["people_on_board"], s.get("seats_free"), now)
        lines.append(f"{n}:{s['people_on_board']} on board{'' if r.status_code == 200 else ' !' + str(r.status_code)}")
    return lines


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tracking", default=os.environ.get("TRACKING_API_URL", "http://localhost:4000"))
    ap.add_argument("--tracking-token", default=os.environ.get("TRACKING_TOKEN"),
                    help="Bearer token for the tracking server (any role that can read /api/tracking/snapshot)")
    ap.add_argument("--backend", default=os.environ.get("SAFAR_API", "http://localhost:8000"))
    ap.add_argument("--counts-from", nargs="*", default=[], choices=["ir", "camera"],
                    help="Also forward people-on-board readings from these sources")
    ap.add_argument("--interval", type=float, default=2.0)
    args = ap.parse_args()
    key = os.environ.get("GPS_FEED_KEY")
    if not key or not args.tracking_token:
        raise SystemExit("Need GPS_FEED_KEY (backend/.env) and --tracking-token / TRACKING_TOKEN.")

    state: dict = {}
    with httpx.Client(timeout=5) as http:
        print(f"Forwarding GPS {args.tracking} -> {args.backend}/feeds/gps (counts from: {args.counts_from or 'none'})")
        while True:
            started = time.monotonic()
            try:
                lines = forward_once(http, args.tracking, args.tracking_token, args.backend, key, args.counts_from, state)
                if lines:
                    print(time.strftime("%H:%M:%S"), " ".join(lines), flush=True)
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                print(time.strftime("%H:%M:%S"), "error:", exc, flush=True)
            time.sleep(max(0.0, args.interval - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
