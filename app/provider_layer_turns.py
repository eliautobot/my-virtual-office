"""Office features that give an OpenClaw or Hermes agent a turn go through the copied layer (v0.11).

Projects and workflows (``_wf_call_agent``) and ``/api/provider-chat`` callers (VO agents with the agent token, A2A)
reached these two kinds through VO's Python gateway client or Hermes link in 0.10. With the layer on, ``agent_turn``
opens a chat of the office account for the agent (one per label, reused: one chat per task keeps its context, as the
0.10 task session key did), starts a run there (``/api/providers/runs``) and reads its events to the end. The chat is
the layer's like any other, so the turn shows in the agent's chat list and in Office Life like an office run.
"""

import http.client
import json
import threading
import time

import provider_layer_ids

POLL_S = 1.0
_LOCK = threading.Lock()
_SESSIONS = {}   # (layer agent id, label) -> the layer chat session id


def _call(layer, method, path, body=None, timeout=30.0):
    conn = http.client.HTTPConnection("127.0.0.1", layer.port, timeout=timeout)
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-VO-Principal": layer.office_principal()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
    finally:
        conn.close()
    try:
        out = json.loads(raw or b"null")
    except ValueError:
        out = {"error": raw[:200].decode("utf-8", "replace")}
    return resp.status, out if isinstance(out, dict) else {}


def layer_agent(office_id):
    """The layer agent id of an office agent, or None (not an OpenClaw/Hermes agent of the layer)."""
    ids = provider_layer_ids.ids()
    return ids.layer_id(office_id) if ids is not None and office_id else None


def agent_turn(layer, office_id, text, timeout=600.0, label="Office task"):
    """One turn: {"ok", "reply", "tools", "sessionId", "runId"} or {"ok": False, "error", "_status"}."""
    lid = layer_agent(office_id)
    if layer is None or not lid:
        return {"ok": False, "error": f"{office_id} is not an agent of the provider layer", "_status": 404}
    if not layer.ready():
        return {"ok": False, "error": "The OpenClaw and Hermes layer is not running", "_status": 503}
    label = str(label or "Office task")[:80]
    for attempt in (0, 1):
        with _LOCK:
            sid = _SESSIONS.get((lid, label))
        if sid is None:
            status, out = _call(layer, "POST", "/api/chat-sessions/create", {"agent": lid, "label": label})
            if status != 200 or not isinstance(out.get("session"), dict):
                return {"ok": False, "error": out.get("error") or f"chat not created (HTTP {status})", "_status": status}
            sid = out["session"]["id"]
            with _LOCK:
                _SESSIONS[(lid, label)] = sid
        status, run = _call(layer, "POST", "/api/providers/runs", {"agent": lid, "session": sid, "input": str(text)},
                            timeout=60.0)
        if status == 200 and run.get("runId"):
            break
        with _LOCK:
            _SESSIONS.pop((lid, label), None)   # (the chat was removed in the meantime: a new one, once)
        if attempt:
            return {"ok": False, "error": run.get("error") or f"run not started (HTTP {status})", "_status": status}
    rid, since, tools, end = run["runId"], 0, [], time.time() + float(timeout or 600)
    while time.time() < end:
        status, ev = _call(layer, "GET", f"/api/providers/runs/events?run={rid}&since={since}")
        if status != 200:
            return {"ok": False, "error": ev.get("error") or f"run lost (HTTP {status})", "_status": 502, "runId": rid}
        for item in ev.get("events") or []:
            since = max(since, int(item.get("seq") or 0))
            e = item.get("event") if isinstance(item.get("event"), dict) else item
            if e.get("type") == "tool.start" and e.get("name"):
                tools.append(str(e["name"]))
            elif e.get("type") == "run.end":
                ok = e.get("status") == "ok"
                return {"ok": ok, "reply": str(e.get("text") or ""), "tools": tools, "sessionId": str(sid),
                        "runId": rid, **({} if ok else {"error": str(e.get("error") or e.get("status") or "failed")})}
        if ev.get("done"):
            break
        time.sleep(POLL_S)
    _call(layer, "POST", "/api/providers/interrupt", {"run": rid})
    return {"ok": False, "error": "The agent did not answer in time", "_status": 504, "runId": rid, "tools": tools}
