#!/usr/bin/env python3
"""A3 hp-openclaw: the OpenClaw adapter against a fake Gateway (never the real one)."""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import time
import unittest

from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for path in (os.path.join(HERE, "..", "app"), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from helpers.fake_gateway import FakeError, FakeGateway  # noqa: E402
from openclaw_adapter import (  # noqa: E402
    CHAT_ONLY_ADMIN_READ, CHAT_ONLY_BROWSER, CHAT_ONLY_FILES, CHAT_ONLY_FIX, CHAT_ONLY_SETTINGS, TASK_STOP_REASON,
    UNREACHABLE, ApprovalBook, OpenClawAdapter, ProviderError, QuestionBook, event_matches,
)
from openclaw_gateway_client import OpenClawGatewayClient  # noqa: E402

KEY = "agent:main:main"
PNG = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 800, 600) + b"\x08\x02\x00\x00\x00"


def ev(name: str, payload: dict) -> dict:
    return {"type": "event", "event": name, "payload": payload}


def wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class EventFilterAndBooks(unittest.TestCase):
    def test_event_matches_agent_session_and_global_list(self) -> None:
        chat = ev("chat", {"runId": "r", "sessionKey": KEY})
        self.assertTrue(event_matches(chat, "main", KEY))
        self.assertTrue(event_matches(chat, "MAIN", "main"))  # bare key under its agent
        self.assertFalse(event_matches(chat, "ops", None))
        self.assertFalse(event_matches(chat, "main", "agent:main:other"))
        self.assertTrue(event_matches({"type": "proxy.ready", "payload": {}}, "ops", "x"))
        self.assertTrue(event_matches(ev("cron", {"jobId": "j"}), "ops", "x"))
        approval = ev("exec.approval.requested", {"id": "a", "request": {"sessionKey": KEY, "command": "ls"}})
        self.assertTrue(event_matches(approval, "main", KEY))
        self.assertFalse(event_matches(approval, "ops", None))
        self.assertFalse(event_matches(ev("exec.approval.requested", {"id": "a"}), "main", KEY))
        self.assertTrue(event_matches(ev("agent", {"runId": "r"}), "main", KEY))  # no identity: as today
        task = ev("task", {"action": "upserted", "task": {"id": "t", "ownerKey": "agent:main:side"}})
        self.assertTrue(event_matches(task, "main", KEY))  # agent-wide
        self.assertFalse(event_matches(task, "ops", KEY))

    def test_approval_book_from_both_event_forms(self) -> None:
        book = ApprovalBook()
        out = book.feed("exec.approval.requested", {"id": "a1", "expiresAtMs": int(time.time() * 1000) + 60000,
                                                    "request": {"sessionKey": KEY, "command": "rm x", "cwd": "/w"}})
        self.assertEqual(out["type"], "approval.requested")
        self.assertEqual(out["options"], ["allow-once", "allow-always", "deny"])
        self.assertEqual(out["title"], "Run a command")
        self.assertIsNone(book.feed("exec.approval.requested", {"id": "a1", "request": {"sessionKey": KEY}}))
        book.feed("session.approval", {"sessionKey": "agent:ops:x", "phase": "pending", "approval": {
            "id": "p1", "presentation": {"kind": "plugin", "title": "Post it", "allowedDecisions": ["allow-once", "deny"]}}})
        self.assertEqual([c["approvalId"] for c in book.pending("main", KEY)], ["a1"])
        self.assertEqual(book.pending("ops", "x")[0]["options"], ["allow-once", "deny"])
        self.assertIsNone(book.lookup("ops", KEY, "a1"))
        self.assertEqual(book.feed("exec.approval.resolved", {"id": "a1", "decision": "deny"})["decision"], "deny")
        self.assertEqual(book.pending("main", KEY), [])
        book.feed("exec.approval.requested", {"id": "old", "expiresAtMs": 1, "request": {"sessionKey": KEY}})
        self.assertEqual(book.pending("main", KEY), [])  # expired

    def test_question_book(self) -> None:
        book = QuestionBook()
        out = book.feed("question.requested", {"id": "q1", "sessionKey": KEY, "questions": [
            {"id": "color", "header": "Color", "question": "Which?", "options": [{"label": "Red"}], "multiSelect": True},
            {"question": "Password?", "isSecret": True}]})
        self.assertEqual(out["questions"][0]["questionId"], "color")
        self.assertTrue(out["questions"][1]["secret"])
        self.assertEqual(book.feed("question.resolved", {"id": "q1", "status": "expired"})["status"], "expired")


class AdapterOnFakeGateway(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway().start()
        self.access = "full"
        self.media = tempfile.TemporaryDirectory(prefix="vo-hp-openclaw-")
        self.client = OpenClawGatewayClient(
            lambda _key: {"url": self.gateway.url, "token": "test-token", "access": self.access},
            connect, reconnect_min_sec=0.02, reconnect_max_sec=0.1,
        )
        self.adapter = OpenClawAdapter(lambda: self.client, config_key_getter=lambda: ("fake", self.access),
                                       access_getter=lambda: self.access, media_roots=[self.media.name])
        self.client.start(("fake", self.access))
        self.assertTrue(wait_for(lambda: self.client.status()["connected"]))

    def tearDown(self) -> None:
        self.adapter.close()
        self.client.close()
        self.gateway.stop()
        self.media.cleanup()

    def chat_only(self) -> None:
        self.access = "chat"
        self.client.start(("fake", "chat"))
        self.assertTrue(wait_for(lambda: self.client.status()["connected"] and self.client.status()["access"] == "chat"))

    def reconnect(self) -> None:
        """Drops the fake's sockets and waits for the client's next connection (new hello)."""
        generation = self.client.status()["generation"]
        self.gateway.drop()
        self.assertTrue(wait_for(lambda: self.client.status()["connected"]
                                 and self.client.status()["generation"] > generation))

    def assertRefused(self, text: str, fn, *args, **kwargs) -> None:
        with self.assertRaises(ProviderError) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, "chat_only")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.message, text)
        self.assertEqual(caught.exception.fix, CHAT_ONLY_FIX)

    def ask_approval(self, approval_id: str = "a1", kind: str = "exec") -> None:
        self.adapter.start()
        self.gateway.emit(f"{kind}.approval.requested", {"id": approval_id, "request": {"sessionKey": KEY, "command": "ls"}})
        self.assertTrue(wait_for(lambda: self.adapter.approvals.lookup("main", KEY, approval_id)))

    def test_can_caps_full_then_chat_only(self) -> None:
        can = self.adapter.can("main", KEY, manage=True)
        self.assertTrue(can["ok"])
        caps = can["caps"]
        self.assertEqual(can["access"], "full")
        self.assertEqual(caps["approvalOptions"], ["allow-once", "allow-always", "deny"])
        for name in ("models", "effort", "questions", "progressCard", "tasks", "browser", "computerWrite"):
            self.assertTrue(caps[name], name)
        self.assertEqual(caps["queue"], "steer")
        self.assertFalse(caps["taskSteer"] or caps["screen"] or caps["observe"])
        self.assertEqual(can["limits"], {"attachmentBytes": 5000000, "maxFiles": 8})
        self.assertEqual(can["locked"], {})
        self.chat_only()
        can = self.adapter.can("main", KEY)
        self.assertEqual(can["access"], "chat")
        self.assertFalse(can["caps"]["browser"] or can["caps"]["computerWrite"] or can["caps"]["sessionDelete"])
        self.assertTrue(can["caps"]["approvals"] and can["caps"]["models"])
        self.assertEqual(can["locked"]["browser"], CHAT_ONLY_BROWSER)
        self.assertEqual(can["locked"]["computerWrite"], CHAT_ONLY_FILES)

    def test_can_only_offers_what_hello_lists_and_offline_says_why(self) -> None:
        self.gateway.methods = ["agents.list", "exec.approval.resolve"]
        self.reconnect()
        caps = self.adapter.can("main", KEY)["caps"]
        self.assertTrue(caps["approvals"])
        self.assertFalse(caps["models"] or caps["tasks"] or caps["browser"] or caps["progressCard"])
        self.gateway.stop()
        self.assertTrue(wait_for(lambda: not self.client.status()["connected"]))
        can = self.adapter.can("main", KEY)
        self.assertEqual((can["ok"], can["reason"], can["message"]), (False, "offline", UNREACHABLE))

    def test_models_and_prefs_per_chat(self) -> None:
        picker = self.adapter.models("main", KEY)
        self.assertEqual(picker["default"], "openai/gpt-x")
        self.assertEqual([m["id"] for m in picker["models"]], ["openai/gpt-x"])
        self.assertEqual(picker["models"][0]["effort"], [{"id": "low", "label": "Low"}, {"id": "high", "label": "high"}])
        self.assertEqual(self.gateway.calls("models.list")[-1], {"agentId": "main", "sessionKey": KEY})
        self.chat_only()  # model/effort per chat stays allowed under Chat only
        out = self.adapter.set_prefs("main", KEY, model="openai/gpt-x", effort="high")
        self.assertEqual(out["prefs"], {"model": "openai/gpt-x", "effort": "high"})
        self.assertEqual(self.gateway.calls("sessions.patch")[-1],
                         {"key": KEY, "agentId": "main", "model": "openai/gpt-x", "thinkingLevel": "high"})
        self.assertEqual(self.adapter.can("main", KEY)["prefs"], {"model": "openai/gpt-x", "effort": "high"})
        with self.assertRaises(ProviderError):
            self.adapter.set_prefs("main", "", model="x")

    def test_approve_checks_owner_and_uses_fallbacks(self) -> None:
        self.ask_approval("a1")
        with self.assertRaises(ProviderError) as caught:
            self.adapter.approve("ops", KEY, None, "a1", "allow-once")
        self.assertEqual(caught.exception.code, "not_found")
        seen = []
        self.adapter.on_event(seen.append)
        self.chat_only()  # approvals are answered under Chat only too
        self.assertEqual(self.adapter.approve("main", KEY, None, "a1", "always")["decision"], "allow-always")
        self.assertEqual(self.gateway.calls("approval.resolve")[-1], {"id": "a1", "kind": "exec", "decision": "allow-always"})
        self.assertEqual(seen[-1]["type"], "approval.resolved")
        with self.assertRaises(ProviderError):
            self.adapter.approve("main", KEY, None, "a1", "deny")  # no longer waiting
        # Old gateway: no approval.resolve -> the kind's own method.
        self.gateway.methods = [m for m in self.gateway.offered() if m != "approval.resolve"]
        self.reconnect()
        self.ask_approval("p1", kind="plugin")
        self.adapter.approve("main", KEY, None, "p1", False)
        self.assertEqual(self.gateway.calls("plugin.approval.resolve")[-1], {"id": "p1", "decision": "deny"})

    def test_approve_falls_back_when_generic_method_is_unknown(self) -> None:
        del self.gateway.handlers["approval.resolve"]
        self.gateway.methods = self.gateway.offered() + ["approval.resolve"]
        self.reconnect()
        self.ask_approval("a2")
        self.adapter.approve("main", KEY, None, "a2", "allow-once")
        self.assertEqual(self.gateway.calls("exec.approval.resolve")[-1], {"id": "a2", "decision": "allow-once"})

    def test_answer_and_cancel_questions(self) -> None:
        self.adapter.start()
        questions = [{"id": "color", "question": "Which?", "options": [{"label": "Red"}]}]
        self.gateway.emit("question.requested", {"id": "q1", "sessionKey": KEY, "questions": questions})
        self.gateway.emit("question.requested", {"id": "q2", "sessionKey": KEY, "questions": questions})
        self.assertTrue(wait_for(lambda: len(self.adapter.questions) == 2))
        self.assertEqual(len(self.adapter.state("main", KEY)["questions"]), 2)
        with self.assertRaises(ProviderError):
            self.adapter.answer("main", KEY, None, "q1", {"other": ["x"]})
        self.adapter.answer("main", KEY, None, "q1", {"color": "Red"})
        self.assertEqual(self.gateway.calls("question.resolve")[-1], {"id": "q1", "answers": {"answers": {"color": ["Red"]}}})
        self.adapter.answer("main", KEY, None, "q2", cancel=True)
        self.assertEqual(self.gateway.calls("question.resolve")[-1], {"id": "q2", "cancel": True})
        with self.assertRaises(ProviderError) as caught:
            self.adapter.answer("main", "agent:main:other", None, "q2", {"color": "Red"})
        self.assertEqual(caught.exception.code, "not_found")

    def test_tasks_list_one_history_cancel(self) -> None:
        self.gateway.tasks = {
            "t1": {"id": "t1", "status": "running", "sessionKey": KEY, "agentId": "main"},
            "t2": {"id": "t2", "status": "completed", "ownerKey": "agent:main:other"},
            "t3": {"id": "t3", "status": "running", "sessionKey": "agent:ops:main", "agentId": "ops"},
        }
        mine = self.adapter.tasks("main", KEY)
        self.assertEqual([t["id"] for t in mine["active"]], ["t1"])
        self.assertEqual(mine["recent"], [])
        whole = self.adapter.tasks("main", KEY, scope="agent")
        self.assertEqual([(t["id"], t["here"]) for t in whole["active"] + whole["recent"]], [("t1", True), ("t2", False)])
        self.assertEqual(self.gateway.calls("tasks.list")[-1]["sortBy"], "endedAt")
        self.assertEqual(self.adapter.task("main", "t1", KEY)["task"]["id"], "t1")
        with self.assertRaises(ProviderError) as caught:
            self.adapter.task("main", "t3", KEY)
        self.assertEqual(caught.exception.code, "not_found")
        with self.assertRaises(ProviderError):
            self.adapter.task("main", "missing", KEY)
        history = self.adapter.task_history("main", "t1", KEY, cursor="c1")
        self.assertEqual(history["messages"][0], {"role": "user", "text": "do it"})
        self.assertEqual(history["nextCursor"], "c2")
        self.chat_only()  # stopping a task is not a settings write
        self.assertTrue(self.adapter.cancel_task("main", "t1", KEY)["cancelled"])
        self.assertEqual(self.gateway.calls("tasks.cancel")[-1], {"taskId": "t1", "reason": TASK_STOP_REASON})

    def test_tasks_on_an_older_openclaw_without_sort_by(self) -> None:
        """OpenClaw 2026.7.x refuses sortBy with its schema error (text as that build words it): the office asks
        again without it, sorts newest first itself, skips sortBy for a while; other refusals still surface."""
        newer = self.gateway.handlers["tasks.list"]

        def older(p: dict, s: list[str]) -> dict:
            if "sortBy" in p:
                raise FakeError("INVALID_REQUEST", "invalid tasks.list params: at root: unexpected property 'sortBy'")
            return newer(p, s)

        self.gateway.handlers["tasks.list"] = older
        self.gateway.tasks = {
            "a": {"id": "a", "status": "completed", "sessionKey": KEY, "endedAt": 1000},
            "b": {"id": "b", "status": "failed", "sessionKey": KEY, "endedAt": "1970-01-01T00:00:03Z"},
            "c": {"id": "c", "status": "cancelled", "sessionKey": KEY},
            "d": {"id": "d", "status": "completed", "sessionKey": KEY, "endedAt": 2000},
            "e": {"id": "e", "status": "running", "sessionKey": KEY},
        }
        mine = self.adapter.tasks("main", KEY)
        self.assertEqual(["e"], [t["id"] for t in mine["active"]])
        self.assertEqual(["b", "d", "a", "c"], [t["id"] for t in mine["recent"]])
        sent = [("sortBy" in p) for p in self.gateway.calls("tasks.list")]
        self.assertEqual([False, True, False], sent)  # active, refused sorted ask, plain ask
        self.adapter.tasks("main", KEY)
        self.assertEqual([False, True, False, False, False], [("sortBy" in p) for p in self.gateway.calls("tasks.list")])

        def broken(p: dict, s: list[str]) -> dict:
            if "sortBy" in p:
                raise FakeError("INVALID_REQUEST", "invalid tasks.list params: at root: unexpected property 'limit'")
            return newer(p, s)

        self.adapter._tasks_sort_local_until = 0.0
        self.gateway.handlers["tasks.list"] = broken
        with self.assertRaises(ProviderError) as caught:
            self.adapter.tasks("main", KEY)
        self.assertEqual("gateway", caught.exception.code)

    def test_progress_card_get_refresh_dismiss(self) -> None:
        self.gateway.cards[KEY] = {"steps": [{"step": "a", "status": "done"}, {"step": "b", "status": "running"}],
                                   "revision": 2}
        got = self.adapter.progress("main", KEY, "get")
        self.assertEqual(got["plan"]["revision"], 2)
        self.assertEqual(got["can"], {"refresh": True, "dismiss": True})
        self.assertEqual(self.adapter.progress("main", KEY, "refresh", idempotency_key="k1"),
                         {"accepted": True, "revision": 3})
        self.assertEqual(self.gateway.calls("progressCard.refresh")[-1]["idempotencyKey"], "k1")
        with self.assertRaises(ProviderError):
            self.adapter.progress("main", KEY, "dismiss", revision=2)  # a step still running
        self.assertTrue(self.adapter.progress("main", KEY, "dismiss", revision=1)["changed"])
        self.gateway.cards[KEY]["steps"][1]["status"] = "completed"
        self.assertEqual(self.adapter.progress("main", KEY, "dismiss", revision=2), {"dismissed": True})
        self.assertEqual(self.gateway.calls("progressCard.put")[-1]["expectedRevision"], 2)

    def test_browser_full_access_ops(self) -> None:
        state = self.adapter.browser("main", "state")
        self.assertEqual((state["available"], state["tabs"][0]["id"]), (True, "tab1"))
        with self.assertRaises(ProviderError):
            self.adapter.browser("main", "click", {"tab": "tab1", "fx": 0.5, "fy": 0.5})  # no picture yet
        self.gateway.screenshot_path = os.path.join(self.media.name, "shot.png")
        with open(self.gateway.screenshot_path, "wb") as handle:
            handle.write(PNG)
        frame = self.adapter.browser("main", "frame", {"tab": "tab1"})
        self.assertEqual((frame["mime"], frame["width"], frame["height"]), ("image/png", 800, 600))
        self.adapter.browser("main", "click", {"tab": "tab1", "fx": 0.5, "fy": 0.25, "double": True})
        act = self.gateway.calls("browser.request")[-1]["body"]
        self.assertEqual((act["kind"], act["x"], act["y"], act["doubleClick"]), ("clickCoords", 400, 150, True))
        self.adapter.browser("main", "key", {"tab": "tab1", "key": "Enter"})
        with self.assertRaises(ProviderError):
            self.adapter.browser("main", "key", {"tab": "tab1", "key": "F12"})
        self.adapter.browser("main", "navigate", {"tab": "tab1", "url": "example.org"})
        self.assertEqual(self.gateway.calls("browser.request")[-1]["body"]["url"], "https://example.org")
        with self.assertRaises(ProviderError):
            self.adapter.browser("main", "navigate", {"tab": "tab1", "url": "file:///etc/passwd"})
        self.assertEqual(self.adapter.browser("main", "open", {"url": ""})["tab"]["id"], "tab2")
        self.adapter.browser("main", "scroll", {"tab": "tab1", "dy": 99999})
        self.assertIn("scrollBy(0, 5000)", self.gateway.calls("browser.request")[-1]["body"]["fn"])
        with self.assertRaises(ProviderError) as caught:
            self.adapter.browser("main", "text", {"tab": "gone", "text": "hi"})
        self.assertEqual(caught.exception.code, "not_found")
        self.gateway.screenshot_path = "/etc/hostname.png"  # outside the media roots: never read
        with self.assertRaises(ProviderError):
            self.adapter.browser("main", "frame", {"tab": "tab1"})

    def test_browser_chat_only(self) -> None:
        self.chat_only()
        state = self.adapter.browser("main", "state")
        self.assertEqual((state["available"], state["reason"]), (False, CHAT_ONLY_BROWSER))
        before = len(self.gateway.calls("browser.request"))
        self.assertRefused(CHAT_ONLY_BROWSER, self.adapter.browser, "main", "open", {"url": "example.org"})
        self.assertEqual(len(self.gateway.calls("browser.request")), before)

    def test_files_read_both_levels_write_full_only(self) -> None:
        self.assertEqual(self.adapter.files("main", "list", {"path": "/"})["entries"][0]["name"], "notes.txt")
        self.assertEqual(self.adapter.files("main", "read", {"path": "notes.txt"})["content"], "hi")
        doc = self.adapter.files("main", "doc", {"name": "AGENTS.md"})
        self.assertEqual((doc["content"], doc["hash"]), ("# Agent", "h1"))
        self.assertTrue(self.adapter.files("main", "docSet", {"name": "AGENTS.md", "content": "new", "expectedHash": "h1"})["ok"])
        with self.assertRaises(ProviderError) as caught:
            self.adapter.files("main", "docSet", {"name": "AGENTS.md", "content": "x", "expectedHash": "h1"})
        self.assertEqual(caught.exception.code, "conflict")
        self.chat_only()
        self.assertEqual([f["name"] for f in self.adapter.files("main", "docs")["files"]], ["AGENTS.md"])
        self.assertRefused(CHAT_ONLY_FILES, self.adapter.files, "main", "docSet", {"name": "AGENTS.md", "content": "y"})

    def test_menu_writes_admin_reads_and_redaction(self) -> None:
        config = self.adapter.menu("openclaw", "config.get")
        self.assertEqual(config["config"]["gateway"]["auth"]["token"], {"secret": True, "set": True})
        self.assertNotIn("SECRET-VALUE", repr(config))
        self.assertTrue(self.adapter.menu("openclaw", "agents.update", {"agentId": "main", "model": "x"})["ok"])
        with self.assertRaises(ProviderError) as caught:
            self.adapter.menu("openclaw", "chat.send", {})
        self.assertEqual(caught.exception.code, "unsupported")
        self.chat_only()
        writes = len(self.gateway.calls("agents.update"))
        self.assertRefused(CHAT_ONLY_SETTINGS, self.adapter.menu, "openclaw", "agents.update", {"agentId": "main"})
        self.assertRefused(CHAT_ONLY_ADMIN_READ, self.adapter.menu, "openclaw", "config.get")
        self.assertRefused(CHAT_ONLY_SETTINGS, self.adapter.session_op, "main", "delete", KEY)
        self.assertEqual(len(self.gateway.calls("agents.update")), writes)
        self.assertEqual(self.adapter.menu("openclaw", "agents.list")["defaultId"], "main")

    def test_agents_sessions_and_status(self) -> None:
        agents = self.adapter.agents()
        self.assertEqual(agents["agents"], [{"id": "main", "name": "Main", "emoji": ""},
                                            {"id": "ops", "name": "Ops", "emoji": "x"}])
        rows = self.adapter.sessions("main")["sessions"]
        self.assertEqual([(r["key"], r["title"], r["model"], r["active"]) for r in rows],
                         [(KEY, "Main chat", "openai/gpt-x", True)])
        status = self.adapter.status()
        self.assertEqual((status["state"], status["access"], status["version"]), ("connected", "full", "2026.10.30"))
        with self.assertRaises(ProviderError) as caught:
            self.adapter.run("main", KEY, "hi", [], False)
        self.assertEqual(caught.exception.code, "unsupported")


class StatusTexts(unittest.TestCase):
    def test_token_refused_text(self) -> None:
        gateway = FakeGateway(token="other").start()
        client = OpenClawGatewayClient(lambda _key: {"url": gateway.url, "token": "test-token"}, connect,
                                       reconnect_min_sec=0.05, reconnect_max_sec=0.1)
        adapter = OpenClawAdapter(lambda: client, config_key_getter=lambda: "k")
        try:
            client.start("k")
            self.assertTrue(wait_for(lambda: client.status()["lastError"]))
            status = adapter.status()
            self.assertEqual((status["state"], status["code"], status["detail"]),
                             ("error", "auth_rejected", "The gateway refused the token."))
            self.assertFalse(adapter.test(timeout=0.2)["ok"])
        finally:
            client.close()
            gateway.stop()


if __name__ == "__main__":
    unittest.main()
