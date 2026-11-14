"""Office life end to end (L10) on a PRIVATE office started by tests/tools/life-e2e.sh.

Skipped unless LIFE_E2E=1 and the stack answers (LIFE_E2E_ROOT/env, default /tmp/vo8096-l10/env), so the offline
suite (tests/run_all.sh) never needs it. The stack is a private server from
this tree with the test injector, a fake OpenClaw gateway (this file run with --fake-gateway, controlled over a
loopback HTTP port) and the private lab Hermes (tests/tools/lab-hermes.sh, stub model). Nothing here reaches a real
office, gateway or Hermes.

Run:  tests/tools/life-e2e.sh start && LIFE_E2E=1 LIFE_QA_LOG=/tmp/qa.md python3 -m pytest -q tests/test_life_e2e.py
      tests/tools/life-e2e.sh stop
v0.11 layer mode: LIFE_PL=1 tests/tools/life-e2e.sh start (the REAL lab OpenClaw gateway + lab Hermes, both reached
through the copied provider layer after a 0.10.1 -> 0.11 upgrade); the OpenClaw cases then run TestOpenClawLayer
(runs the office starts, runs the lab CLI starts in a telegram session, a cron job, a spawned subagent, sessions_send)
instead of the fake-gateway TestOpenClaw, and Hermes turns go through /api/providers/*.
Page checks: node tests/e2e/life_page.mjs desktop|phone|tabs|settings|tz|paper ; perf: node tests/e2e/life_perf.mjs
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "helpers"))

# ── fake gateway controller (python3 tests/test_life_e2e.py --fake-gateway PORTFILE CTLPORT) ───────────────────
INFERENCE_METHODS = ("agent", "chat.send", "sessions.send", "sessions.spawn", "agent.run", "responses.create")


def serve_fake_gateway(port_file: str, ctl_port: int) -> None:
    from fake_gateway import FakeGateway

    gw = FakeGateway().start()
    gw.events += ["cron", "session.message", "session.tool", "agent.activity"]
    approvals: list = []
    gw.handlers["exec.approval.list"] = lambda p, s: list(approvals)
    gw.handlers["sessions.list"] = lambda p, s: {"sessions": []}
    gw.handlers["cron.list"] = lambda p, s: {"jobs": []}
    gw.handlers["health"] = lambda p, s: {"ok": True, "version": gw.version}

    class Ctl(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, obj, code=200):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/calls"):
                with gw._lock:
                    methods = [r.get("method") for r in gw.requests]
                counts: dict = {}
                for m in methods:
                    counts[m] = counts.get(m, 0) + 1
                return self._send({"counts": counts, "inference": sum(counts.get(m, 0) for m in INFERENCE_METHODS),
                                   "connections": len(gw._sockets)})
            return self._send({"error": "no"}, 404)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if self.path == "/emit":
                for item in body.get("events") or [body]:
                    gw.emit(item["event"], item.get("payload") or {})
                return self._send({"ok": True})
            if self.path == "/approvals":
                approvals[:] = body.get("rows") or []
                return self._send({"ok": True})
            if self.path == "/drop":
                gw.drop()
                return self._send({"ok": True})
            return self._send({"error": "no"}, 404)

    srv = ThreadingHTTPServer(("127.0.0.1", ctl_port), Ctl)
    with open(port_file + ".tmp", "w") as fh:
        fh.write(str(gw.port))
    os.replace(port_file + ".tmp", port_file)
    print(f"fake gateway ws://127.0.0.1:{gw.port} ctl http://127.0.0.1:{ctl_port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__" and len(sys.argv) >= 4 and sys.argv[1] == "--fake-gateway":
    serve_fake_gateway(sys.argv[2], int(sys.argv[3]))
    sys.exit(0)


# ── client side of the stack ─────────────────────────────────────────────────────────────────────────────────────
def _stack_env() -> dict:
    path = os.path.join(os.environ.get("LIFE_E2E_ROOT") or "/tmp/vo8096-l10", "env")
    env = {}
    try:
        with open(path) as fh:
            for line in fh:
                if line.startswith("export "):
                    for part in line[7:].split():
                        k, _, v = part.partition("=")
                        env[k] = v
    except OSError:
        return {}
    return env


ENV = _stack_env()
VO = ENV.get("VO_URL", "")
CTL = ENV.get("LIFE_GW_CTL", "")
ROOT = ENV.get("LIFE_E2E_ROOT", "/tmp/vo8096-l10")
LAB = ENV.get("LAB", "")
LAYER_PATHS = ("/api/pl/", "/api/providers", "/api/chat-sessions", "/api/connections", "/api/agent-providers",
               "/api/chat/")
PL = ENV.get("LIFE_PL") == "1"          # v0.11: OpenClaw and Hermes through the copied provider layer, lab gateway
LAB_OC = ENV.get("LAB_OC", "")
OC_PORT = ENV.get("LIFE_OC_PORT", "")
for _real in (":8085", ":8088", ":8090", ":8095", ":8096", ":8099"):
    assert not VO.endswith(_real), "refusing a real office"


def http(method: str, url: str, body=None, timeout: float = 20, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    # (the layer's routes take a script's call without a page's CSRF token: no Origin there, as a script sends none)
    layer = PL and url.startswith(VO) and url[len(VO):].split("?")[0].startswith(LAYER_PATHS)
    if VO and url.startswith(VO) and not layer:
        req.add_header("Origin", VO)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode(errors="replace"))
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, raw.decode(errors="replace")


def api(path: str, body=None, method=None, **kw):
    return http(method or ("POST" if body is not None else "GET"), VO + path, body, **kw)


def layer_id(office_id, timeout=60.0):
    """The layer agent id of an office agent (layer mode), waiting for the layer's first sync."""
    def find():
        out = api("/api/pl/agents")[1]
        rows = out.get("agents") if isinstance(out, dict) else None
        return next((r["id"] for r in rows or [] if r.get("officeId") == office_id), None)
    return wait_for(find, timeout, 1.0)


def office_run(agent, text, session=""):
    """One chat turn the office starts: (run id, the provider's session key). Layer mode: /api/providers/runs."""
    if not PL:
        code, out = api("/api/agent-chat/runs", {"agent": agent, "text": text, "session": session}, timeout=30)
        assert code == 200, out
        return out["runId"], out["session"]["key"]
    lid = layer_id(agent)
    assert lid, f"no layer agent for {agent}"
    code, out = api("/api/chat-sessions/create", {"agent": lid, "label": f"life e2e {time.time():.3f}"})
    assert code == 200, out
    code, run = api("/api/providers/runs", {"agent": lid, "session": out["session"]["id"], "input": text}, timeout=30)
    assert code == 200, run
    return run["runId"], run["session"]["key"]


def answer_card(agent, key, run, ref, decision=None, answers=None):
    """Answer an approval (decision) or a question (answers) of an office run."""
    if PL:
        if answers is not None:
            # (the layer takes {question id: [answers]}; "0", "1" ... are the questions in order, as 0.10 took them)
            evs = api(f"/api/providers/runs/events?run={run}&since=0")[1]
            asked = next((e for e in (evs.get("events") if isinstance(evs, dict) else None) or []
                          if (e.get("event") or e).get("type") == "question.requested"
                          and (e.get("event") or e).get("questionId") == ref), None)
            qs = [q.get("questionId") for q in ((asked or {}).get("event") or asked or {}).get("questions") or []]
            by_id = {(qs[int(k)] if k.isdigit() and int(k) < len(qs) else k): v if isinstance(v, list) else [v]
                     for k, v in answers.items()}
            return api("/api/providers/questions", {"run": run, "question": ref, "answers": by_id}, timeout=30)
        return api("/api/providers/approvals", {"run": run, "approval": ref, "decision": decision}, timeout=30)
    if answers is not None:
        return api("/api/agent-chat/questions", {"agent": agent, "session": key, "run": run, "question": ref,
                                                 "answers": answers}, timeout=30)
    return api("/api/agent-chat/approvals", {"agent": agent, "session": key, "run": run, "approval": ref,
                                             "decision": decision}, timeout=30)


def lab_oc(*args, timeout=60, background=False):
    """The openclaw CLI against the LAB gateway only (tests/tools/lab-openclaw.sh cli)."""
    import subprocess
    env = dict(os.environ, LAB=LAB_OC, LAB_OC_PORT=OC_PORT, LAB_OC_STUB=str(int(OC_PORT or 0) + 1))
    cmd = [os.path.join(HERE, "tools", "lab-openclaw.sh"), "cli", *args]
    if background:
        return subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                start_new_session=True)
    out = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    return out.stdout


def lab_json(*args, timeout=60):
    text = lab_oc(*args, "--json", timeout=timeout)
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0] or [0])
    try:
        return json.loads(text[start:])
    except ValueError:
        return None


def inject(*events, **action):
    """POST /api/office-life/test-event (loopback + VO_LIFE_TEST_INJECT only)."""
    body = dict(action) if action else {"events": list(events)}
    code, out = api("/api/office-life/test-event", body)
    assert code == 200, (code, out)
    return out


def gw(path: str, body=None):
    return http("POST" if body is not None else "GET", CTL + path, body)[1]


def emit(event: str, payload: dict):
    return gw("/emit", {"event": event, "payload": payload})


def stub_calls() -> int:
    """LLM calls the lab's stub model answered (one log line per call)."""
    try:
        with open(os.path.join(LAB, "stub.log")) as fh:
            return sum(1 for line in fh if " stream=" in line)
    except OSError:
        return 0


def gateway_inference() -> int:
    return int(gw("/calls").get("inference") or 0)


def journal_text() -> str:
    out = []
    base = os.path.join(ROOT, "data", "office-life")
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            try:
                with open(os.path.join(dirpath, name), encoding="utf-8", errors="replace") as fh:
                    out.append(fh.read())
            except OSError:
                pass
    return "\n".join(out)


class Stream:
    """One /api/office-life/stream reader on its own thread; frames kept in order."""

    def __init__(self, since=None):
        self.frames: list = []
        self.raw: list = []
        self.lines = 0
        self.heartbeats = 0
        self.ids = 0
        self._stop = False
        if since is None:
            since = api("/api/office-life/state")[1].get("seq")
        self.since = since
        self._res = urllib.request.urlopen(f"{VO}/api/office-life/stream?since={since}", timeout=120)
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _run(self):
        try:
            for raw in self._res:
                if self._stop:
                    break
                line = raw.decode(errors="replace").rstrip("\n")
                self.lines += 1
                if line.startswith("data:"):
                    try:
                        frame = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    ev = frame.get("event") if isinstance(frame.get("event"), dict) else frame
                    self.raw.append(frame)
                    self.frames.append(ev)
                elif line.startswith(":"):
                    self.heartbeats += 1
                elif line.startswith("id:"):
                    self.ids += 1
        except Exception:
            pass

    def of(self, kind, **match):
        return [f for f in self.frames if f.get("type") == kind and all(f.get(k) == v for k, v in match.items())]

    def wait(self, kind, timeout=10.0, **match):
        end = time.time() + timeout
        while time.time() < end:
            got = self.of(kind, **match)
            if got:
                return got
            time.sleep(0.1)
        return []

    def close(self):
        self._stop = True
        try:
            self._res.close()
        except Exception:
            pass


def wait_for_no_standup(timeout=15.0):
    """An idle office: a stand-up still running from an earlier check is ended by a tick past its end."""
    running = lambda: bool((api("/api/office-life/state")[1].get("open") or {}).get("standup"))
    if not running():
        return True
    inject(action="tick", now=time.time() + 3600)
    return wait_for(lambda: not running(), timeout, 0.5)


def stack_tool_env() -> dict:
    """Environment for tests/tools/life-e2e.sh so it acts on THIS stack (ports from the env file)."""
    env = dict(os.environ, LIFE_E2E_ROOT=ROOT)
    for key in ("LIFE_PORT", "LIFE_GW_CTL_PORT", "LAB_PORT_A", "LAB_PORT_B", "LAB_PORT_STUB"):
        if ENV.get(key):
            env[key] = ENV[key]
    if ENV.get("LIFE_GW_CTL_PORT"):
        env["LIFE_GW_CTL"] = ENV["LIFE_GW_CTL_PORT"]
    if not ENV.get("LIFE_PORT") and VO.rsplit(":", 1)[-1].isdigit():
        env["LIFE_PORT"] = VO.rsplit(":", 1)[-1]
    return env


def wait_for(check, timeout=10.0, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        value = check()
        if value:
            return value
        time.sleep(step)
    return check()


QA_LOG = os.environ.get("LIFE_QA_LOG", "")


def note(line: str) -> None:
    """One evidence line per check into the QA log (when LIFE_QA_LOG is set)."""
    if QA_LOG:
        with open(QA_LOG, "a") as fh:
            fh.write("- " + line.replace("\n", " ")[:400] + "\n")


def _stack_up() -> bool:
    if os.environ.get("LIFE_E2E") != "1" or not (VO and CTL and LAB):
        return False
    try:
        return http("GET", VO + "/api/office-life/state", timeout=3)[0] == 200
    except Exception:
        return False


@unittest.skipUnless(_stack_up(), "set LIFE_E2E=1 with the stack running (tests/tools/life-e2e.sh start)")
class LifeCase(unittest.TestCase):
    maxDiff = 2000

    def setUp(self):
        self.stream = Stream()
        self.addCleanup(self.stream.close)

    def check(self, name, ok, evidence="", owner=""):
        note(f"{'PASS' if ok else 'FAIL'} {name}: {evidence}" + ("" if ok or not owner else f" (owner {owner})"))
        self.assertTrue(ok, f"{name}: {evidence}")


HERMES = "hermes-lab-a"


class TestHermesServe(LifeCase):
    @classmethod
    def setUpClass(cls):
        # Right after a (re)start the office still discovers the lab Hermes agent; wait for it (Q-11).
        wait_for(lambda: HERMES in (api("/status")[1] or {}), 60, 1.0)

    def chat_run(self, text, agent=HERMES, session=""):
        return office_run(agent, text, session)

    def wait_idle(self, agent=HERMES, timeout=40):
        return wait_for(lambda: api("/status")[1].get(agent, {}).get("state") in ("idle", "finishing"), timeout, 0.5)

    def test_1_approval_sign_opens_and_clears_when_answered(self):
        os.makedirs(os.path.join(ROOT, "scratch"), exist_ok=True)
        run, key = self.chat_run('[[tool:terminal {"command":"rm -rf %s/scratch"}]] clean up' % ROOT)
        opened = self.stream.wait("needs.open", 25, agent=HERMES)
        ok = bool(opened) and opened[0].get("need") == "approval" and opened[0].get("session") == key
        self.check("hermes serve: approval -> needs.open approval with the chat session", ok, json.dumps(opened)[:200],
                   "app/office_life/sources.py")
        appr = opened[0]["ref"] if opened else ""
        time.sleep(6)       # longer than the 3.6 s gone-close seen with an offline roster
        closed_early = self.stream.of("needs.close", agent=HERMES)
        self.check("hermes serve: need stays open while the approval is pending (6 s)", not closed_early,
                   json.dumps(closed_early)[:200], "app/server.py roster merge / app/office_life/sources.py")
        code, out = answer_card(HERMES, key, run, appr, decision="deny")
        t0 = time.time()
        closed = self.stream.wait("needs.close", 15, agent=HERMES)
        self.check("hermes serve: answering the card clears the sign (needs.close answered)",
                   bool(closed) and closed[0].get("outcome") == "answered",
                   f"answer {code}; close after {time.time() - t0:.1f}s {json.dumps(closed)[:160]}",
                   "app/office_life/sources.py")
        self.wait_idle()

    def test_2_question_sign(self):
        run, key = self.chat_run('[[tool:clarify {"questions":[{"question":"Which colour?","choices":["Red","Blue"]}]}]] ask me')
        opened = self.stream.wait("needs.open", 25, agent=HERMES)
        self.check("hermes serve: clarify -> needs.open question", bool(opened) and opened[0].get("need") == "question",
                   json.dumps(opened)[:200], "app/office_life/sources.py")
        qid = opened[0]["ref"] if opened else ""
        time.sleep(4)
        early = self.stream.of("needs.close", agent=HERMES)
        self.check("hermes serve: question sign stays up until answered (4 s)", not early, json.dumps(early)[:220],
                   "app/office_life/sources.py")
        code, out = answer_card(HERMES, key, run, qid, answers={"0": "Red"})
        closed = self.stream.wait("needs.close", 15, agent=HERMES)
        self.check("hermes serve: answering the question clears the sign",
                   bool(closed) and closed[0].get("outcome") in ("answered",),
                   f"answer {code} {str(out)[:80]}; {json.dumps(closed)[:160]}", "app/office_life/sources.py")
        self.wait_idle()

    def test_3_subagent_intern_in_and_out(self):
        run, key = self.chat_run('[[tool:delegate_task {"goal":"[[slow:200]][[long:6]] Find the bug","context":"life e2e"}]] get help')
        got = self.stream.wait("interns.set", 40, agent=HERMES)
        up = [f for f in self.stream.of("interns.set", agent=HERMES) if (f.get("count") or 0) >= 1]
        self.check("hermes serve: delegate_task subagent -> interns.set count>=1", bool(up),
                   json.dumps(got)[:200], "app/office_life/sources.py")
        down = wait_for(lambda: [f for f in self.stream.of("interns.set", agent=HERMES) if f.get("count") == 0], 90, 1)
        self.check("hermes serve: intern leaves when the subagent ends (count 0)", bool(down) or not up,
                   json.dumps(self.stream.of("interns.set", agent=HERMES))[:200], "app/office_life/sources.py")
        self.wait_idle()


SECRETS = ("SECRET-CMD-7731", "SECRET-Q-5521", "SECRET-MSG-9917", "SECRET-GOAL-4410", "SECRET-SEND-8802")


@unittest.skipIf(PL, "fake gateway only (layer mode runs TestOpenClawLayer against the lab gateway)")
class TestOpenClaw(LifeCase):
    @classmethod
    def setUpClass(cls):
        cls.infer0 = gateway_inference()

    def test_1_approval_and_question(self):
        now = int(time.time() * 1000)
        emit("exec.approval.requested", {"id": "oc-a1", "createdAtMs": now, "expiresAtMs": now + 600_000,
                                         "request": {"agentId": "main", "sessionKey": "agent:main:main",
                                                     "command": "echo " + SECRETS[0]}})
        opened = self.stream.wait("needs.open", 10, agent="main")
        self.check("openclaw: exec approval -> needs.open approval (session agent:main:main)",
                   bool(opened) and opened[0].get("need") == "approval" and opened[0].get("ref") == "oc-a1"
                   and opened[0].get("session") == "agent:main:main", json.dumps(opened)[:220],
                   "app/office_life/sources.py")
        emit("question.requested", {"id": "oc-q1", "agentId": "ops", "sessionKey": "agent:ops:main", "status": "pending",
                                    "questions": [{"id": "q", "question": SECRETS[1] + "?", "options": [{"label": "A"}]}]})
        q = self.stream.wait("needs.open", 10, agent="ops")
        self.check("openclaw: question.requested -> needs.open question", bool(q) and q[0].get("need") == "question",
                   json.dumps(q)[:200], "app/office_life/sources.py")
        state = api("/api/office-life/state")[1]
        self.check("openclaw: /state open needs list both", len([n for n in state["open"]["needs"]
                                                                 if n.get("agent") in ("main", "ops")]) == 2,
                   json.dumps(state["open"]["needs"])[:220], "app/office_life/bus.py")
        emit("exec.approval.resolved", {"id": "oc-a1", "decision": "allow-once"})
        emit("question.resolved", {"id": "oc-q1", "status": "answered"})
        c1 = self.stream.wait("needs.close", 10, agent="main")
        c2 = self.stream.wait("needs.close", 10, agent="ops")
        self.check("openclaw: resolved elsewhere -> both signs clear (answered)",
                   bool(c1) and bool(c2) and c1[0].get("outcome") == "answered" and c2[0].get("outcome") == "answered",
                   json.dumps(c1 + c2)[:240], "app/office_life/sources.py")

    def test_2_visitor_cron_intern_handoff(self):
        emit("session.message", {"sessionKey": "agent:main:telegram:direct:991", "agentId": "main",
                                 "session": {"key": "agent:main:telegram:direct:991", "lastChannel": "telegram"},
                                 "message": {"role": "user", "content": SECRETS[2]}})
        v = self.stream.wait("visitor", 10, agent="main")
        self.check("openclaw: telegram message -> visitor (channel telegram, session key)",
                   bool(v) and v[0].get("channel") == "telegram" and v[0].get("session") == "agent:main:telegram:direct:991",
                   json.dumps(v)[:220], "app/office_life/sources.py")
        job = {"id": "job-1", "name": "Morning digest", "agentId": "ops"}
        emit("cron", {"action": "started", "jobId": "job-1", "runAtMs": 11, "job": job})
        f = self.stream.wait("cron.fire", 10, agent="ops")
        emit("cron", {"action": "finished", "jobId": "job-1", "runAtMs": 11, "status": "ok", "job": job})
        d = self.stream.wait("cron.done", 10, agent="ops")
        self.check("openclaw: cron started/finished -> alarm clock fire + done ok",
                   bool(f) and bool(d) and d[0].get("ok") is True and f[0].get("name") == "Morning digest",
                   json.dumps(f + d)[:240], "app/office_life/sources.py")
        emit("cron", {"action": "started", "jobId": "job-2", "runAtMs": 12, "job": {"id": "job-2", "name": "No owner"}})
        time.sleep(1.5)
        self.check("openclaw: cron job without an agent is skipped (never guessed)",
                   not [e for e in self.stream.of("cron.fire") if e.get("ref") == "job-2" or e.get("name") == "No owner"],
                   json.dumps(self.stream.of("cron.fire"))[:200], "app/office_life/sources.py")
        emit("task", {"action": "upserted", "task": {"id": "t-sub1", "runtime": "subagent", "status": "running",
                                                     "agentId": "main", "sessionKey": "agent:main:main",
                                                     "goal": SECRETS[3]}})
        up = self.stream.wait("interns.set", 10, agent="main")
        emit("task", {"action": "upserted", "task": {"id": "t-sub1", "runtime": "subagent", "status": "succeeded",
                                                     "agentId": "main", "sessionKey": "agent:main:main"}})
        down = wait_for(lambda: [e for e in self.stream.of("interns.set", agent="main") if e.get("count") == 0], 10)
        self.check("openclaw: subagent task running -> intern in, finished -> out",
                   bool(up) and up[0].get("count") == 1 and bool(down), json.dumps(self.stream.of("interns.set"))[:240],
                   "app/office_life/sources.py")
        emit("session.tool", {"runId": "r-send", "sessionKey": "agent:main:main", "agentId": "main",
                              "data": {"phase": "start", "name": "sessions_send", "toolCallId": "c1",
                                       "args": {"agentId": "ops", "message": SECRETS[4]}}})
        h = self.stream.wait("handoff", 10, agent="main")
        self.check("openclaw: sessions_send tool -> handoff main -> ops (send)",
                   bool(h) and h[0].get("to") == "ops" and h[0].get("via") == "send", json.dumps(h)[:220],
                   "app/office_life/sources.py")
        emit("session.message", {"sessionKey": "agent:main:main", "agentId": "main",
                                 "message": {"role": "user", "content": SECRETS[4],
                                             "provenance": {"kind": "inter_session", "sourceSessionKey": "agent:ops:main"}}})
        h2 = self.stream.wait("handoff", 10, agent="ops")
        vis = [e for e in self.stream.of("visitor") if e.get("session") == "agent:main:main"]
        self.check("openclaw: inter-session message -> handoff ops -> main, not a visitor",
                   bool(h2) and h2[0].get("to") == "main" and not vis, json.dumps(h2 + vis)[:220],
                   "app/office_life/sources.py")

    def test_3_zero_inference_on_the_gateway(self):
        calls = gw("/calls")
        self.check("openclaw: the scenarios started no inference on the gateway (agent/chat.send/sessions.send/...)",
                   calls.get("inference") == self.infer0, f"before {self.infer0} after {calls.get('inference')} "
                   + json.dumps(calls.get("counts"))[:260], "app/office_life/*")


@unittest.skipUnless(PL, "layer mode only (LIFE_PL=1 tests/tools/life-e2e.sh start)")
class TestOpenClawLayer(LifeCase):
    """The real lab gateway through the copied layer: what 0.10's fake-gateway cases showed, from real runs."""

    @classmethod
    def setUpClass(cls):
        wait_for(lambda: layer_id("main") and layer_id("ops"), 60, 1.0)
        cls.conn = next((c["id"] for c in api("/api/connections")[1].get("connections") or []
                         if c.get("kind") == "openclaw"), None)

    def policy(self, ask):
        pol = api("/api/agent-providers/call", {"id": self.conn, "method": "exec.approvals.get"})[1]
        defaults = dict((pol.get("file") or {}).get("defaults") or {}, security="full", ask=ask)
        code, out = api("/api/agent-providers/call", {"id": self.conn, "method": "exec.approvals.set",
                                                      "params": {"file": {"version": 1, "defaults": defaults},
                                                                 "baseHash": pol.get("hash")}})
        self.assertEqual(code, 200, out)

    def test_1_approvals_office_run_and_outside_run(self):
        self.policy("always")
        try:
            run, key = office_run("main", "[[exec:echo pl-life-approval]] run it")
            opened = self.stream.wait("needs.open", 25, agent="main")
            self.check("layer openclaw: office run exec approval -> needs.open approval (its chat session)",
                       bool(opened) and opened[0].get("need") == "approval" and opened[0].get("session") == key,
                       json.dumps(opened)[:220], "app/office_life/sources.py on_layer")
            code, out = answer_card("main", key, run, opened[0]["ref"] if opened else "", decision="allow-once")
            closed = self.stream.wait("needs.close", 20, agent="main")
            self.check("layer openclaw: answering the card clears the sign (answered)",
                       bool(closed) and closed[0].get("outcome") == "answered", f"{code} {json.dumps(closed)[:160]}",
                       "app/office_life/sources.py on_layer")
            cli = lab_oc("agent", "--agent", "ops", "--session-key", "agent:ops:telegram:direct:77",
                         "--message", "[[exec:echo pl-life-outside]] go", background=True)
            try:
                need = self.stream.wait("needs.open", 40, agent="ops")
                self.check("layer openclaw: a run the lab CLI started (telegram session) asks -> needs.open for ops",
                           bool(need) and need[0].get("need") == "approval"
                           and need[0].get("session") == "agent:ops:telegram:direct:77", json.dumps(need)[:220],
                           "app/provider-layer/server/providers/openclaw/chat.js outsideNeed")
                pend = lab_json("approvals", "pending") or {}
                rows = pend.get("approvals") or pend.get("pending") or (pend if isinstance(pend, list) else [])
                ids = [str(r.get("id")) for r in rows if isinstance(r, dict)]
                for i in ids:
                    lab_oc("approvals", "resolve", i, "deny")
                gone = self.stream.wait("needs.close", 20, agent="ops")
                self.check("layer openclaw: resolved on the gateway -> the sign clears", bool(gone),
                           f"pending {ids} {json.dumps(gone)[:160]}", "openclaw/chat.js outsideNeed")
            finally:
                cli.wait(timeout=60) if cli.poll() is None else None
        finally:
            self.policy("off")

    def test_2_visitor_cron_intern_handoff(self):
        cli = lab_oc("agent", "--agent", "main", "--session-key", "agent:main:telegram:direct:991",
                     "--message", "[[slow:4000]] hello from telegram", background=True)
        v = self.stream.wait("visitor", 30, agent="main")
        cli.wait(timeout=60)
        self.check("layer openclaw: a run another client started in a telegram session -> visitor (telegram)",
                   bool(v) and v[0].get("channel") == "telegram" and v[0].get("session") == "agent:main:telegram:direct:991",
                   json.dumps(v)[:220], "app/office_life/sources.py _layer_activity")
        job = lab_json("cron", "add", "--agent", "ops", "--name", "Morning digest", "--every", "1h",
                       "--message", "[[slow:4000]] digest") or {}
        jid = str(job.get("id") or (job.get("job") or {}).get("id") or "")
        lab_oc("cron", "run", jid, timeout=90, background=True)
        f = self.stream.wait("cron.fire", 40, agent="ops")
        d = self.stream.wait("cron.done", 60, agent="ops")
        lab_oc("cron", "rm", jid)
        self.check("layer openclaw: cron run -> alarm clock fire + done (the job's id)",
                   bool(f) and bool(d) and f[0].get("ref") == jid, f"job {jid} " + json.dumps(f + d)[:220],
                   "app/office_life/sources.py _layer_activity")
        office_run("main", '[[tool:sessions_spawn {"task": "[[slow:6000]] find the bug"}]] get help')
        up = wait_for(lambda: [e for e in self.stream.of("interns.set", agent="main") if (e.get("count") or 0) >= 1], 40)
        down = wait_for(lambda: [e for e in self.stream.of("interns.set", agent="main") if e.get("count") == 0], 90)
        self.check("layer openclaw: sessions_spawn subagent -> intern in, out when it ends", bool(up) and bool(down),
                   json.dumps(self.stream.of("interns.set"))[:240], "app/office_life/sources.py _layer_activity")
        office_run("main", '[[tool:sessions_send {"agentId": "ops", "message": "please take this"}]] hand over')
        h = self.stream.wait("handoff", 30, agent="main")
        self.check("layer openclaw: sessions_send in an office run -> handoff main -> ops (send)",
                   bool(h) and h[0].get("to") == "ops" and h[0].get("via") == "send", json.dumps(h)[:220],
                   "app/office_life/sources.py on_layer tool.start")

    def test_3_presence_and_journal(self):
        run, key = office_run("ops", "[[slow:3000]] working on it")
        working = wait_for(lambda: api("/status")[1].get("ops", {}).get("state") == "working", 20, 0.3)
        self.check("layer openclaw: an office run puts ops to work (/status working)", bool(working),
                   json.dumps(api("/status")[1].get("ops"))[:200], "app/provider_layer_life.py")
        idle = wait_for(lambda: api("/status")[1].get("ops", {}).get("state") in ("idle", "finishing"), 40, 0.5)
        ends = wait_for(lambda: [ln for ln in journal_text().splitlines()
                                 if '"k":"run"' in ln and f'"r":"{run}"' in ln and '"end"' in ln], 20)
        self.check("layer openclaw: ... then idle, and the journal has the run with its outcome",
                   bool(idle) and bool(ends) and '"ok":true' in ends[0], " ".join(ends)[:200],
                   "app/provider_layer_life.py -> presence lifecycle -> sources.on_lifecycle")


QUILL = HERMES          # (the private office has no licence: demo = 3 visible agents, hermes-lab-a, main, ops)
HIDDEN = "hermes-lab-a-quill"


class TestProviderNeutral(LifeCase):
    def test_1_task_project_xp_assign_a2a(self):
        now = int(time.time() * 1000)
        res = inject({"type": "xp", "agent": HIDDEN, "provider": "office", "points": 3, "total": 3, "at": now})
        self.check("neutral: an agent beyond the demo limit gets no Office life events (visible roster only)",
                   res.get("published") == [None], json.dumps(res), "app/office_life/bus.py")
        code, proj = api("/api/projects", {"title": "Life QA launch", "createdBy": "user"})
        self.assertIn(code, (200, 201), proj)
        proj = proj.get("project") or proj
        pid = proj["id"]
        done_col = [c["id"] for c in proj.get("columns", []) if c.get("title", "").lower() in ("done", "completed")][0]
        tids = []
        for title, who in (("Fix login", QUILL), ("Write notes", "ops")):
            c, t = api(f"/api/projects/{pid}/tasks", {"title": title, "assignee": who})
            tids.append((t.get("task") or t)["id"])
        api(f"/api/projects/{pid}/tasks/{tids[0]}", {"columnId": done_col, "by": "user"}, method="PUT")
        td = self.stream.wait("task.done", 10, agent=QUILL)
        xp = self.stream.wait("xp", 10, agent=QUILL)
        self.check("neutral: task moved to Done -> task.done (+points) for a Hermes agent",
                   bool(td) and td[0].get("points", 0) > 0 and td[0].get("title") == "Fix login",
                   json.dumps(td)[:200], "app/office_life/hooks.py")
        self.check("neutral: XP award -> xp event with points + total", bool(xp) and xp[0].get("points", 0) > 0,
                   json.dumps(xp)[:200], "app/office_life/hooks.py")
        api(f"/api/projects/{pid}/tasks/{tids[1]}", {"assignee": QUILL, "by": "ops"}, method="PUT")
        h = self.stream.wait("handoff", 10, agent="ops")
        self.check("neutral: task reassigned by an office agent -> handoff via task",
                   bool(h) and h[0].get("to") == QUILL and h[0].get("via") == "task", json.dumps(h)[:200],
                   "app/office_life/hooks.py")
        api(f"/api/projects/{pid}/tasks/{tids[1]}", {"assignee": "ops", "by": "user"}, method="PUT")
        time.sleep(1)
        self.check("neutral: reassignment by the user is not a handoff",
                   len(self.stream.of("handoff")) == len(h), json.dumps(self.stream.of("handoff"))[:200],
                   "app/office_life/hooks.py")
        api(f"/api/projects/{pid}", {"status": "completed"}, method="PUT")
        pd = self.stream.wait("project.done", 10)
        today = api("/api/office-life/state")[1].get("today", {})
        self.check("neutral: project completed -> project.done with its done-task agents + cake today",
                   bool(pd) and QUILL in (pd[0].get("agents") or []) and bool(today.get("cake")),
                   json.dumps(pd)[:200] + " cake=" + json.dumps(today.get("cake"))[:80], "app/office_life/hooks.py")
        try:
            code, out = api("/api/agent-platform-communications/send",
                            {"fromAgentId": "main", "toAgentId": "ops", "message": SECRETS[4], "timeoutSec": 3},
                            timeout=8)
        except Exception as exc:      # (delivery to the fake gateway may time out; the hook runs before delivery)
            code, out = "timeout", str(exc)
        a2a = self.stream.wait("handoff", 10, agent="main", via="a2a")
        self.check("neutral: A2A send -> handoff via a2a", bool(a2a) and a2a[0].get("to") == "ops",
                   f"send {code}; " + json.dumps(a2a)[:200], "app/office_life/hooks.py")


INFER = {}


class TestGatherings(LifeCase):
    """Stand-up now, paper now and a tournament driven through the injector clock. Counts LLM calls on the lab's
    stub model and inference methods on the fake gateway around the whole class: features must start none."""

    @classmethod
    def setUpClass(cls):
        INFER["before"] = (stub_calls(), gateway_inference() if CTL and not PL else 0)

    @classmethod
    def tearDownClass(cls):
        INFER["after"] = (stub_calls(), gateway_inference() if CTL and not PL else 0)
        note(f"{'PASS' if INFER['before'] == INFER['after'] else 'FAIL'} zero inference: stand-up + paper + tournament"
             f" + celebrations left the lab stub-model call count and the gateway inference count unchanged"
             f" (stub, gateway) before {INFER['before']} after {INFER['after']}")

    def test_1_standup_now_lines_history_end(self):
        code, out = api("/api/office-life/standup/now", {})
        start = self.stream.wait("standup.start", 10)
        ev = start[0] if start else {}
        lines = ev.get("lines") or []
        self.check("stand-up now: standup.start with participants + one templated line each",
                   code == 200 and ev.get("status") == "open" and len(lines) >= 1
                   and all(isinstance(r.get("line"), str) and r["line"] for r in lines),
                   f"{code} {json.dumps(ev)[:300]}", "app/office_life/builders.py")
        hist = api("/api/meetings/history")[1]
        rows = hist if isinstance(hist, list) else (hist.get("history") or hist.get("meetings") or [])
        mine = [r for r in rows if r.get("kind") == "standup" and r.get("id") == ev.get("id")]
        self.check("stand-up now: one Meetings history record (kind standup, responses per agent)",
                   len(mine) == 1 and set(mine[0].get("responses") or {}) == {r["agent"] for r in lines},
                   json.dumps(mine)[:260], "app/office_life/scheduler.py")
        joined = " ".join(r["line"] for r in lines)
        self.check("stand-up lines carry real facts from today (task/handoff/visitor/run words)",
                   any(w in joined for w in ("Finished", "Handed", "Picked up", "Answered", "Ran", "Worked", "Hit",
                                             "Wrapped")), joined[:260], "app/office_life/builders.py")
        code2, again = api("/api/office-life/standup/now", {})
        self.check("stand-up now twice while one is open -> refused (409), no second record",
                   code2 == 409, f"{code2} {json.dumps(again)[:160]}", "app/office_life/scheduler.py")
        inject(action="tick", now=time.time() + 100)
        end = self.stream.wait("standup.end", 10)
        self.check("stand-up ends 90 s after start (clock moved 100 s)", bool(end), json.dumps(end)[:200],
                   "app/office_life/scheduler.py")

    def test_2_paper_now(self):
        code, out = api("/api/office-life/paper/now", {})
        ready = self.stream.wait("paper.ready", 10)
        day = (ready[0].get("day") if ready else None) or api("/api/office-life/state")[1].get("day")
        pc, paper = api(f"/api/office-life/paper?day={day}")
        p = paper.get("paper") or paper
        self.check("paper now: paper.ready + /paper with headline, columns, MVP, stats",
                   code == 200 and bool(ready) and bool(p.get("headline")) and isinstance(p.get("columns"), list)
                   and isinstance(p.get("stats"), list), f"{code} ready={bool(ready)} {json.dumps(p)[:300]}",
                   "app/office_life/builders.py")
        mvp = p.get("mvp") or {}
        self.check("paper: MVP is a visible agent with a reason", mvp.get("agent") in ("main", "ops", HERMES)
                   and bool(mvp.get("reason")), json.dumps(mvp)[:200], "app/office_life/builders.py")
        dc, days = api("/api/office-life/days")
        self.check("paper: /days lists today with a paper", day in json.dumps(days), json.dumps(days)[:200],
                   "app/office_life/routes.py")

    def test_3_tournament_time_travel(self):
        res = inject(action="tournament", players=["main", "ops", HERMES])
        r = res.get("result") or {}
        start = self.stream.wait("tournament.start", 10)
        busy = [k for k in ("main", "ops", HERMES) if api("/status")[1].get(k, {}).get("state") not in ("idle", None)]
        players = (start[0].get("players") or []) if start else []
        self.check("tournament: test start -> tournament.start with only the free players (working ones left out)",
                   r.get("started") is True and bool(start) and len(players) >= 2 and not set(busy) & set(players),
                   json.dumps(r) + " " + json.dumps(start)[:240], "app/office_life/tournament.py")
        if not start:
            return
        tid = start[0]["id"]
        t = time.time()
        for _ in range(12):
            t += 45
            inject(action="tick", now=t)
            if self.stream.of("tournament.end", id=tid):
                break
        matches = self.stream.of("tournament.match", id=tid)
        end = self.stream.of("tournament.end", id=tid)
        self.check("tournament: matches decided by the server, end with a champion",
                   len(matches) >= len(players) - 1 and bool(end) and end[0].get("status") == "done" and bool(end[0].get("champion")),
                   f"matches={len(matches)} end={json.dumps(end)[:200]}", "app/office_life/tournament.py")
        champ = end[0].get("champion") if end else None
        today = api("/api/office-life/state")[1].get("today", {})
        scores = api("/api/projects/scores")[1]
        rows = scores if isinstance(scores, list) else (scores.get("leaderboard") or scores.get("scores") or [])
        row = [x for x in rows if (x.get("agent") or x.get("id") or x.get("key")) == champ]
        self.check("tournament: champion in /state.today and a title on the leaderboard (games.titles, XP untouched)",
                   today.get("champion") == champ or (today.get("champion") or {}).get("agent") == champ
                   if isinstance(today.get("champion"), dict) else today.get("champion") == champ,
                   f"today.champion={json.dumps(today.get('champion'))} row={json.dumps(row)[:200]}",
                   "app/office_life/journal.py")
        self.check("tournament: leaderboard row has games {titles>=1}",
                   bool(row) and ((row[0].get("games") or {}).get("titles") or 0) >= 1, json.dumps(row)[:200],
                   "app/server.py record_game / app/office_life/tournament.py")


def save_settings(partial):
    code, out = api("/api/office-life/settings", partial)
    assert code == 200, (code, out)
    return out


class TestSettingsGates(LifeCase):
    """Each Settings switch really stops its feature at the source; Calm mode; the master switch."""

    def tearDown(self):
        save_settings({"enabled": True, "calm": False, "features": {k: True for k in (
            "needsYou", "interns", "handoffs", "visitors", "alarmClock", "moods", "celebrations", "standup",
            "seasons", "tournaments", "newspaper")}})
        super().tearDown()

    def off_then(self, feature, fire, kind, agent, label):
        save_settings({"features": {feature: False}})
        time.sleep(0.5)
        fire()
        time.sleep(2.5)
        got = [e for e in self.stream.of(kind, agent=agent)]
        self.check(f"settings: {feature} off -> {label} not published", not got, json.dumps(got)[:200],
                   "app/office_life/sources.py")
        save_settings({"features": {feature: True}})

    @unittest.skipIf(PL, "drives the fake gateway (the gates are provider-neutral: tests/test_pl_life.py + this class)")
    def test_1_source_features_off(self):
        u = str(int(time.time()))
        self.off_then("needsYou", lambda: emit("exec.approval.requested", {
            "id": "off-" + u, "createdAtMs": int(time.time() * 1000), "expiresAtMs": int(time.time() * 1000) + 600_000,
            "request": {"agentId": "ops", "sessionKey": "agent:ops:main", "command": "x"}}), "needs.open", "ops",
            "an OpenClaw approval sign")
        emit("exec.approval.resolved", {"id": "off-" + u, "decision": "deny"})
        self.off_then("visitors", lambda: emit("session.message", {
            "sessionKey": f"agent:ops:discord:direct:{u}", "agentId": "ops",
            "session": {"key": f"agent:ops:discord:direct:{u}", "lastChannel": "discord"},
            "message": {"role": "user", "content": "x"}}), "visitor", "ops", "a Discord visitor")
        self.off_then("alarmClock", lambda: emit("cron", {"action": "started", "jobId": "j" + u, "runAtMs": int(u),
                                                          "job": {"id": "j" + u, "name": "Off", "agentId": "ops"}}),
                      "cron.fire", "ops", "an alarm clock")
        emit("cron", {"action": "finished", "jobId": "j" + u, "runAtMs": int(u), "status": "ok",
                      "job": {"id": "j" + u, "name": "Off", "agentId": "ops"}})
        self.off_then("interns", lambda: emit("task", {"action": "upserted", "task": {
            "id": "ts" + u, "runtime": "subagent", "status": "running", "agentId": "ops", "sessionKey": "agent:ops:main"}}),
            "interns.set", "ops", "an intern")
        emit("task", {"action": "upserted", "task": {"id": "ts" + u, "runtime": "subagent", "status": "succeeded",
                                                     "agentId": "ops", "sessionKey": "agent:ops:main"}})
        self.off_then("handoffs", lambda: emit("session.tool", {
            "runId": "r" + u, "sessionKey": "agent:ops:main", "agentId": "ops",
            "data": {"phase": "start", "name": "sessions_send", "toolCallId": "c" + u, "args": {"agentId": "main"}}}),
            "handoff", "ops", "a folder handoff")

    def test_2_gatherings_off_and_master_switch(self):
        save_settings({"features": {"standup": False}})
        code, out = api("/api/office-life/standup/now", {})
        self.check("settings: stand-up off -> 'Run a stand-up now' refused", code == 409 and not self.stream.of("standup.start"),
                   f"{code} {json.dumps(out)[:120]}", "app/office_life/scheduler.py")
        save_settings({"features": {"newspaper": False}})
        code, out = api("/api/office-life/paper/now", {})
        self.check("settings: newspaper off -> 'Print today's paper now' refused", code == 409, f"{code} {json.dumps(out)[:120]}",
                   "app/office_life/scheduler.py")
        save_settings({"features": {"tournaments": False}})
        res = inject(action="tournament", players=["ops", HERMES])
        self.check("settings: tournaments off -> no tournament starts", (res.get("result") or {}).get("started") is False,
                   json.dumps(res), "app/office_life/scheduler.py")
        save_settings({"features": {"tournaments": True}, "calm": True})
        res = inject(action="tournament", players=["ops", HERMES])
        self.check("settings: Calm mode -> no tournaments (design 7.4)", (res.get("result") or {}).get("started") is False,
                   json.dumps(res), "app/office_life/tournament.py")
        cake = api("/api/office-life/state")[1].get("today", {}).get("cake")
        self.check("settings: Calm mode keeps the cake (decor stays)", bool(cake), json.dumps(cake), "app/office_life/journal.py")
        save_settings({"calm": False, "enabled": False})
        res = inject({"type": "xp", "agent": "ops", "provider": "office", "points": 1, "total": 1,
                      "at": int(time.time() * 1000)})
        state = api("/api/office-life/state")[1]
        self.check("settings: master switch off -> events dropped, state says disabled",
                   res.get("published") == [None] and state.get("settings", {}).get("enabled") is False,
                   json.dumps(res) + " enabled=" + json.dumps(state.get("settings", {}).get("enabled")),
                   "app/office_life/bus.py")
        code, _out = api("/api/office-life/standup/now", {})
        self.check("settings: master switch off -> buttons refused (409)", code == 409, str(code), "app/office_life/routes.py")


class TestRestartPrivacy(LifeCase):
    def test_1_server_restart_mid_standup_one_record(self):
        import subprocess
        self.check("restart mid stand-up: the office is idle before the check (no stand-up left running)",
                   wait_for_no_standup(), "a stand-up is still open", "tests/test_life_e2e.py")
        code, _ = api("/api/office-life/standup/now", {})
        start = self.stream.wait("standup.start", 10)
        sid = start[0]["id"] if start else None
        self.stream.close()
        out = subprocess.run([os.path.join(HERE, "tools", "life-e2e.sh"), "restart-server"], capture_output=True,
                             text=True, timeout=100, env=stack_tool_env())
        hist = api("/api/meetings/history")[1]
        rows = hist if isinstance(hist, list) else (hist.get("history") or hist.get("meetings") or [])
        mine = [r for r in rows if r.get("id") == sid]
        state = api("/api/office-life/state")[1]
        self.check("restart mid stand-up: exactly one Meetings record after the restart",
                   code == 200 and sid and len(mine) == 1, f"{sid} records={len(mine)} restart={out.stdout.strip()[-60:]}",
                   "app/office_life/scheduler.py")
        inject(action="tick", now=time.time() + 100)       # the resumed stand-up ends at its own endsAt
        ends_of = lambda: [ln for ln in journal_text().splitlines() if '"standup.end"' in ln and (sid or "?") in ln]
        wait_for(ends_of, 10, 0.5)
        jl = [ln for ln in journal_text().splitlines() if '"standup.' in ln and (sid or "?") in ln]
        ends = ends_of()
        self.check("restart mid stand-up: the stand-up resumes after boot and ends exactly once (journal)", len(ends) == 1,
                   f"{len(jl)} journal lines, ends={len(ends)}", "app/office_life/scheduler.py")
        code2, _ = api("/api/office-life/standup/now", {})
        self.check("restart mid stand-up: a new stand-up can run after the restart (not stuck busy)", code2 == 200,
                   str(code2), "app/office_life/scheduler.py")

    def test_2_privacy_no_text_leaves_the_chat(self):
        day = api("/api/office-life/state")[1].get("day")
        blobs = {"journal files": journal_text(), "state": json.dumps(api("/api/office-life/state")[1]),
                 "journal api": json.dumps(api(f"/api/office-life/journal?day={day}&limit=1000")[1]),
                 "paper": json.dumps(api(f"/api/office-life/paper?day={day}")[1]),
                 "meetings": json.dumps(api("/api/meetings/history")[1])}
        leaks = {name: [s for s in SECRETS if s in text] for name, text in blobs.items()}
        leaks = {k: v for k, v in leaks.items() if v}
        self.check("privacy: no command/question/message/goal text in journal, state, journal API, paper, meetings",
                   not leaks, json.dumps(leaks) or "0 hits for 5 markers in " + ", ".join(blobs),
                   "app/office_life/*")
        self.check("privacy: the journal holds structured rows (sanity: it is not empty)", len(blobs["journal files"]) > 500,
                   f"{len(blobs['journal files'])} bytes", "app/office_life/journal.py")


class TestMoods(LifeCase):
    """Moods from real run outcomes: 3 failed runs -> stuck, the next ok run -> clear + back on track."""

    def openclaw_run(self, agent, rid, phase_end):
        emit("agent", {"runId": rid, "sessionKey": f"agent:{agent}:main", "stream": "lifecycle", "data": {"phase": "start"}})
        time.sleep(0.3)
        emit("agent", {"runId": rid, "sessionKey": f"agent:{agent}:main", "stream": "lifecycle", "data": {"phase": phase_end}})
        time.sleep(0.3)

    @unittest.skipIf(PL, "fake gateway lifecycle frames (the lab stub cannot fail a turn)")
    def test_1_openclaw_stuck_then_back_on_track(self):
        u = str(int(time.time()))
        for i in range(3):
            self.openclaw_run("ops", f"m{u}-{i}", "error")
        stuck = self.stream.wait("mood", 15, agent="ops", mood="stuck")
        self.check("moods openclaw: 3 failed runs -> stuck", bool(stuck), json.dumps(self.stream.of("mood"))[:200],
                   "app/office_life/scheduler.py")
        self.openclaw_run("ops", f"m{u}-ok", "end")
        clear = wait_for(lambda: [e for e in self.stream.of("mood", agent="ops") if e.get("backOnTrack")], 15)
        self.check("moods openclaw: next ok run -> mood clear with backOnTrack (celebration trigger)", bool(clear),
                   json.dumps(self.stream.of("mood", agent="ops"))[:220], "app/office_life/scheduler.py")

    @unittest.skipIf(PL, "fake gateway lifecycle frames")
    def test_2_openclaw_cancel_does_not_count(self):
        u = str(int(time.time()))
        for i in range(3):
            self.openclaw_run("ops", f"c{u}-{i}", "cancelled")
        time.sleep(6)
        self.check("moods openclaw: 3 cancelled runs never make 'stuck'",
                   not self.stream.of("mood", agent="ops", mood="stuck"), json.dumps(self.stream.of("mood"))[:160],
                   "app/office_life/scheduler.py")

    def test_3_hermes_serve_stuck_from_failed_turns(self):
        for i in range(3):
            office_run(HERMES, f"[[error:400]] fail {i}")
            wait_for(lambda: api("/status")[1].get(HERMES, {}).get("state") in ("idle", "finishing"), 25, 0.5)
            time.sleep(1)
        stuck = self.stream.wait("mood", 15, agent=HERMES, mood="stuck")
        runs = [ln for ln in journal_text().splitlines() if '"k":"run"' in ln and HERMES in ln and '"end"' in ln][-3:]
        self.check("moods hermes serve: 3 failed lab turns (stub HTTP 400) -> stuck", bool(stuck),
                   json.dumps(self.stream.of("mood"))[:160] + " runs " + " ".join(r[-90:] for r in runs),
                   "app/office_life/sources.py (Hermes run outcome) / scheduler.py")
        office_run(HERMES, "hello again")
        clear = wait_for(lambda: [e for e in self.stream.of("mood", agent=HERMES) if e.get("backOnTrack")], 30)
        self.check("moods hermes serve: the next ok turn -> back on track", bool(clear) or not stuck,
                   json.dumps(self.stream.of("mood", agent=HERMES))[:200], "app/office_life/scheduler.py")
