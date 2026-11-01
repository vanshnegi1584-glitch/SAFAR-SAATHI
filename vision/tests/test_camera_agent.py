"""The camera agent's HTTP rules, with a fake counter process (no camera is opened)."""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import camera_agent  # noqa: E402

SITE = "http://localhost:5173"


class FakeProc:
    def __init__(self, cmd):
        self.cmd, self.code = cmd, None

    def poll(self):
        return self.code

    def terminate(self):
        self.code = 0

    def wait(self, timeout=None):
        return self.code


class FakeCounter(camera_agent.Counter):
    def __init__(self):
        super().__init__("http://api", capacity=4)
        self.spawned = []

    def _spawn(self):
        self.proc = FakeProc(self.command(self.bus))
        self.spawned.append(self.proc)


@pytest.fixture
def agent():
    counter = FakeCounter()
    server = ThreadingHTTPServer(("127.0.0.1", 0), camera_agent.handler(counter, {SITE}))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", counter
    server.shutdown()


def call(url, method="GET", body=None, origin=SITE):
    req = urllib.request.Request(url + "/camera", method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Origin": origin} if origin else {})})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read()), r.headers.get("Access-Control-Allow-Origin")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read()), e.headers.get("Access-Control-Allow-Origin")


def test_the_driver_page_starts_and_switches_the_camera_for_its_bus(agent):
    url, counter = agent
    status, state, cors = call(url, "POST", {"bus": 9})
    assert status == 200 and state == {"bus": 9, "running": True, "restarts": 0} and cors == SITE
    cmd = counter.spawned[-1].cmd
    assert cmd[cmd.index("--bus") + 1] == "9" and "--show" in cmd and cmd[cmd.index("--capacity") + 1] == "4"
    assert cmd[cmd.index("--backend") + 1] == "http://api"
    call(url, "POST", {"bus": 9})                                   # same bus again: not restarted
    assert len(counter.spawned) == 1
    status, state, _ = call(url, "POST", {"bus": 10})               # the driver picked another bus
    assert state["bus"] == 10 and counter.spawned[0].code == 0 and len(counter.spawned) == 2
    status, state, _ = call(url, "DELETE")
    assert state == {"bus": None, "running": False, "restarts": 0}


def test_only_a_whole_bus_number_is_accepted(agent):
    url, counter = agent
    for bad in ({"bus": "9; del *"}, {"bus": 9.5}, {"bus": True}, {"bus": 0}, {}, {"bus": [9]}):
        assert call(url, "POST", bad)[0] == 400
    assert counter.spawned == []


def test_other_websites_cannot_drive_the_camera(agent):
    url, counter = agent
    status, _, cors = call(url, "POST", {"bus": 9}, origin="https://evil.example")
    assert status == 403 and cors is None and counter.spawned == []


def test_a_counter_that_stops_on_its_own_is_started_again(agent, monkeypatch):
    url, counter = agent
    call(url, "POST", {"bus": 9})
    counter.spawned[-1].code = 1                                    # window closed / camera error
    with counter.lock:                                              # what the watcher does every few seconds
        if counter.bus is not None and counter.proc.poll() is not None:
            counter.restarts += 1
            counter._spawn()
    assert call(url)[1] == {"bus": 9, "running": True, "restarts": 1}
