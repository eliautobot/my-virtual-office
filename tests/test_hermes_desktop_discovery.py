#!/usr/bin/env python3
"""Finding Hermes after D3: a `hermes serve` backend is found by POST /api/agent-providers/detect (its public
/api/status page), the Hermes Desktop backend client, its discovery and /api/hermes/desktop/discover are gone
(the route answers 410 and names the replacement). Before D3 this file checked the Desktop readiness-log port
discovery; that code was removed with the client.
"""

import http.client
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))


def check(name, condition, detail=""):
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"  OK {name}")


class StatusPage(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = json.dumps(self.server.status_body if self.path == "/api/status" else {"error": "not found"}).encode()
        self.send_response(200 if self.path == "/api/status" else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start(status_body):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), StatusPage)
    srv.status_body = status_body
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def post(port, path, body):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    conn.request("POST", path, body=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    res = conn.getresponse()
    out = json.loads(res.read().decode("utf-8") or "{}")
    conn.close()
    return res.status, out


def main():
    data = tempfile.TemporaryDirectory(prefix="vo-hermes-detect-")
    (Path(data.name) / "openclaw").mkdir()
    os.environ.update({"VO_STATUS_DIR": data.name, "VO_CONFIG": str(Path(data.name) / "vo-config.json"),
                       "VO_OPENCLAW_PATH": str(Path(data.name) / "openclaw"),
                       "VO_CODEX_INCLUDE_NATIVE_AGENTS": "0", "VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS": "0"})
    import server
    import agent_providers as ap
    from providers import hermes

    check("Desktop backend client and its discovery are gone",
          not any(hasattr(hermes, n) for n in ("HermesDesktopBackendClient", "discover_desktop_backend",
                                               "discover_desktop_agents", "_loopback_listener_ports")))
    check("Desktop handlers are gone from the server",
          not any(hasattr(server, n) for n in ("_handle_hermes_desktop_chat", "_handle_hermes_desktop_run_start",
                                               "_handle_hermes_desktop_run_events", "_handle_hermes_desktop_discover",
                                               "_test_hermes_desktop", "HermesDesktopBackendClient")))
    check("API-server path kept", callable(getattr(hermes, "HermesApiClient", None))
          and callable(getattr(hermes, "discover_api_connections", None)))

    serve, serve_url = start({"version": "0.22.1", "auth_required": True})
    other, other_url = start({"ok": True, "name": "not hermes"})
    dead_url = "http://127.0.0.1:9"
    server._hp_configure(data.name)
    httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
    httpd.block_on_close = False
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    try:
        # Only the fixtures are probed (the manifest's usual addresses are swapped out).
        with mock.patch.dict(ap.MANIFESTS["hermes"], {"detect": [serve_url, other_url, dead_url]}):
            status, out = post(port, "/api/agent-providers/detect", {"kind": "hermes"})
        check("detect answers", status == 200 and out.get("ok") is True, f"{status} {out}")
        found = out.get("found") or []
        check("detect finds the hermes serve status page", [f.get("url") for f in found] == [serve_url], str(found))
        check("detect reports version and sign-in", (found[0].get("version"), found[0].get("authRequired")) == (
            "0.22.1", True), str(found))
        status, out = post(port, "/api/agent-providers/detect", {"kind": "openclaw"})
        check("detect is for Hermes only", status == 400, f"{status} {out}")
        status, out = post(port, "/api/hermes/desktop/discover", {})
        check("old Desktop route answers 410 and names the replacement",
              status == 410 and out.get("replacement") == "/api/agent-providers/detect", f"{status} {out}")
    finally:
        httpd.shutdown()
        httpd.server_close()
        serve.shutdown()
        other.shutdown()
        server._hp_configure()
        data.cleanup()

    print("\n  Hermes detect (replaces Desktop discovery): all checks passed")


if __name__ == "__main__":
    main()
