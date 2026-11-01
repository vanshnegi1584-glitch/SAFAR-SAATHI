"""GPS tracking server feed (POST /feeds/gps/{bus}) against the test database: like a driver's phone, it can
move the bus and start and end a trip through the geofences, and it is saved as the bus's live state."""
import pytest

from conftest import fetch

BUS = 14
KEY = "test-feed-key-0123456789"


@pytest.fixture(autouse=True)
def feed_key(monkeypatch):
    import main
    monkeypatch.setattr(main, "GPS_FEED_KEY", KEY)


def post(c, lat, lng, **extra):
    return c.post(f"/feeds/gps/{BUS}", json={"lat": lat, "lng": lng, **extra}, headers={"X-Feed-Key": KEY})


def test_feed_alone_starts_and_ends_a_trip(client_factory):
    import main
    with client_factory() as c:
        d = main.depot
        main.buses[BUS]["location_source"] = None
        for _ in range(2):  # the geofence needs 2 consecutive fixes
            assert post(c, d["lat"], d["lng"]).json()["accepted"]                   # at campus
        post(c, d["lat"] + 0.012, d["lng"] + 0.012)                                 # ~1.7 km out
        post(c, d["lat"] + 0.0125, d["lng"] + 0.012)
        out = c.get(f"/buses/{BUS}").json()
        assert out["status"] == "departed" and out["trip"]["id"] is not None and out["location_source"] == "gps_server"
        for _ in range(2):
            post(c, d["lat"], d["lng"])                                             # back at campus
        assert c.get(f"/buses/{BUS}").json()["trip"]["id"] is None


def test_feed_position_is_saved_as_live_state(client_factory):
    import main
    with client_factory() as c:
        d = main.depot
        assert post(c, d["lat"] + 0.004, d["lng"]).json()["accepted"]
        row = fetch("select st_y(location::geometry) as lat, st_x(location::geometry) as lng "
                    "from bus_live_state where bus_id = $1", BUS)[0]
        assert abs(row["lat"] - (d["lat"] + 0.004)) < 1e-6 and abs(row["lng"] - d["lng"]) < 1e-6


def test_feed_is_refused_without_the_key(client_factory):
    with client_factory() as c:
        assert c.post(f"/feeds/gps/{BUS}", json={"lat": 30.3, "lng": 78.0}).status_code == 401
