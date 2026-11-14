"""The fake provider CLIs (tests/tools/fake-*) against the office's OWN provider classes (app/providers/*.py).

Proves each fake speaks what the office runs and parses: a reply, thinking where the CLI has it, a tool step, a Codex
approval round trip (accept and cancel), stop of a slow reply, chat lists/history/delete. Scratch HOME per test (the
fakes keep state under it), no real CLI, no account, no network.
Run: python3 tests/test_fake_clis.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
TOOLS = os.path.join(HERE, "tools")
sys.path.insert(0, os.path.join(TREE, "app"))


class _Scratch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="vo-fake-cli-")
        self._env = dict(os.environ)
        os.environ["HOME"] = self.tmp
        os.environ["VO_STATUS_DIR"] = os.path.join(self.tmp, "data")
        os.environ["FAKE_STEP_DELAY"] = "0.01"
        os.environ["FAKE_SLOW_STEP"] = "0.2"
        os.environ["FAKE_SLOW_WORDS"] = "40"
        os.makedirs(os.environ["VO_STATUS_DIR"], exist_ok=True)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


class CodexAppServer(_Scratch):
    def provider(self, **kw):
        from providers.codex import CodexProvider
        return CodexProvider(home_path=os.path.join(self.tmp, ".codex"), binary=os.path.join(TOOLS, "fake-codex"),
                             workspace_root=os.path.join(self.tmp, "codex-agents"), include_native_agents=False,
                             register_native_agents=False, **kw)

    def test_health_and_main_agent(self):
        p = self.provider()
        t = p.test()
        self.assertTrue(t.get("ok"), t)
        self.assertEqual(t.get("protocol"), "app-server")
        self.assertIn("main", [a.get("profile") for a in t.get("agents") or []])

    def test_reply_thinking_tool_and_history(self):
        p = self.provider()
        snaps = []
        out = p.send_chat_message("main", "hello there [[tool]]", on_progress=snaps.append)
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out.get("reply"), "Fake Codex reply 1: hello there")
        self.assertEqual(out.get("providerPath"), "app-server")
        self.assertIn("Thinking about: hello there", out.get("thinking") or "")
        tools = out.get("tools") or []
        self.assertEqual(len(tools), 1, tools)
        self.assertEqual(tools[0].get("name"), "shell")
        self.assertEqual(tools[0].get("status"), "done") if tools[0].get("status") != "completed" else None
        self.assertIn("fake-tool-ok", tools[0].get("result") or "")
        self.assertTrue(any((s.get("reply") or "").startswith("Fake Codex") and s.get("reply") != out["reply"] for s in snaps)
                        or len(snaps) > 3, "streamed snapshots")
        sid = out.get("sessionId")
        again = p.send_chat_message("main", "second", session_id=sid)
        self.assertEqual(again.get("reply"), "Fake Codex reply 2: second")
        self.assertEqual(again.get("sessionId"), sid)
        lst = p.list_threads("main")
        self.assertTrue(lst.get("ok"), lst)
        self.assertEqual([s["id"] for s in lst["sessions"]], [sid])
        self.assertEqual(lst["sessions"][0]["title"], "hello there")
        th = p.read_thread("main", sid)
        items = [i for turn in th["thread"]["turns"] for i in turn["items"]]
        self.assertEqual([i["type"] for i in items], ["userMessage", "agentMessage"] * 2)
        self.assertTrue(p.delete_thread("main", sid).get("deleted"))
        self.assertEqual(p.list_threads("main").get("sessions"), [])

    def test_thinking_is_not_doubled(self):
        # The app-server protocol sends summary deltas AND the completed reasoning item carrying the same text; the
        # office's CodexAppRunState keeps one entry per reasoning item (the completed item replaces its deltas), so
        # the thinking shows once (was shown twice before the unify integration fix).
        out = self.provider().send_chat_message("main", "ponder")
        self.assertEqual(out.get("thinking"), "Thinking about: ponder")

    def test_thinking_parts_per_item(self):
        # (unit, no fake) deltas of two summary parts, then the completed item: once, parts kept apart; an item that
        # never streamed adds its own text; an id-less delta still shows
        import providers.codex as codex
        st = codex.CodexAppRunState()
        for i, d in ((0, "Plan "), (0, "this."), (1, "Then that.")):
            st.handle_message({"method": "item/reasoning/summaryTextDelta", "params": {"itemId": "r1", "delta": d, "summaryIndex": i}})
        self.assertEqual(st.thinking(), "Plan this.\n\nThen that.")
        st.handle_message({"method": "item/completed", "params": {"item": {"id": "r1", "type": "reasoning", "summary": ["Plan this.", "Then that."]}}})
        self.assertEqual(st.thinking(), "Plan this.\n\nThen that.")
        st.handle_message({"method": "item/completed", "params": {"item": {"id": "r2", "type": "reasoning", "summary": [" More."]}}})
        self.assertEqual(st.thinking(), "Plan this.\n\nThen that. More.")

    def _approval_round(self, choice):
        p = self.provider(approval_policy="on-request")
        seen = []
        result = {}

        def run():
            result.update(p.send_chat_message("main", "please run it [[approval]]", on_progress=seen.append))

        th = threading.Thread(target=run, daemon=True)
        th.start()
        self.addCleanup(lambda: th.is_alive() and p.interrupt("main"))
        deadline = time.time() + 10
        approval = None
        while time.time() < deadline and not approval:
            approval = next((s.get("approval") for s in seen if s.get("approval")), None)
            time.sleep(0.05)
        self.assertTrue(approval, "approval surfaced in a snapshot")
        self.assertEqual(approval.get("command"), "echo fake-tool-ok")
        pending = p.pending_approval("main")
        self.assertTrue(pending.get("ok") and pending.get("pending"), pending)
        res = p.respond_approval("main", approval.get("id") or approval.get("approval_id"), choice)
        self.assertTrue(res.get("ok"), res)
        th.join(15)
        return result

    def test_approval_accept(self):
        out = self._approval_round("approve")
        self.assertEqual(out.get("reply"), "Fake Codex reply 1: please run it")
        self.assertIn("fake-tool-ok", (out.get("tools") or [{}])[0].get("result") or "")

    def test_approval_cancel(self):
        out = self._approval_round("cancel")
        self.assertEqual(out.get("reply"), "Fake Codex reply 1: the command was declined.")

    def test_stop_slow_reply(self):
        p = self.provider()
        result = {}
        th = threading.Thread(target=lambda: result.update(p.send_chat_message("main", "long one [[slow]]")))
        th.start()
        time.sleep(1.5)
        stop = p.interrupt("main")
        self.assertTrue(stop.get("ok"), stop)
        th.join(10)
        self.assertFalse(th.is_alive())
        self.assertTrue(result.get("reply", "").startswith("Fake Codex reply 1: long one"), result)
        self.assertNotIn("w40", result.get("reply", ""))

    def test_error_turn(self):
        out = self.provider().send_chat_message("main", "boom [[error]]")
        self.assertFalse(out.get("ok"))
        self.assertIn("fake failure", out.get("error") or "")


class CodexExec(_Scratch):
    def test_exec_and_resume(self):
        from providers.codex import CodexProvider
        p = CodexProvider(home_path=os.path.join(self.tmp, ".codex"), binary=os.path.join(TOOLS, "fake-codex"),
                          workspace_root=os.path.join(self.tmp, "codex-agents"), include_native_agents=False,
                          register_native_agents=False, prefer_app_server=False)
        os.makedirs(os.path.join(self.tmp, "codex-agents"), exist_ok=True)   # the office makes it at agent sync
        t = p.test()
        self.assertTrue(t.get("ok"), t)
        self.assertEqual(t.get("protocol"), "exec")
        out = p.send_chat_message("main", "exec hello [[tool]]")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out.get("providerPath"), "exec")
        self.assertEqual(out.get("reply"), "Fake Codex reply 1: exec hello")
        self.assertIn("Thinking about: exec hello", out.get("thinking") or "")
        self.assertTrue(out.get("tools"), out)
        again = p.send_chat_message("main", "more", session_id=out["sessionId"])
        self.assertEqual(again.get("reply"), "Fake Codex reply 2: more")
        self.assertEqual(again.get("sessionId"), out["sessionId"])


def _stop_while_slow(test, send, interrupt, prefix):
    result = {}
    th = threading.Thread(target=lambda: result.update(send()), daemon=True)
    th.start()
    time.sleep(1.5)
    stop = interrupt()
    test.assertTrue(stop.get("ok"), stop)
    th.join(15)
    test.assertFalse(th.is_alive(), "the run ended after stop")
    test.assertFalse(result.get("ok"), result)
    test.assertNotIn("w40", result.get("reply", ""))
    return result


class ClaudeCode(_Scratch):
    def provider(self):
        from providers.claude_code import ClaudeCodeProvider
        return ClaudeCodeProvider(home_path=os.path.join(self.tmp, ".claude"), binary=os.path.join(TOOLS, "fake-claude"),
                                  workspace_root=os.path.join(self.tmp, "claude-agents"), include_native_agents=False,
                                  register_native_agents=False)

    def test_health_reply_tool_resume_and_session_file(self):
        p = self.provider()
        t = p.test()
        self.assertTrue(t.get("ok"), t)
        self.assertIn("main", [a.get("profile") for a in t.get("agents") or []])
        snaps = []
        out = p.send_chat_message("main", "hi claude [[tool]]", on_progress=snaps.append)
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out.get("reply"), "Fake Claude reply 1: hi claude")
        tools = out.get("tools") or []
        self.assertEqual([x.get("name") for x in tools], ["Bash"], tools)
        self.assertEqual(tools[0].get("arguments", {}).get("command"), "echo fake-tool-ok")
        self.assertIn("fake-tool-ok", str(tools[0].get("result") or ""))
        self.assertTrue(any(0 < len(x.get("reply") or "") < len(out["reply"]) for x in snaps), "partial text streamed")
        sid = out.get("sessionId")
        again = p.send_chat_message("main", "and again", session_id=sid)
        self.assertEqual(again.get("reply"), "Fake Claude reply 2: and again")
        self.assertEqual(again.get("sessionId"), sid)
        import glob
        files = glob.glob(os.path.join(self.tmp, ".claude", "projects", "*", sid + ".jsonl"))
        self.assertEqual(len(files), 1, files)
        bad = p.send_chat_message("main", "x", session_id="00000000-dead-4000-8000-000000000000")
        self.assertFalse(bad.get("ok"), bad)

    def test_stop_slow(self):
        p = self.provider()
        _stop_while_slow(self, lambda: p.send_chat_message("main", "long [[slow]]"), lambda: p.interrupt("main"), "Fake Claude")

    def test_error(self):
        out = self.provider().send_chat_message("main", "x [[error]]")
        self.assertFalse(out.get("ok"), out)


class OpenCode(_Scratch):
    def provider(self):
        from providers.opencode import OpenCodeProvider
        return OpenCodeProvider(home_path=os.path.join(self.tmp, ".config", "opencode"), binary=os.path.join(TOOLS, "fake-opencode"),
                                workspace_root=os.path.join(self.tmp, "opencode-agents"), enabled=True)

    def test_reply_tool_sessions_export_delete(self):
        p = self.provider()
        self.assertTrue(p.test().get("ok"))
        self.assertIn("main", [a.get("profile") for a in p.discover_agents()])
        att = os.path.join(self.tmp, "note.txt")
        open(att, "w").write("x")
        out = p.send_chat_message("main", "hey open [[tool]]")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out.get("reply"), "Fake OpenCode reply 1: hey open")
        self.assertEqual([x.get("name") for x in out.get("tools") or []], ["bash"])
        self.assertEqual((out.get("tools") or [{}])[0].get("status"), "done")
        sid = out.get("sessionId")
        self.assertTrue(sid.startswith("ses_fake"), sid)
        again = p.send_chat_message("main", "two", session_id=sid)
        self.assertEqual(again.get("reply"), "Fake OpenCode reply 2: two")
        lst = p.list_sessions("main")
        self.assertEqual([r.get("id") for r in lst.get("sessions") or []], [sid], lst)
        ex = p.export_session("main", sid)
        self.assertEqual(len(ex["session"]["messages"]), 4, ex)
        self.assertTrue(p.delete_session("main", sid).get("deleted"))
        self.assertEqual(p.list_sessions("main").get("sessions"), [])

    def test_stop_slow(self):
        p = self.provider()
        _stop_while_slow(self, lambda: p.send_chat_message("main", "long [[slow]]"), lambda: p.interrupt("main"), "Fake OpenCode")


class Antigravity(_Scratch):
    def provider(self):
        from providers.antigravity import AntigravityProvider
        return AntigravityProvider(home_path=os.path.join(self.tmp, ".gemini", "config"), binary=os.path.join(TOOLS, "fake-agy"),
                                   workspace_root=os.path.join(self.tmp, "antigravity-agents"), enabled=True)

    def test_health_agents_reply_conversation(self):
        p = self.provider()
        t = p.test()
        self.assertTrue(t.get("ok"), t)
        self.assertEqual([a.get("profile") for a in p.discover_agents()], ["gravity"])
        out = p.send_chat_message("gravity", "hello agy")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out.get("reply"), "Fake Antigravity reply 1: hello agy")
        cid = out.get("sessionId")
        self.assertTrue(cid.startswith("conv-fake-"), out)
        again = p.send_chat_message("gravity", "again", session_id=cid)
        self.assertEqual(again.get("reply"), "Fake Antigravity reply 2: again")

    def test_stop_slow(self):
        p = self.provider()
        _stop_while_slow(self, lambda: p.send_chat_message("gravity", "long [[slow]]"), lambda: p.interrupt("gravity"), "Fake Antigravity")


if __name__ == "__main__":
    unittest.main(verbosity=1)
