#!/usr/bin/env python3
"""Verify Hermes stays an external native API dependency."""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
sys.path.insert(0, str(APP))

from discovery import discover_hermes_agents  # noqa: E402
from providers.hermes import HermesApiClient  # noqa: E402


class FakeHermesHandler(BaseHTTPRequestHandler):
    server_version = "FakeHermes/1"

    def log_message(self, *_args):
        pass

    def _send(self, body, status=200):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self):
        return self.headers.get("Authorization") == f"Bearer {self.server.api_key}"

    def do_GET(self):
        if not self._authorized():
            self._send({"error": "unauthorized"}, 401)
            return
        if self.path == "/health":
            self._send({"status": "ok"})
        elif self.path == "/v1/capabilities":
            self._send({
                "profile": self.server.profile,
                "model": self.server.model,
                "features": {"run_submission": True, "run_events_sse": True},
            })
        elif self.path == "/v1/models":
            self._send({"data": [{"id": self.server.model}]})
        elif self.path.startswith("/api/sessions?"):
            self._send({"data": [{"id": f"{self.server.profile}-session", "title": "Native session"}]})
        elif self.path.endswith("/messages"):
            self._send({"data": [{"role": "assistant", "content": f"from {self.server.profile}"}]})
        elif self.path.startswith("/api/sessions/"):
            self._send({"session": {"id": self.path.rsplit("/", 1)[-1]}})
        else:
            self._send({"error": "not found"}, 404)

    def do_DELETE(self):
        if not self._authorized():
            self._send({"error": "unauthorized"}, 401)
            return
        if self.path.startswith("/api/sessions/"):
            self._send({"deleted": True})
        else:
            self._send({"error": "not found"}, 404)


def start_gateway(profile, model, api_key):
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeHermesHandler)
    server.profile = profile
    server.model = model
    server.api_key = api_key
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def check(label, condition):
    print(f"[{'PASS' if condition else 'FAIL'}] {label}")
    if not condition:
        raise AssertionError(label)


def main():
    first = start_gateway("native-default", "openai/model-a", "key-a")
    second = start_gateway("native-coby", "openai/model-b", "key-b")
    try:
        connections = [
            {"id": "astra", "name": "Astra", "apiUrl": f"http://127.0.0.1:{first.server_port}", "apiKey": "key-a"},
            {"id": "coby", "name": "Coby", "apiUrl": f"http://127.0.0.1:{second.server_port}", "apiKey": "key-b"},
        ]
        agents = discover_hermes_agents(
            hermes_home="/path/that/must/not/be/read",
            hermes_bin="/path/that/must/not/run",
            desktop_url="http://127.0.0.1:1",
            connections=connections,
            timeout_sec=2,
        )
        check("one office agent is discovered per native gateway", [item["id"] for item in agents] == ["hermes-astra", "hermes-coby"])
        check("connection names are preserved", [item["name"] for item in agents] == ["Astra", "Coby"])
        check("models are advertised by separate native runtimes", [item["model"] for item in agents] == ["openai/model-a", "openai/model-b"])
        check("no CLI or Desktop mode is advertised", all(item["connectionModes"] == ["api"] and not item["cliAvailable"] for item in agents))

        bad = discover_hermes_agents(connections=[{**connections[0], "apiKey": "wrong"}], timeout_sec=2)
        check("authentication is required", bad == [])

        client = HermesApiClient(connections[0]["apiUrl"], "key-a", timeout_sec=2)
        check("session list uses native REST API", client.list_sessions()["data"][0]["id"] == "native-default-session")
        check("session transcript uses native REST API", client.get_session_messages("native-default-session")["data"][0]["content"] == "from native-default")
        check("session deletion uses native REST API", client.delete_session("native-default-session").get("deleted") is True)

        server_source = (APP / "server.py").read_text(encoding="utf-8")
        discovery_source = (APP / "discovery.py").read_text(encoding="utf-8")
        check("Virtual Office has no Hermes gateway auto-start", "_ensure_hermes_profile_api" not in server_source)
        check("production discovery only calls API connections", "return discover_api_connections(" in discovery_source)
        check("retired Hermes Desktop endpoint is explicitly gone", 'request_path == "/api/hermes/desktop/discover"' in server_source and "self.send_response(410)" in server_source)
    finally:
        first.shutdown()
        second.shutdown()
        first.server_close()
        second.server_close()

    print("verify-hermes-native-connections: OK")


if __name__ == "__main__":
    main()
