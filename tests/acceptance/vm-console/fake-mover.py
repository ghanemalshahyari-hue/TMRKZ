"""Stand-in for MOVER's web (http) and its TLS proxy in the MOVER VM helper tests.

    python3 fake-mover.py PORT [CERT KEY]

Delays come from the scenario folder ($SCN): health-delay, ready-delay, page-delay (seconds) and, for the proxy only,
proxy-delay. Once the stand-in docker has recreated web ($SCN/healed), every delay is 0. Answers carry no data.
"""
import os
import ssl
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCN = os.environ["SCN"]
PROXY = len(sys.argv) > 2
VIDEO = b"\0" * 800_000


def delay(name):
    if os.path.exists(os.path.join(SCN, "healed")):
        return 0.0
    try:
        with open(os.path.join(SCN, name)) as f:
            return float(f.read().strip() or 0)
    except OSError:
        return 0.0


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        wait = delay("proxy-delay") if PROXY else 0.0
        path = self.path.split("?")[0]
        if path == "/health":
            wait += delay("health-delay"); body = b'{"ok":true}'
        elif path == "/health/ready":
            wait += delay("health-delay") + delay("ready-delay"); body = b'{"ready":true}'
        elif path == "/login":
            wait += delay("health-delay") + delay("page-delay"); body = b"<!doctype html><title>sign in</title>" + b"x" * 20000
        elif path == "/static/brand/login-bg.mp4":
            body = VIDEO
        else:
            self.send_response(404); self.end_headers(); return
        time.sleep(wait)
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer((os.environ.get("BIND", "127.0.0.1"), int(sys.argv[1])), Handler)
if PROXY:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(sys.argv[2], sys.argv[3])
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
server.serve_forever()
