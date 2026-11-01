"""Camera agent: the driver's page on this PC says which bus it is, and this runs the AI people counter for it.

Listens on 127.0.0.1 only, and answers only the website origins given with --origin (CORS), so a page from anywhere
else cannot drive the camera. The only thing it runs is count.py for a whole-number bus; nothing from the request
reaches a command line.

  POST   /camera  {"bus": 9}   start counting bus 9 (switches if another bus was being counted)
  DELETE /camera               stop the camera
  GET    /camera               {"bus": 9, "running": true, "restarts": 0}

If the counter exits while a bus is set (its window closed, the camera hiccupped) it starts again after 3 s.

  .venv\\Scripts\\python.exe camera_agent.py --backend http://127.0.0.1:8000 [--capacity 4]
      [--port 8011] [--origin http://localhost:5173 --origin http://127.0.0.1:5173]
"""
import argparse
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESTART_AFTER_S = 3


class Counter:
    """One count.py process for one bus at a time, restarted if it stops on its own."""

    def __init__(self, backend, capacity=None, extra=()):
        self.backend, self.capacity, self.extra = backend, capacity, list(extra)
        self.bus, self.proc, self.restarts = None, None, 0
        self.lock = threading.Lock()
        threading.Thread(target=self._watch, daemon=True).start()

    def command(self, bus):
        cmd = [sys.executable, str(HERE / "count.py"), "--bus", str(bus), "--show", "--responsive",
               "--interval", "1", "--backend", self.backend, *self.extra]
        return cmd + (["--capacity", str(self.capacity)] if self.capacity else [])

    def _spawn(self):
        # Its own console window, so its log is visible next to the camera window.
        flags = subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
        self.proc = subprocess.Popen(self.command(self.bus), cwd=HERE, creationflags=flags)

    def _kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def start(self, bus):
        with self.lock:
            if self.bus == bus and self.proc and self.proc.poll() is None:
                return  # already counting this bus
            self._kill()
            self.bus, self.restarts = bus, 0
            self._spawn()

    def stop(self):
        with self.lock:
            self.bus = None
            self._kill()

    def state(self):
        with self.lock:
            return {"bus": self.bus, "running": bool(self.proc and self.proc.poll() is None), "restarts": self.restarts}

    def _watch(self):
        while True:
            time.sleep(RESTART_AFTER_S)
            with self.lock:
                if self.bus is not None and self.proc and self.proc.poll() is not None:
                    self.restarts += 1
                    self._spawn()


def handler(counter, origins):
    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _allowed(self):
            origin = self.headers.get("Origin")
            if origin is not None and origin not in origins:
                self._reply(403, {"error": "origin not allowed"})
                return False
            return True

        def do_OPTIONS(self):  # CORS preflight from the website
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()

        def do_GET(self):
            if self.path != "/camera":
                return self._reply(404, {"error": "not found"})
            if self._allowed():
                self._reply(200, counter.state())

        def do_POST(self):
            if self.path != "/camera":
                return self._reply(404, {"error": "not found"})
            if not self._allowed():
                return
            try:
                body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 1000)) or b"{}")
                bus = body.get("bus")
                if isinstance(bus, bool) or not isinstance(bus, int) or not 1 <= bus <= 9999:
                    raise ValueError
            except (ValueError, AttributeError):
                return self._reply(400, {"error": 'send {"bus": <bus number>}'})
            counter.start(bus)
            self._reply(200, counter.state())

        def do_DELETE(self):
            if self.path != "/camera":
                return self._reply(404, {"error": "not found"})
            if self._allowed():
                counter.stop()
                self._reply(200, counter.state())

        def log_message(self, fmt, *args):
            sys.stderr.write(time.strftime("%H:%M:%S ") + fmt % args + "\n")

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--backend", required=True, help="SafarSaathi backend the counts go to, e.g. http://127.0.0.1:8000")
    ap.add_argument("--capacity", type=int, help="Seats per bus for the counter (e.g. 4 in the 4-seat test)")
    ap.add_argument("--port", type=int, default=8011)
    ap.add_argument("--origin", action="append", help="Website origin allowed to drive the camera (repeatable)")
    args = ap.parse_args()
    origins = set(args.origin or ["http://localhost:5173", "http://127.0.0.1:5173"])
    counter = Counter(args.backend, args.capacity)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(counter, origins))
    print(f"Camera agent on http://127.0.0.1:{args.port}/camera (website: {', '.join(sorted(origins))})", flush=True)
    try:
        server.serve_forever()
    finally:
        counter.stop()


if __name__ == "__main__":
    main()
