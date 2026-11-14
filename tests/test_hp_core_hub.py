"""hp-core B3: provider_hub (design 2.5, 2.11): seq, rings, resume, resync, per-chat isolation,
whitelist + clipping, /state snapshot, stream cap, signed media."""

import io
import os
import queue
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import provider_hub as ph  # noqa: E402

A = ph.chat_key("lab", "default", "s1")
B = ph.chat_key("lab", "default", "s2")
C = ph.chat_key("lab", "research", "s1")


def keys(chat):
    return [chat, ph.agent_key(chat[0], chat[1]), ph.connection_key(chat[0])]


def drain(sub):
    out = []
    while True:
        try:
            out.append(sub.get(timeout=0.01))
        except queue.Empty:
            return out


class HubTests(unittest.TestCase):
    def setUp(self):
        self.hub = ph.ChatHub()

    def test_seq_is_monotonic_and_chats_are_isolated(self):
        sa, sb, sc = (self.hub.subscribe(keys(k)) for k in (A, B, C))
        f1 = self.hub.publish(A, {"type": "run.start"}, run="r1")
        f2 = self.hub.publish(B, {"type": "run.delta", "text": "b", "at": 0}, run="r2")
        f3 = self.hub.publish(ph.agent_key("lab", "default"), {"type": "agent.activity", "active": True})
        f4 = self.hub.publish(ph.connection_key("lab"), {"type": "provider.status", "state": "connected"})
        self.assertLess(f1["seq"], f2["seq"])
        self.assertLess(f2["seq"], f3["seq"])
        got_a = [f["seq"] for f in drain(sa)]
        got_b = [f["seq"] for f in drain(sb)]
        got_c = [f["seq"] for f in drain(sc)]
        self.assertEqual(got_a, [f1["seq"], f3["seq"], f4["seq"]])
        self.assertEqual(got_b, [f2["seq"], f3["seq"], f4["seq"]])
        self.assertEqual(got_c, [f4["seq"]])  # other agent: connection status only

    def test_resume_without_doubles_and_resync_when_history_is_gone(self):
        frames = [self.hub.publish(A, {"type": "run.delta", "text": f"p{i}", "at": i * 2}, run="r") for i in range(5)]
        sub = self.hub.subscribe(keys(A), since=frames[2]["seq"])
        self.assertEqual([f["seq"] for f in drain(sub)], [frames[3]["seq"], frames[4]["seq"]])
        stale = self.hub.subscribe(keys(A), since=self.hub.base - 5)  # from before a restart
        self.assertEqual(drain(stale)[0]["type"], "resync")
        future = self.hub.subscribe(keys(A), since=self.hub.seq + 10)
        self.assertEqual(drain(future)[0]["type"], "resync")
        small = ph.ChatHub(ring_max=3)
        first = [small.publish(A, {"type": "run.status", "phase": str(i)}, run="r") for i in range(6)]
        evicted = small.subscribe(keys(A), since=first[0]["seq"])
        self.assertEqual(drain(evicted)[0]["type"], "resync")

    def test_overflow_gives_resync_and_closes(self):
        hub = ph.ChatHub(queue_max=3)
        sub = hub.subscribe(keys(A))
        for i in range(5):
            hub.publish(A, {"type": "run.status", "phase": str(i)}, run="r")
        self.assertEqual(sub.get(timeout=0.1)["type"], "resync")
        self.assertTrue(sub.closed)
        self.assertEqual(hub.subscriber_count(), 0)

    def test_whitelist_and_clipping(self):
        frame = self.hub.publish(A, {"type": "run.delta", "text": "x" * 200_000, "at": 0, "secretPath": "/root",
                                     "raw": {"a": 1}}, run="r")
        self.assertEqual(set(frame["event"]), {"type", "text", "at"})
        self.assertEqual(len(frame["event"]["text"]), ph.TEXT_MAX)
        tool = self.hub.publish(A, {"type": "tool.end", "toolId": "t", "text": "y" * 9000}, run="r")
        self.assertEqual(len(tool["event"]["text"]), ph.TOOL_OUTPUT_MAX)
        self.assertIsNone(self.hub.publish(A, {"type": "debug.dump", "everything": 1}))
        q = self.hub.publish(A, {"type": "question.requested", "questionId": "q",
                                 "questions": [{"question": "?", "options": [{"label": str(i)} for i in range(20)],
                                                "secret": True, "value": "hidden"}] * 9}, run="r")
        self.assertEqual(len(q["event"]["questions"]), 5)
        self.assertEqual(len(q["event"]["questions"][0]["options"]), 8)
        self.assertNotIn("value", q["event"]["questions"][0])

    def test_snapshot_rebuilds_runs_and_ignores_replayed_pieces(self):
        hub = self.hub
        hub.publish(A, {"type": "run.start", "model": "m1"}, run="r1")
        hub.publish(A, {"type": "run.delta", "text": "Hel", "at": 0}, run="r1")
        hub.publish(A, {"type": "run.delta", "text": "lo", "at": 3}, run="r1")
        hub.publish(A, {"type": "run.delta", "text": "Hel", "at": 0}, run="r1")  # a replayed piece
        hub.publish(A, {"type": "tool.start", "toolId": "t1", "name": "terminal", "title": "Run"}, run="r1")
        hub.publish(A, {"type": "tool.update", "toolId": "t1", "text": "out"}, run="r1")
        hub.publish(A, {"type": "approval.requested", "approvalId": "ap1", "options": ["allow-once", "deny"]},
                    run="r1")
        hub.publish(A, {"type": "usage.update", "used": 10, "size": 100})
        hub.publish(A, {"type": "native", "op": "title", "title": "Hello chat"})
        snap = hub.snapshot(A)
        self.assertTrue(snap["working"])
        self.assertEqual(snap["title"], "Hello chat")
        self.assertEqual(snap["usage"], {"used": 10, "size": 100})
        run = snap["runs"][0]
        self.assertEqual((run["runId"], run["text"], run["model"]), ("r1", "Hello", "m1"))
        self.assertEqual(run["tools"][0]["output"], "out")
        self.assertEqual(run["approvals"][0]["status"], "pending")
        hub.publish(A, {"type": "approval.resolved", "approvalId": "ap1", "decision": "allow-once"}, run="r1")
        hub.publish(A, {"type": "run.end", "status": "ok", "text": "Hello!"}, run="r1")
        snap = hub.snapshot(A)
        self.assertFalse(snap["working"])
        self.assertEqual(snap["runs"][0]["text"], "Hello!")
        self.assertEqual(snap["runs"][0]["approvals"][0]["status"], "allow-once")
        self.assertEqual(hub.snapshot(B)["runs"], [])

    def test_end_runs_interrupts_only_that_connection(self):
        self.hub.publish(A, {"type": "run.start"}, run="r1")
        other = ph.chat_key("other", "default", "s1")
        self.hub.publish(other, {"type": "run.start"}, run="r9")
        self.hub.end_runs("lab", "The connection settings changed")
        self.assertEqual(self.hub.snapshot(A)["runs"][0]["status"], "interrupted")
        self.assertEqual(self.hub.snapshot(other)["runs"][0]["status"], "running")

    def test_listener_sees_frames(self):
        seen = []
        remove = self.hub.add_listener(lambda key, frame: seen.append((key, frame["event"]["type"])))
        self.hub.publish(ph.agent_key("lab", "default"), {"type": "agent.activity", "active": True})
        remove()
        self.hub.publish(A, {"type": "run.start"}, run="x")
        self.assertEqual(seen, [(("lab", "default", "*"), "agent.activity")])


class FakeHandler:
    def __init__(self, headers=None, command="GET"):
        self.wfile = io.BytesIO()
        self.status = None
        self.sent_headers = {}
        self.json = None
        self.headers = headers or {}
        self.command = command

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent_headers[name] = value

    def end_headers(self):
        pass

    def _send_json(self, payload, status=200, headers=None):
        self.status, self.json = status, payload
        self.sent_headers.update(headers or {})


class StreamSlotTests(unittest.TestCase):
    """v0.10.1 B2: slots count per page id, free as soon as the socket closes, global cap."""

    def tearDown(self):
        with ph._STREAMS_LOCK:
            self.assertEqual(sum(ph._STREAMS.values()), 0, dict(ph._STREAMS))
            self.assertEqual((ph._LIVE, ph._SLOTS), ({}, {}))

    def _open(self, client, slot=None, stop=None, connection=None):
        import threading
        handler = FakeHandler()
        handler.connection = connection
        done = threading.Event()

        def run():
            try:
                ph.serve_sse(handler, keys(A), hub=ph.ChatHub(), client=client, heartbeat=15, stop=stop, slot=slot)
            finally:
                done.set()
        threading.Thread(target=run, daemon=True).start()
        return handler, done

    def _wait(self, cond, seconds=3.0):
        end = time.time() + seconds
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.02)
        return cond()

    def test_stream_client_prefers_the_page_id(self):
        h = FakeHandler(headers={"X-VO-Client": "pabc123xyz"})
        h.client_address = ("10.0.0.5", 1)
        self.assertEqual(ph.stream_client(h), "page:pabc123xyz")
        h = FakeHandler()
        h.client_address = ("10.0.0.5", 1)
        self.assertEqual(ph.stream_client(h, {"client": ["pq-1234567"]}), "page:pq-1234567")
        self.assertEqual(ph.stream_client(h, {"client": "pq-1234567"}), "page:pq-1234567")
        self.assertEqual(ph.stream_client(h, {"client": ["bad id!"]}), "10.0.0.5")
        self.assertEqual(ph.stream_client(h), "10.0.0.5")

    def test_closed_socket_frees_the_slot_without_waiting_for_the_heartbeat(self):
        import socket
        ours, browser = socket.socketpair()
        try:
            handler, done = self._open("page:close-test", connection=ours)
            self.assertTrue(self._wait(lambda: ph.open_streams("page:close-test") == 1))
            started = time.time()
            browser.close()  # tab closed / reloaded
            self.assertTrue(done.wait(3.0), "stream still open after the socket closed")
            self.assertLess(time.time() - started, 2.5)
            self.assertEqual(ph.open_streams("page:close-test"), 0)
            self.assertNotIn(": hb", handler.wfile.getvalue().decode())
        finally:
            ours.close()

    def test_reloads_and_a_proxy_address_never_run_out(self):
        import socket
        # Twelve reloads in a row (each a new page id, the old socket closed), then 20 tabs that all come
        # through one proxy address: every stream is accepted, nothing is left counted at the end.
        for n in range(12):
            ours, browser = socket.socketpair()
            handler, done = self._open(f"page:reload-{n:02d}", slot="life", connection=ours)
            self.assertTrue(self._wait(lambda: handler.status == 200), f"reload {n}: {handler.status}")
            browser.close()
            self.assertTrue(done.wait(3.0))
            ours.close()
        stop = __import__("threading").Event()
        opened = [self._open(f"page:tab-{n:02d}", slot="life", stop=stop) for n in range(20)]
        try:
            self.assertTrue(self._wait(lambda: all(h.status == 200 for h, _ in opened)),
                            [h.status for h, _ in opened])
            self.assertEqual(ph.open_streams(), 20)
        finally:
            stop.set()
            for _, done in opened:
                done.wait(3.0)

    def test_per_page_cap_global_cap_and_retry_after(self):
        stop = __import__("threading").Event()
        mine = [self._open("page:one-page", stop=stop) for _ in range(ph.STREAMS_PER_CLIENT)]
        try:
            self.assertTrue(self._wait(lambda: ph.open_streams("page:one-page") == ph.STREAMS_PER_CLIENT))
            refused = FakeHandler()
            self.assertFalse(ph.serve_sse(refused, keys(A), hub=ph.ChatHub(), client="page:one-page"))
            self.assertEqual((refused.status, refused.sent_headers.get("Retry-After")), (429, "2"))
            others = [self._open(f"page:other-{n:02d}", stop=stop)
                      for n in range(ph.STREAMS_MAX - ph.STREAMS_PER_CLIENT)]
            self.assertTrue(self._wait(lambda: ph.open_streams() == ph.STREAMS_MAX))
            full = FakeHandler()
            self.assertFalse(ph.serve_sse(full, keys(A), hub=ph.ChatHub(), client="page:latecomer"))
            self.assertEqual(full.status, 429)
            mine.extend(others)
        finally:
            stop.set()
            for _, done in mine:
                done.wait(3.0)

    def test_same_page_slot_replaces_the_older_stream(self):
        stop = __import__("threading").Event()
        first, first_done = self._open("page:same-tab", slot="life", stop=stop)
        try:
            self.assertTrue(self._wait(lambda: first.status == 200))
            second, second_done = self._open("page:same-tab", slot="life", stop=stop)
            self.assertTrue(first_done.wait(3.0), "older stream of the same page kept running")
            self.assertTrue(self._wait(lambda: second.status == 200))
            self.assertEqual(ph.open_streams("page:same-tab"), 1)
        finally:
            stop.set()
            second_done.wait(3.0)


class SseAndMediaTests(unittest.TestCase):
    def test_sse_writes_ids_and_caps_streams_per_client(self):
        hub = ph.ChatHub()
        hub.publish(A, {"type": "run.start"}, run="r1")
        first = hub.publish(A, {"type": "run.delta", "text": "hi", "at": 0}, run="r1")
        handler = FakeHandler()
        ph.serve_sse(handler, keys(A), since=first["seq"] - 1, hub=hub, client="t-cap", max_seconds=0.2)
        body = handler.wfile.getvalue().decode()
        self.assertIn(f"id: {first['seq']}\n", body)
        self.assertEqual(body.count("id: "), 1)
        self.assertEqual(handler.sent_headers["Content-Type"], "text/event-stream; charset=utf-8")
        with ph._STREAMS_LOCK:
            ph._STREAMS["t-cap"] = ph.STREAMS_PER_CLIENT
        try:
            refused = FakeHandler()
            self.assertFalse(ph.serve_sse(refused, keys(A), hub=hub, client="t-cap", max_seconds=0.1))
            self.assertEqual((refused.status, refused.json["error"]), (429, "too_many_streams"))
        finally:
            with ph._STREAMS_LOCK:
                ph._STREAMS.pop("t-cap", None)
        self.assertEqual(ph.open_streams("t-cap"), 0)

    def test_media_tokens_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph.configure_media(tmp)
            key_path = os.path.join(tmp, ph.MEDIA_KEY_FILE)
            self.assertEqual(os.stat(key_path).st_mode & 0o777, 0o600)
            token = ph.sign_media("hermes-lab", "s1", "/home/x/pic.png")
            self.assertEqual(ph.verify_media(token)["ref"], "/home/x/pic.png")
            self.assertIsNone(ph.verify_media(token[:-2] + "AA"))
            self.assertIsNone(ph.verify_media(ph.sign_media("a", "s", "r", ttl=-1)))
            calls = []

            def fetch(agent, session, ref):
                calls.append(ref)
                return b"\x89PNG-data-0123456789", "image/png"
            h = FakeHandler()
            ph.serve_media(h, token, fetch)
            self.assertEqual(h.status, 200)
            self.assertEqual(h.sent_headers["Content-Security-Policy"], "sandbox")
            self.assertEqual(h.sent_headers["X-Content-Type-Options"], "nosniff")
            ranged = FakeHandler(headers={"Range": "bytes=0-3"})
            ph.serve_media(ranged, token, fetch)
            self.assertEqual((ranged.status, ranged.wfile.getvalue()), (206, b"\x89PNG"))
            self.assertEqual(calls, ["/home/x/pic.png"])  # second read came from the cache
            html = FakeHandler()
            ph.serve_media(html, ph.sign_media("a", "s", "page.html"), lambda *_: (b"<script>", "text/html"))
            self.assertEqual(html.sent_headers["Content-Type"], "application/octet-stream")
            bad = FakeHandler()
            ph.serve_media(bad, "nope", fetch)
            self.assertEqual(bad.status, 403)
            ph.cache_put("a", "s", "big", b"x" * 300, "image/png", limit=200)
            ph.configure_media(None)


if __name__ == "__main__":
    unittest.main()
