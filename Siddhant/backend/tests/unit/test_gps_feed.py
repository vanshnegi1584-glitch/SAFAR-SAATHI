"""Pure tests (no database): the GPS feed endpoint (POST /feeds/gps/{bus}) and tools/gps_feed.py.

Run without the DB fixtures:  .venv/Scripts/python -m pytest --noconftest tests/unit
The endpoint runs through FastAPI's TestClient with the database, geofence and broadcast stubbed out.
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND.parent / "tools"))
os.environ.setdefault("SUPABASE_URL", "http://supabase.test.invalid")

from fastapi.testclient import TestClient  # noqa: E402

import gps_feed  # noqa: E402
import main  # noqa: E402

KEY = "test-feed-key-0123456789"
BUS = 18


@pytest.fixture
def api(monkeypatch):
    """The real app (no lifespan, so no database), one bus, a known feed key, side effects recorded."""
    calls = {"geofence": 0, "persist": 0, "broadcast": []}

    async def run_geofence(bus, fixes):
        calls["geofence"] += 1

    async def persist(bus, telemetry=True):
        calls["persist"] += 1

    async def broadcast(msg):
        calls["broadcast"].append(msg)

    monkeypatch.setattr(main, "GPS_FEED_KEY", KEY)
    monkeypatch.setattr(main, "run_geofence", run_geofence)
    monkeypatch.setattr(main, "persist", persist)
    monkeypatch.setattr(main.hub, "broadcast", broadcast)
    monkeypatch.setattr(main, "bus_view", lambda b: {"id": b["id"], "location": b["location"],
                                                     "location_source": b.get("location_source"), "speed_kmh": b.get("speed_kmh")})
    monkeypatch.setattr(main, "buses", {BUS: {"id": BUS, "location": None, "location_source": None, "location_at": None}})
    return TestClient(main.app), calls


def feed(client, body, key=KEY, bus=BUS):
    return client.post(f"/feeds/gps/{bus}", json=body, headers={"X-Feed-Key": key} if key else {})


# ---------- the endpoint ----------

def test_feed_needs_the_right_key(api):
    client, calls = api
    assert feed(client, {"lat": 30.3, "lng": 78.0}, key=None).status_code == 401
    assert feed(client, {"lat": 30.3, "lng": 78.0}, key="wrong").status_code == 401
    assert main.buses[BUS]["location"] is None and calls["persist"] == 0


def test_feed_is_off_without_a_configured_key(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(main, "GPS_FEED_KEY", None)
    r = feed(client, {"lat": 30.3, "lng": 78.0})
    assert r.status_code == 503 and "GPS_FEED_KEY" in r.json()["detail"]


def test_feed_moves_the_bus_like_a_phone_and_tells_the_website(api):
    client, calls = api
    r = feed(client, {"lat": 30.3, "lng": 78.0, "speed_kmh": 25, "accuracy_m": 8})
    assert r.status_code == 200 and r.json()["accepted"] is True
    bus = main.buses[BUS]
    assert bus["location"] == {"lat": 30.3, "lng": 78.0} and bus["location_source"] == "gps_server" and bus["speed_kmh"] == 25
    assert calls == {"geofence": 1, "persist": 1, "broadcast": [{"type": "bus", "data": main.bus_view(bus)}]}


def test_feed_rejects_rough_fixes_unknown_buses_and_bad_coordinates(api):
    client, calls = api
    r = feed(client, {"lat": 30.3, "lng": 78.0, "accuracy_m": 900}).json()
    assert r["accepted"] is False and "too rough" in r["reason"] and main.buses[BUS]["location"] is None
    assert feed(client, {"lat": 30.3, "lng": 78.0}, bus=999).status_code == 404
    assert feed(client, {"lat": 95, "lng": 78.0}).status_code == 422
    assert calls["persist"] == 0


def test_the_bus_s_own_gps_device_wins_over_the_feed(api):
    client, _ = api
    bus = main.buses[BUS]
    bus.update(location={"lat": 1.0, "lng": 2.0}, location_source="device", location_at=datetime.now(timezone.utc))
    r = feed(client, {"lat": 30.3, "lng": 78.0}).json()
    assert r["accepted"] is False and "device" in r["reason"] and bus["location"] == {"lat": 1.0, "lng": 2.0}


def test_speed_is_derived_only_from_the_feed_s_own_previous_fix(api):
    client, _ = api
    bus = main.buses[BUS]
    feed(client, {"lat": 30.3, "lng": 78.0})
    bus["location_at"] = datetime.now(timezone.utc) - timedelta(seconds=10)
    feed(client, {"lat": 30.3009, "lng": 78.0})  # ~100 m in ~10 s = ~36 km/h
    assert 30 < bus["speed_kmh"] < 42
    # A previous fix from a driver's phone is a different device: no speed is made up across them.
    bus.update(location_source="phone", location_at=datetime.now(timezone.utc) - timedelta(seconds=10))
    feed(client, {"lat": 30.3018, "lng": 78.0})
    assert bus["speed_kmh"] is None


def test_a_driver_s_phone_still_reports_as_phone(api):
    client, _ = api
    main.app.dependency_overrides[main.require_bus_staff] = lambda: {"role": "driver", "name": "Test Driver"}
    try:
        r = client.post(f"/buses/{BUS}/location", json={"lat": 30.31, "lng": 78.01})
    finally:
        main.app.dependency_overrides.clear()
    assert r.json()["accepted"] is True and main.buses[BUS]["location_source"] == "phone"


# ---------- tools/gps_feed.py ----------

def snapshot(latest, seats=()):
    return {"buses": [{"id": "bus-uk07pa1696", "fleet_number": "18"}, {"id": "bus-uk07pa3542", "fleet_number": "42"},
                      {"id": "bus-x", "fleet_number": "T-1"}],
            "latest": list(latest), "seats": list(seats)}


def fix(bus_id, measured_at, lng=78.0, lat=30.3, speed_mps=7.0):
    return {"bus_id": bus_id, "measured_at": measured_at, "location": [lng, lat], "accuracy_m": 8, "speed_mps": speed_mps}


def seat(bus_id, people, source="ir", capacity=40):
    return {"bus_id": bus_id, "people_on_board": people, "people_source": source, "seats_free": capacity - people, "capacity": capacity}


class Fake:
    """Tracking server + backend behind one httpx transport; records every post."""
    def __init__(self, snap):
        self.snap, self.posts = snap, []

    def handler(self, req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/tracking/snapshot":
            assert req.headers["authorization"] == "Bearer tok"
            return httpx.Response(200, json=self.snap)
        self.posts.append((req.url.path, req.headers.get("x-feed-key"), httpx.Request("POST", req.url, content=req.content).read()))
        return httpx.Response(200, json={"accepted": True})

    def run(self, state, counts_from=("ir",), now=0.0):
        with httpx.Client(transport=httpx.MockTransport(self.handler)) as http:
            return gps_feed.forward_once(http, "http://track", "tok", "http://api", KEY, list(counts_from), state, now=now)


def test_tool_posts_new_positions_by_bus_number_in_the_backend_s_units():
    fake = Fake(snapshot([fix("bus-uk07pa1696", 1000, lng=78.01, lat=30.31, speed_mps=7.0)]))
    lines = fake.run({})
    assert lines == ["18:ok"]
    path, key, body = fake.posts[0]
    assert path == "/feeds/gps/18" and key == KEY
    assert httpx.Response(200, content=body).json() == {"lat": 30.31, "lng": 78.01, "accuracy_m": 8, "speed_kmh": 25.2}


def test_tool_sends_each_fix_once_and_skips_buses_without_a_number():
    fake = Fake(snapshot([fix("bus-uk07pa1696", 1000), fix("bus-x", 1000), fix("bus-unknown", 1000)]))
    state = {}
    assert fake.run(state) == ["18:ok"]
    assert fake.run(state) == []                                  # same measured_at: nothing new
    fake.snap["latest"][0]["measured_at"] = 4000
    assert fake.run(state) == ["18:ok"]


def test_tool_forwards_only_counts_from_the_chosen_source_and_only_when_they_change():
    fake = Fake(snapshot([], [seat("bus-uk07pa3542", 19), seat("bus-uk07pa1696", 1, source="camera", capacity=41)]))
    state = {}
    assert fake.run(state, now=0) == ["42:19 on board"]           # the camera bus posts its own count directly
    assert httpx.Response(200, content=fake.posts[0][2]).json() == {"count": 19, "seats_free": 21, "seats_total": 40}
    assert fake.run(state, now=5) == []                           # unchanged
    assert fake.run(state, now=5 + gps_feed.HEARTBEAT_S) == ["42:19 on board"]  # heartbeat
    fake.snap["seats"][0] = seat("bus-uk07pa3542", 25)
    assert fake.run(state, now=21) == ["42:25 on board"]          # changed
    assert fake.run({}, counts_from=()) == []                     # counts off by default
