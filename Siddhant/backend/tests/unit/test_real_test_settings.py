"""Pure tests (no database) for the 4-seat real-test settings: AUTO_FULL_FROM_COUNT through POST /buses/{id}/count,
and the outbound drive of tools/test_drive.py.

Run without the DB fixtures:  .venv/Scripts/python -m pytest --noconftest tests/unit
"""
import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND.parent / "tools"))
os.environ.setdefault("SUPABASE_URL", "http://supabase.test.invalid")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import test_drive  # noqa: E402

BUS = 9


@pytest.fixture
def api(monkeypatch):
    """The real count endpoint with a 4-seat bus; database writes, fusion and broadcast stubbed and recorded."""
    events = []

    async def noop(*a, **k):
        return None

    async def trip_event(bus_id, trip_id, kind, ts, **kw):
        events.append((bus_id, kind, kw.get("detail")))

    async def refill(bus):
        return []

    monkeypatch.setattr(main, "AUTO_FULL_FROM_COUNT", True)
    monkeypatch.setattr(main, "maybe_recalibrate", noop)
    monkeypatch.setattr(main, "persist", noop)
    monkeypatch.setattr(main.hub, "broadcast", noop)
    monkeypatch.setattr(main, "refill_calls", refill)
    monkeypatch.setattr(main.db, "insert_trip_event", trip_event)
    monkeypatch.setattr(main, "occupancy", lambda b: b["count"] or 0)
    monkeypatch.setattr(main, "seats_free", lambda b: max(b["capacity"] - (b["count"] or 0), 0))
    monkeypatch.setattr(main, "bus_view", lambda b: {"id": b["id"], "status": b["status"], "count": b["count"]})
    monkeypatch.setattr(main, "buses", {BUS: {"id": BUS, "capacity": 4, "count": 0, "status": "boarding", "trip_id": None}})
    return TestClient(main.app), events


def count(client, n):
    return client.post(f"/buses/{BUS}/count", json={"count": n}).json()


def test_a_bus_at_campus_turns_full_when_the_count_fills_every_seat(api):
    client, events = api
    assert count(client, 3)["status"] == "boarding"
    assert count(client, 4)["status"] == "full"
    assert events == [(BUS, "manual_status", "auto: full from people count 4/4")]
    assert count(client, 4)["status"] == "full" and len(events) == 1     # no repeat event


def test_it_opens_again_if_someone_gets_off_before_it_leaves(api):
    client, events = api
    count(client, 4)
    assert count(client, 3)["status"] == "boarding"
    assert events[-1] == (BUS, "manual_status", "auto: boarding from people count 3/4")


def test_a_bus_already_on_its_trip_is_left_alone(api):
    client, events = api
    main.buses[BUS].update(trip_id=77, status="departed")
    assert count(client, 4)["status"] == "departed" and events == []


def test_nothing_changes_with_the_setting_off(api, monkeypatch):
    client, events = api
    monkeypatch.setattr(main, "AUTO_FULL_FROM_COUNT", False)
    assert count(client, 4)["status"] == "boarding" and events == []


# ---------- tools/test_drive.py ----------

CAMPUS = (30.2687, 77.9945)
# Stored far end first, like the backend's stop_points: Ghanta Ghar ... ISBT (nearest campus).
STOPS = [{"name": n, "lat": lat, "lng": 77.9945} for n, lat in (("Ghanta Ghar", 30.2987), ("Saharanpur", 30.2887), ("ISBT", 30.2787))]


def test_the_drive_starts_in_the_depot_and_visits_stops_from_campus_outwards():
    pts = test_drive.drive_points(CAMPUS, STOPS, speed_mps=10, step_s=2, dwell_s=6)
    assert pts[0] == CAMPUS and pts[1] == CAMPUS                          # two fixes inside the depot
    assert pts[-1] == (30.2987, 77.9945)                                  # ends at the far end (Ghanta Ghar)
    lats = [p[0] for p in pts]
    assert lats == sorted(lats)                                           # always moving away from campus
    stop_at = [i for i, p in enumerate(pts) if p == (30.2787, 77.9945)]
    assert len(stop_at) == 1 + 3 and stop_at == list(range(stop_at[0], stop_at[0] + 4))  # arrive + 3 held fixes (6 s)
    hops = [test_drive.metres(a, b) for a, b in zip(pts, pts[1:]) if a != b]
    assert max(hops) <= 20 + 1e-6                                         # 10 m/s x 2 s per fix


# ---------- following the approved road path ----------

import import_route_paths  # noqa: E402

EAST = 77.9945 + 0.0104  # ~1 km east
# Approved road path, first pickup -> campus: A goes 1 km east, then south, then west into campus (an L).
ROAD = [(30.2987, 77.9945), (30.2987, EAST), (30.2687, EAST), CAMPUS]
LSTOPS = [{"name": "A", "lat": 30.2987, "lng": 77.9945}, {"name": "Corner", "lat": 30.2987, "lng": EAST}]


def test_the_drive_follows_the_approved_road_and_waits_at_each_stop():
    pts = test_drive.drive_points(CAMPUS, LSTOPS, speed_mps=10, step_s=2, dwell_s=6, road_path=ROAD)
    assert pts[:2] == [CAMPUS, CAMPUS] and pts[-1] == pytest.approx((30.2987, 77.9945))
    road_line = [(lat, lng) for lat, lng in ROAD]
    assert max(import_route_paths.offset_m(road_line, p) for p in pts) < 1           # always on the road
    corner = [i for i, p in enumerate(pts) if p == pytest.approx((30.2987, EAST), abs=1e-7)]
    assert len(corner) == 4 and corner == list(range(corner[0], corner[0] + 4))      # arrive + 3 held fixes
    hops = [test_drive.metres(a, b) for a, b in zip(pts, pts[1:])]
    assert max(hops) <= 20 + 1e-6                                                    # 10 m/s x 2 s
    straight = test_drive.drive_points(CAMPUS, LSTOPS, 10, 2, 6)
    assert len(pts) > len(straight) + 40                                             # the road is longer


def test_a_restarted_driver_carries_a_bus_on_from_where_it_is_not_from_campus():
    pts = test_drive.drive_points(CAMPUS, LSTOPS, speed_mps=10, step_s=2, dwell_s=6, road_path=ROAD)
    on_trip = pts[len(pts) // 2]
    rest = test_drive.resume_points(pts, (on_trip[0], on_trip[1] - 0.0005))   # ~50 m beside the road
    assert rest[0] == on_trip and rest[-1] == pts[-1]
    assert CAMPUS not in rest
    assert set(test_drive.resume_points(pts, pts[-1])) == {pts[-1]}            # already at the end: only its wait there


def test_import_matches_routes_by_first_stop_and_refuses_a_path_that_misses_a_stop():
    assert import_route_paths.same_place("Ghanta Ghar (Clock Tower)", "Clock Tower")
    assert import_route_paths.same_place("Astley Hall", "Asley Hall")
    assert not import_route_paths.same_place("Rajpur", "Raipur Chowk")
    geometry = [[lng, lat] for lat, lng in ROAD]
    ours = [{"id": 1, "name": "A via corner", "stop_points": LSTOPS},
            {"id": 2, "name": "A via elsewhere", "stop_points": [LSTOPS[0], {"name": "Far", "lat": 30.2987, "lng": EAST + 0.02}]}]
    accepted, report = import_route_paths.match(ours, [{"name": "A → Geu", "geometry": geometry, "geometry_status": "verified"},
                                                       {"name": "A → Geu (draft)", "geometry": geometry, "geometry_status": "candidate"}], 400)
    assert list(accepted) == ["1"] and accepted["1"]["path"][0] == [30.2987, 77.9945]
    assert any("2 A via elsewhere" in line and "NOT used" in line for line in report)


class FakeHttp:
    """Stands in for httpx.Client: answers the OSRM request with a canned line, or fails."""
    def __init__(self, coords=None, fail=False):
        self.coords, self.fail, self.urls = coords, fail, []

    def get(self, url, timeout=None):
        self.urls.append(url)
        if self.fail:
            raise test_drive.httpx.ConnectError("offline")
        coords = self.coords

        class R:
            def raise_for_status(self):
                return self

            def json(self):
                return {"routes": [{"geometry": {"coordinates": coords}}]}
        return R()


def test_without_an_approved_path_the_drive_uses_the_road_line_the_map_draws():
    campus_out = [[lng, lat] for lat, lng in reversed(ROAD)]                     # OSRM: campus -> far end, [lng, lat]
    http = FakeHttp(campus_out)
    road = test_drive.osrm_road(http, LSTOPS, CAMPUS)
    assert road == [tuple(p) for p in ROAD]                                      # first pickup -> campus, (lat, lng)
    assert http.urls[0].startswith(test_drive.OSRM + "77.9945,30.2687;")       # from campus, the map's request
    assert "geometries=geojson" in http.urls[0]
    assert test_drive.osrm_road(FakeHttp(fail=True), LSTOPS, CAMPUS) is None     # offline: straight lines instead
    assert test_drive.map_campus() == (30.2687, 77.9945)
