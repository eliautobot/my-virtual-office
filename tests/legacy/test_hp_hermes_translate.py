"""Hermes -> the universal chat (app/providers/hermes_translate.py, design 2.8).

The six recorded turns (tests/fixtures/hermes/run-*.json, a real Hermes 0.21.5 backend) each have their expected universal
list in tests/fixtures/hermes/universal/: made by MVW 9094's own translate.js over the same frames (fixed clock, its
Hermes-view ops left out except the title, requests shown as its chat.js shows them, `at`/`tat` offsets added), so this
pins parity with MVW. The rest are the rules one by one, and one check that app/chat-universal.js reads what comes out.
"""

import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "app"))

from providers import hermes_translate as ht  # noqa: E402
from providers.hermes_translate import Translator  # noqa: E402

FIX = os.path.join(ROOT, "tests", "fixtures", "hermes")
RUNS = ["run-approval", "run-clarify", "run-error", "run-interim", "run-think", "run-tool"]
T0 = 1792222000.0


def frames(name):
    with open(os.path.join(FIX, f"{name}.json"), encoding="utf-8") as fh:
        return json.load(fh)["frames"]


def replay(name, clock=lambda: T0):
    t = Translator("r1", clock=clock)
    out = []
    for fr in frames(name):
        if "request" in fr:
            out += t.request(fr["request"])
        elif fr.get("type"):
            out += t.feed(fr)
    return out, t


def deltas(out, key):
    return "".join(e[key] for e in out if e["type"] == "run.delta" and e.get(key))


def ev(t, typ, **payload):
    return t.feed({"type": typ, "payload": payload})


@pytest.mark.parametrize("name", RUNS)
def test_recorded_turn_gives_the_expected_universal_list(name):
    with open(os.path.join(FIX, "universal", f"{name}.json"), encoding="utf-8") as fh:
        expected = json.load(fh)
    out, t = replay(name)
    assert out == expected
    assert t.ended


@pytest.mark.parametrize("name", RUNS)
def test_offsets_count_what_streamed(name):
    out, _ = replay(name)
    at = tat = 0
    for e in out:
        if e["type"] == "run.delta" and "text" in e:
            assert e["at"] == at
            at += len(e["text"])
        elif e["type"] == "run.delta":
            assert e["tat"] == tat
            tat += len(e["thinking"])


def test_reasoning_streams_as_thinking_and_spinner_lines_are_not_said():
    out, _ = replay("run-think")
    assert deltas(out, "thinking") == "Let me think about this step by step."
    end = out[-1]
    assert end["type"] == "run.end" and end["status"] == "ok"
    assert end["text"].startswith("Stub reply") and "to: hello there" in end["text"] and "Paragraph 1:" in end["text"]
    assert end["thinking"] == "Let me think about this step by step."
    assert isinstance(end["tokensIn"], int) and isinstance(end["tokensOut"], int)
    assert end["model"] == "custom:stub-1"
    assert not any(e["type"] == "run.status" and any(x in e["phase"] for x in ("˘", "ಠ", "processing", "cogitating"))
                   for e in out)
    assert "Stub reply" not in end["thinking"], "reasoning.available that was the answer is not a second copy"
    assert any(e["type"] == "usage.update" and e.get("used", 0) > 0 and e.get("size") == 256000 for e in out)
    assert {"type": "native", "ev": {"op": "title", "text": end["title"]}} in out


def test_a_command_step_then_the_answer():
    out, _ = replay("run-tool")
    start = next(e for e in out if e["type"] == "tool.start")
    assert (start["name"], start["toolKind"], start["title"]) == ("terminal", "execute", "Terminal")
    assert start["input"].startswith("echo hello-from-tool")
    prep = next(i for i, e in enumerate(out) if e["type"] == "run.status" and e["phase"] == "Preparing Terminal")
    assert prep < out.index(start)
    end = next(e for e in out if e["type"] == "tool.end")
    assert (end["ok"], end["exitCode"], end["status"], end["text"]) == (True, 0, "completed", "hello-from-tool\nsecond-line")
    assert isinstance(end["ms"], int)
    assert out[-1]["type"] == "run.end" and "The tool answered" in out[-1]["text"]


def test_an_approval_with_four_choices_and_a_denied_step_is_blocked():
    out, t = replay("run-approval")
    rq = next(f["request"] for f in frames("run-approval") if "request" in f)
    a = next(e for e in out if e["type"] == "approval.requested")
    assert a["approvalId"] == rq["params"]["request_id"] and a["rpcId"] == rq["id"]
    assert (a["command"], a["summary"], a["title"]) == ("rm -rf /tmp/lab", "delete in root path", "Run a command")
    assert a["options"] == ["allow-once", "allow-session", "allow-always", "deny"]
    assert out[out.index(a) - 1] == {"type": "run.status", "phase": "Waiting for your approval"}
    end = next(e for e in out if e["type"] == "tool.end")
    assert (end["ok"], end["status"]) == (False, "blocked") and "did not run" in end["text"]
    assert t.request(rq) == [], "a request is shown once"


def test_clarify_questions_with_choices_and_a_free_answer():
    out, _ = replay("run-clarify")
    rq = next(f["request"] for f in frames("run-clarify") if "request" in f)
    q = next(e for e in out if e["type"] == "question.requested")
    assert q["questionId"] == rq["id"] and len(q["questions"]) == 2
    assert [o["label"] for o in q["questions"][0]["options"]] == ["Red (Recommended)", "Blue"]
    assert q["questions"][1]["options"] == [] and q["questions"][1]["other"] is True
    assert q["questions"][0]["header"] == "Question 1"
    assert not any(e["type"].startswith("tool.") for e in out), "the question card shows clarify: no step"
    assert ht.answer_for(rq, {"q0": ["Blue"], "q1": ["Nothing"]}) == {"answers": {"q0": "Blue", "q1": "Nothing"}}
    assert ht.answer_for(rq, None, True) == {}


def test_masked_prompts_are_secret_questions():
    s = ht.questions_of({"id": "x", "method": "secret", "params": {"env_var": "GITHUB_TOKEN", "prompt": "Your token"}})
    assert s == [{"questionId": "value", "header": "GITHUB_TOKEN", "question": "Your token", "options": [],
                  "secret": True, "other": True}]
    sudo = ht.questions_of({"id": "y", "method": "sudo", "params": {"command": "apt-get update"}})
    assert sudo[0]["secret"] is True and "apt-get update" in sudo[0]["question"]
    assert ht.answer_for({"method": "secret"}, {"value": ["abc"]}) == {"value": "abc"}
    assert ht.answer_for({"method": "sudo"}, {"value": "pw"}, cancel=True) == {"value": ""}
    t = Translator()
    assert t.request({"id": "z", "method": "theme.set", "params": {}}) == []
    assert t.request({"id": "c", "method": "clarify", "params": {"questions": []}}) == []


def test_a_model_that_keeps_failing_says_its_retries_and_ends_with_its_error():
    out, _ = replay("run-error")
    assert any(e["type"] == "run.status" and "Provider temporarily unavailable" in e["phase"] for e in out)
    end = out[-1]
    assert end["type"] == "run.end" and end["status"] == "error" and end["error"]


def test_interim_commentary_is_sealed_and_the_answer_a_paragraph_apart():
    t = Translator(clock=lambda: T0)
    out = ev(t, "message.start")
    out += ev(t, "message.delta", text="Let me look.")
    out += ev(t, "message.interim", text="Let me look.", already_streamed=True)
    out += ev(t, "tool.start", tool_id="a", name="read_file", args={"path": "/x"})
    out += ev(t, "tool.complete", tool_id="a", result={"content": "hi"})
    out += ev(t, "message.interim", text="Found it.", already_streamed=False)
    out += ev(t, "message.delta", text="Done")
    out += ev(t, "message.complete", text="Done", status="complete")
    texts = [e for e in out if e["type"] == "run.delta"]
    assert [(e["text"], e["at"]) for e in texts] == [("Let me look.", 0), ("\n\nFound it.", 12), ("\n\nDone", 23)]
    assert out[-1]["text"] == "Let me look.\n\nFound it.\n\nDone"
    step = next(e for e in out if e["type"] == "tool.start")
    assert (step["toolKind"], step["input"], step["title"]) == ("read", "/x", "Read file")


def test_media_lines_leave_the_text_except_in_code_blocks():
    t = Translator()
    ev(t, "message.delta", text="Here is the chart:\nMEDIA:/tmp/chart.png\n")
    end = ev(t, "message.complete", text="Here is the chart:\nMEDIA:/tmp/chart.png", status="complete",
             usage={"model": "gpt-x", "input": 3, "output": 4, "cost_usd": 0.0012})[-1]
    assert end["text"] == "Here is the chart:"
    assert end["media"] == [{"kind": "image", "name": "chart.png", "ref": {"source": "/tmp/chart.png"}}]
    assert (end["model"], end["tokensIn"], end["tokensOut"], end["cost"]) == ("gpt-x", 3, 4, 1200)
    text, media = ht.split_media("a\n```\nMEDIA:/x.png\n```\n MEDIA: `/v/clip.mp4` \n![plot](https://e.org/p.webp)\nb")
    assert text == "a\n```\nMEDIA:/x.png\n```\nb"
    assert [(m["kind"], m["name"], m["ref"]["source"]) for m in media] == [
        ("video", "clip.mp4", "/v/clip.mp4"), ("image", "p.webp", "https://e.org/p.webp")]
    assert ht.split_media("see ![x](https://e.org/a.png) inline")[1] == [], "an image inside a sentence stays text"
    assert ht.merge_media(media, media[:1]) == media


def test_stopped_failed_and_interrupted_runs():
    t = Translator()
    ev(t, "message.start")
    ev(t, "message.delta", text="half")
    end = ev(t, "message.complete", status="interrupted")[-1]
    assert (end["status"], end["text"]) == ("stopped", "half")
    t = Translator()
    end = ev(t, "message.complete", status="error", error="HTTP 500: stub error 500")[-1]
    assert end["status"] == "error" and "500" in end["error"]
    t = Translator()
    assert ev(t, "error", message="boom")[-1] == {"type": "run.end", "status": "error", "text": "", "ms": 0,
                                                 "error": "boom"}
    t = Translator()
    ev(t, "message.delta", text="part")
    end = t.interrupt("The connection to Hermes was lost.")[-1]
    assert (end["status"], end["error"], end["text"]) == ("interrupted", "The connection to Hermes was lost.", "part")
    assert ev(t, "message.delta", text="late") == [] and t.interrupt("again") == [], "nothing after the end"
    assert ht.steered_events() == [{"type": "run.start"},
                                   {"type": "run.end", "status": "ok", "text": "", "steered": True}]


def test_thinking_delta_is_never_text_only_explained_waits_are_said():
    t = Translator()
    out = ev(t, "message.start")
    out += ev(t, "thinking.delta", text="(´･_･`) mulling...")
    out += ev(t, "thinking.delta", text="⏳ waiting on provider, retrying in 2s (attempt 1/3)")
    out += ev(t, "thinking.delta", text="⚠️ rate limited by the provider")
    out += ev(t, "status.update", kind="lifecycle", text="⏳ Provider temporarily unavailable, retrying in 18s")
    out += ev(t, "status.update", kind="compacting", text="Compressing…")
    out += ev(t, "status.update", kind="tip", text="a tip")
    assert [e["phase"] for e in out] == ["Thinking", "waiting on provider, retrying in 2s (attempt 1/3)",
                                         "rate limited by the provider",
                                         "Provider temporarily unavailable, retrying in 18s",
                                         "Compacting the conversation"]
    assert all(e["type"] == "run.status" for e in out)
    assert ht.wait_text("( ˘⌣˘)♡ processing...") == ""
    assert ht.wait_text("⏳ still waiting on the provider (40s)") == "still waiting on the provider (40s)"


def test_reasoning_available_is_held():
    # the answer was it: dropped
    t = Translator()
    ev(t, "reasoning.available", text="The answer is 4.")
    out = ev(t, "message.complete", text="The answer is 4.", status="complete")
    assert "thinking" not in out[-1] and not any(e["type"] == "run.delta" for e in out)
    # the answer is something else: shown as thinking
    t = Translator()
    ev(t, "reasoning.available", text="Adding two and two.")
    out = ev(t, "message.complete", text="4", status="complete")
    assert out[0] == {"type": "run.delta", "thinking": "Adding two and two.", "tat": 0}
    assert out[-1]["thinking"] == "Adding two and two."
    # a tool starts: it was reasoning
    t = Translator()
    ev(t, "reasoning.available", text="I will list files.")
    out = ev(t, "tool.start", tool_id="1", name="terminal", context="ls")
    assert out[0]["thinking"] == "I will list files." and out[1]["type"] == "tool.start"
    # the answer or reasoning already has words: never
    t = Translator()
    ev(t, "message.delta", text="Hi")
    ev(t, "reasoning.available", text="Hi")
    assert "thinking" not in ev(t, "message.complete", text="Hi there", status="complete")[-1]


def test_card_tools_and_the_tool_call_wrapper():
    t = Translator()
    out = ev(t, "tool.generating", name="tool_call")
    out += ev(t, "tool.generating", name="todo")
    out += ev(t, "tool.start", tool_id="c1", name="web_search", context="cats", args={"query": "cats"})
    out += ev(t, "tool.start", tool_id="c2", name="todo_list", args={"todos": []})
    out += ev(t, "tool.complete", tool_id="c2", result="ok")
    assert [e["type"] for e in out] == ["tool.start"]
    assert (out[0]["name"], out[0]["toolKind"], out[0]["input"], out[0]["raw"]) == (
        "web_search", "search", "cats", '{"query":"cats"}')
    assert ht.unwrap("tool_call", {"calls": [{"name": "web_search", "arguments": {"q": 1}}]}) == ("web_search", {"q": 1})
    assert ht.unwrap("tool_call", {"calls": [{"name": "a"}, {"name": "b"}]})[0] == "tool_call"
    h = ht.history_to_messages([
        {"role": "user", "content": "q", "active": 1},
        {"role": "assistant", "content": "", "active": 1, "tool_calls": [
            {"id": "c1", "function": {"name": "tool_call", "arguments": json.dumps(
                {"calls": [{"name": "web_search", "arguments": {"query": "cats"}}]})}},
            {"id": "c2", "function": {"name": "tool_call", "arguments": json.dumps(
                {"calls": [{"name": "todo_list", "arguments": {"todos": []}}]})}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "found", "active": 1},
        {"role": "assistant", "content": "done", "active": 1}])
    assert h[1]["meta"]["steps"] == [{"id": "c1", "name": "web_search", "title": "Web search", "kind": "search",
                                      "input": '{"query":"cats"}', "output": "found", "ok": True}]


def test_tool_titles_kinds_and_results():
    assert [ht.tool_kind(n) for n in ("terminal", "read_file", "search_files", "patch", "web_search",
                                      "browser_navigate", "delegate_task", "vision_analyze", "delete_thing", "x")] == [
        "execute", "read", "search", "edit", "search", "fetch", "think", "read", "delete", "other"]
    assert ht.tool_title("mcp_github_create_issue") == "Github create issue"
    assert ht.tool_title("terminal", [{"text": " Run ls "}]) == "Run ls"
    assert ht.result_of('{"output":"x","exit_code":2,"error":null}') == {"text": "x", "ok": False, "exitCode": 2,
                                                                       "blocked": False}
    assert ht.result_of({"output": "", "error": "boom"})["text"] == "boom"
    assert ht.result_of({"output": "out", "error": "err"})["text"] == "out\nerr"
    assert ht.result_of("plain") == {"text": "plain", "ok": True}
    t = Translator()
    ev(t, "tool.start", tool_id="p", name="patch", args={"path": "a.py", "old": "1", "new": "2"})
    end = ev(t, "tool.complete", tool_id="p", result={"output": "ok"}, inline_diff="-1\n+2", duration_s=0.0125)[0]
    assert (end["text"], end["ms"], end["title"]) == ("ok\n-1\n+2", 13, "Patch")
    big = ev(Translator(), "tool.complete", tool_id="q", name="terminal", result={"output": "y" * 5000})[-1]
    assert big["type"] == "tool.end" and big["text"] == "y" * 4000 + "\n…"


def test_todo_list_is_the_plan_card():
    t = Translator(clock=lambda: T0)
    out = ev(t, "todo.updated", todos=[{"id": "a", "content": "Look", "status": "completed"},
                                       {"id": "b", "content": "Fix", "status": "in_progress"},
                                       {"id": "c", "content": "Skip", "status": "cancelled"}, {"id": "d", "content": "Ship"}],
             revision=2)
    assert out == [{"type": "plan.update", "title": "Tasks", "revision": 2, "updatedAt": int(T0 * 1000), "steps": [
        {"step": "Look", "status": "completed"}, {"step": "Fix", "status": "in_progress"},
        {"step": "Skip (cancelled)", "status": "completed"}, {"step": "Ship", "status": "pending"}]}]


def test_usage_model_and_effort():
    t = Translator()
    ev(t, "session.info", model="claude-x", provider="anthropic", reasoning_effort="high")
    assert ev(t, "session.usage", context_used=100, context_max=1000, cost_usd=0.5) == [
        {"type": "usage.update", "used": 100, "size": 1000, "cost": 500000}]
    assert ev(t, "session.usage", foo=1) == []
    end = ev(t, "message.complete", text="ok", status="complete", usage={"model": "claude-x", "input": 1, "output": 2})[-1]
    assert (end["model"], end["effort"]) == ("anthropic:claude-x", "high")


def test_withdrawn_requests_resolve_their_cards():
    t = Translator()
    appr = {"id": "srq-1", "method": "approval", "params": {"request_id": "ap-1", "command": "rm x",
                                                              "choices": ["once", "deny"]}}
    assert t.request(appr)[-1]["options"] == ["allow-once", "deny"]
    assert ev(t, "approval.cancelled", request_ids=["ap-1"], reason="stopped") == [
        {"type": "approval.resolved", "approvalId": "ap-1", "approved": False, "decision": "cancelled"}]
    t.request({"id": "srq-2", "method": "clarify", "params": {"questions": [{"qid": "q0", "question": "?"}]}})
    assert ev(t, "request.cancel", id="srq-2", reason="timeout") == [
        {"type": "question.resolved", "questionId": "srq-2", "status": "expired"}]
    t.request({"id": "srq-3", "method": "secret", "params": {"env_var": "K"}})
    t.answered("srq-3")
    assert ev(t, "request.cancel", id="srq-3", reason="x") == [], "answered here: nothing to withdraw"
    assert ev(t, "request.cancel", id="other", reason="x") == [], "another client's request"
    assert ht.choice_for("allow-session") == "session" and ht.choice_for("nope") is None
    tool = ht.approval_of({"id": "r", "method": "approval", "params": {"tool_name": "write_file", "choices": ["bad"]}})
    assert (tool["title"], tool["options"]) == ("Allow Write file", ["allow-once", "deny"])


def test_history_rows():
    rows = [
        {"id": 1, "role": "user", "content": "list files", "timestamp": 1, "active": 1},
        {"id": 2, "role": "assistant", "content": "", "reasoning_content": "I should use ls.", "timestamp": 2,
         "active": 1, "tool_calls": [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"ls"}'}}]},
        {"id": 3, "role": "tool", "tool_call_id": "c1", "content": '{"output":"a\\nb","exit_code":0,"error":null}',
         "timestamp": 3, "active": 1},
        {"id": 4, "role": "assistant", "content": "Two files.\nMEDIA:/tmp/x.mp4", "timestamp": 4, "active": 1},
        {"id": 5, "role": "user", "content": "scaffold", "display_kind": "hidden", "timestamp": 5, "active": 1},
        {"id": 6, "role": "user", "content": "gone", "timestamp": 6, "active": 0},
        {"id": 7, "role": "system", "content": "summary", "display_kind": "compaction", "timestamp": 7, "active": 1},
        {"id": 8, "role": "user", "content": "go on", "display_kind": "continuation", "timestamp": 8, "active": 1},
        {"id": 9, "role": "user", "content": [{"type": "text", "text": "hi "}, {"type": "image_url"},
                                              {"type": "input_text", "text": "there"}], "timestamp": 9, "active": 1},
    ]
    h = ht.history_to_messages(rows)
    assert h[0] == {"role": "user", "text": "list files", "ts": 1000, "meta": {"row": 1}}
    a = h[1]
    assert (a["text"], a["ts"], a["meta"]["thinking"], a["meta"]["upto"]) == ("Two files.", 2000, "I should use ls.", 4)
    assert a["meta"]["steps"] == [{"id": "c1", "name": "terminal", "title": "Terminal", "kind": "execute",
                                   "input": "ls", "output": "a\nb", "ok": True, "exitCode": 0}]
    assert a["meta"]["media"] == [{"kind": "video", "name": "x.mp4", "ref": {"source": "/tmp/x.mp4"}}]
    assert h[2] == {"role": "system", "text": "The conversation was compacted here.", "ts": 7000, "status": "compaction"}
    assert h[3] == {"role": "system", "text": "go on", "ts": 8000, "status": "continuation"}
    assert h[4]["text"] == "hi there"
    assert len(h) == 5


def test_skill_invocation_text_back_to_the_command():
    single = ('[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. '
              "The full skill content is loaded below.]\n\nBody that quotes The user has provided the following "
              "instruction alongside the skill invocation: no\n\nThe user has provided the following instruction "
              "alongside the skill invocation: fix   the leak\n\n[Runtime note: x]")
    assert ht.skill_invocation_text(single) == "/work fix the leak"
    assert ht.skill_invocation_text('[IMPORTANT: The user has invoked the "work" skill. The full skill content is '
                                    "loaded below.]\n\nbody") == "/work"
    bundle = ('[IMPORTANT: The user has invoked the "/ship" skill bundle, ...]\nUser instruction: now please'
              "\n\n[Loaded as part of the bundle]")
    assert ht.skill_invocation_text(bundle) == "/ship now please"
    assert ht.skill_invocation_text("hello") is None
    h = ht.history_to_messages([{"id": 4, "role": "user", "content": single, "timestamp": 1},
                                {"id": 5, "role": "assistant", "content": "ok", "timestamp": 2}])
    assert h[0]["meta"] == {"row": 4, "skill": True} and h[0]["text"] == "/work fix the leak"


def test_stopped_turns_come_from_the_live_transcript():
    rows = [{"id": 1, "role": "user", "content": "go on", "active": 1},
            {"id": 2, "role": "assistant", "content": "", "display_kind": "hidden", "active": 1},
            {"id": 3, "role": "user", "content": "next", "active": 1}]
    assert ht.needs_live_rows(rows, running=False) is True
    assert [m["role"] for m in ht.history_to_messages(rows)] == ["user", "user"]
    live = [{"row_id": 2, "role": "assistant", "text": "Paragraph 1: half of it"},
            {"row_id": 4, "role": "assistant", "text": "not stored yet", "reasoning": "r", "timestamp": 9},
            {"row_id": 3, "role": "user", "text": "next"}]
    h = ht.history_to_messages(rows, live)
    assert [(m["role"], m["text"]) for m in h] == [("user", "go on"), ("assistant", "Paragraph 1: half of it"),
                                                    ("user", "next"), ("assistant", "not stored yet")]
    assert h[-1]["meta"]["thinking"] == "r" and h[-1]["ts"] == 9000
    done = [{"id": 1, "role": "user", "content": "q", "active": 1}, {"id": 2, "role": "assistant", "content": "a"}]
    assert ht.needs_live_rows(done, running=False) is False
    assert ht.needs_live_rows(done[:1], running=True) is False
    assert ht.needs_live_rows(done[:1], running=False) is True


def test_models_picker_effort_sessions_commands():
    m = ht.models_to_picker({"model": "stub-1", "provider": "custom", "providers": [
        {"slug": "custom", "name": "Custom", "is_current": True, "models": ["stub-1"],
         "capabilities": {"stub-1": {"reasoning": False}}},
        {"slug": "anthropic", "name": "Anthropic", "authenticated": True, "models": ["claude-x", "old"],
         "unavailable_models": ["old"], "capabilities": {"claude-x": {"reasoning": True, "can_disable_reasoning": True}}},
        {"slug": "openai", "name": "OpenAI", "authenticated": False, "models": ["gpt"]}]})
    assert m["default"] == "custom:stub-1"
    assert [x["id"] for x in m["models"]] == ["custom:stub-1", "anthropic:claude-x"]
    assert m["models"][1]["label"] == "claude-x · Anthropic"
    assert [x["id"] for x in m["models"][1]["effort"]] == ["none", "minimal", "low", "medium", "high", "xhigh"]
    assert m["models"][1]["effort"][0] == {"id": "none", "label": "Off"} and "effort" not in m["models"][0]
    assert ht.models_to_picker(None) == {"default": None, "models": []}
    assert [x["id"] for x in ht.effort_choices()] == list(ht.EFFORT_LEVELS)
    assert ht.parse_model_ref("openrouter:anthropic/claude-x") == {"provider": "openrouter", "model": "anthropic/claude-x"}
    assert ht.model_ref("nous", "hermes-5") == "nous:hermes-5"
    assert ht.session_of({"id": "20261017_1", "title": "Plan the trip", "source": "telegram", "model": "m",
                          "last_activity_at": 1792220000, "message_count": 4}) == {
        "key": "20261017_1", "title": "Plan the trip", "updatedAt": 1792220000000, "model": "m", "source": "telegram",
        "messages": 4}
    assert ht.session_of({"id": "x", "preview": "p" * 90})["title"] == "p" * 60
    c = ht.commands_of({"categories": [{"name": "Session", "pairs": [
        ["/new", "Start a new session (usage: /new [name])"], ["/model", "Switch model (usage: /model <provider:model>)"]]}],
        "pairs": [["/new", "dup"], ["nope", "x"]]})
    assert [x["name"] for x in c] == ["new", "model"]
    assert c[0]["description"] == "Start a new session" and c[0]["args"] == []
    assert c[1]["args"][0]["name"] == "provider:model" and c[1]["args"][0]["required"] is True


def test_side_answers():
    assert ht.side_of({"type": "btw.complete", "payload": {"task_id": "btw_1", "question": "q?", "text": "a.", "x": 1}}) \
        == {"op": "side", "kind": "btw", "id": "btw_1", "question": "q?", "text": "a."}
    assert ht.side_of({"type": "background.complete", "payload": {"task_id": "bg_1", "text": "done"}}) == {
        "op": "side", "kind": "bg", "id": "bg_1", "text": "done"}
    assert ht.side_of({"type": "review.summary", "payload": {"text": "💾 Self-improvement review: Memory updated"}}) == {
        "op": "side", "kind": "review", "text": "Self-improvement review: Memory updated"}
    assert ht.side_of({"type": "message.complete", "payload": {}}) is None


CHAT_UNIVERSAL_CHECK = r"""
const U = require(process.argv[1]);
const frames = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const t = U.createTranslator({ onGap: () => { throw new Error('gap'); } });
const kinds = [];
let seq = 0;
for (const name of Object.keys(frames)) for (const e of frames[name]) {
  if (U.route({ event: e }) !== 'turn') { kinds.push(name + ':' + U.route({ event: e })); continue; }
  for (const k of t.toReducer({ seq: ++seq, run: name, event: e })) kinds.push(name + ':' + k.kind);
}
process.stdout.write(JSON.stringify(kinds));
"""


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_chat_universal_reads_what_comes_out():
    frames_by_run = {}
    for name in ("run-approval", "run-clarify", "run-tool"):
        frames_by_run[name] = replay(name)[0]
    t = Translator()
    ev(t, "message.delta", text="x")
    frames_by_run["stopped"] = ev(t, "message.complete", status="interrupted")
    frames_by_run["lost"] = Translator().interrupt("lost")
    res = subprocess.run(["node", "-e", CHAT_UNIVERSAL_CHECK, os.path.join(ROOT, "app", "chat-universal.js")],
                         input=json.dumps(frames_by_run), capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr[-400:]
    kinds = json.loads(res.stdout)
    for want in ("run-approval:status", "run-approval:tool.start", "run-approval:approval", "run-approval:tool.result",
                 "run-approval:text.delta", "run-approval:usage", "run-approval:native", "run-approval:run.complete",
                 "run-clarify:question", "run-clarify:run.complete", "run-tool:tool.result", "stopped:run.cancelled",
                 "lost:run.failed"):
        assert want in kinds, want
