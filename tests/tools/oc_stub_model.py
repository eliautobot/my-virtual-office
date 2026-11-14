#!/usr/bin/env python3
"""Stand-in OpenAI-style model for the lab OpenClaw gateway (tests/tools/lab-openclaw.sh).

Speaks the Chat Completions shape OpenClaw uses for `api: "openai-completions"` providers: GET /v1/models and
POST /v1/chat/completions, streamed (SSE) or not. The reply is "stub reply: <the last user message>" (OpenClaw wraps
it in context, so a test looks for its own words inside the reply). A message containing "slow:<ms>" streams its
reply spread over that many milliseconds (at most 60 s), for stop/interrupt tests. "[[exec:<command>]]" answers with a
call of the gateway's exec tool (so its approval policy can ask first), then "stub reply: the command said: <output>"
once the tool result comes back. "[[media:<absolute path>]]" answers with that file on a MEDIA: line of its own.
"[[think:<words>]]" streams those words as reasoning (reasoning_content) before the reply. "[[tool:<name> <json>]]"
answers with a call of that tool (any tool the gateway offers), then "stub reply: the tool said: ..." once its result
is back. "[[tools]]" answers with the names of the tools the gateway offered (for writing tests).
"[[model]]" puts the model and reasoning effort the gateway asked for into the reply ("stub reply (stub-2, high): ...").
"[[find:<word>]]" answers "stub reply: found <word>" when the word is anywhere in the request (an attached file's
name or text, a reference), else "stub reply: not found <word>".
A deferred tool (OpenClaw offers sessions_send, sessions_spawn ... through a wrapper) is called as tool_call {id, args}
(OpenClaw 2026.9) or dispatch_action {id, args} (2026.11), whichever the gateway offers.
Stdlib only, offline, binds 127.0.0.1.

Usage: python3 oc_stub_model.py <port>
"""

import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "stub-1"


# (OpenClaw adds context as user messages: 2026.9 inside internal-context markers; 2026.11 also as a plain
#  "OpenClaw runtime context ..." block ending "End OpenClaw runtime context.", a user message of its own after the
#  person's words. Neither is what the person said.)
_INTERNAL = re.compile(r"<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>.*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"
                       r"|OpenClaw runtime context\b.*?End OpenClaw runtime context\.?", re.S)


def _last_user_text(body):
    """The last user words, without the context blocks OpenClaw adds as user messages."""
    for message in reversed(body.get("messages") or []):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
        text = _INTERNAL.sub(" ", str(content or "")).strip()
        if text:
            return text
    return ""


_EXEC = re.compile(r"\[\[exec:([^\]]+)\]\]")
_MEDIA = re.compile(r"\[\[media:([^\]\s]+)\]\]")
_SHELL_TOOLS = ("exec", "bash", "shell", "run_command")
_THINK = re.compile(r"\[\[think:([^\]]+)\]\]")
_TOOL = re.compile(r"\[\[tool:([A-Za-z0-9_.-]+)\s*(\{.*?\})?\]\]", re.S)
_WRAPPERS = {"tool_call", "dispatch_action"}   # OpenClaw's deferred-tool call: 2026.9 tool_call, 2026.11 dispatch_action


def _text(message):
    content = message.get("content")
    if isinstance(content, list):
        content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "")


def _tool_result(body):
    """After the last real user message (internal-context blocks aside): the tool's result text once the gateway ran the
    stub's call ("" when it gave no text), else None."""
    messages = [m for m in body.get("messages") or [] if isinstance(m, dict)]
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user" and _INTERNAL.sub(" ", _text(m)).strip()), default=-1)
    after = messages[last_user + 1:]
    results = [m for m in after if m.get("role") == "tool"]
    if not results and not any(m.get("tool_calls") for m in after):
        return None
    return " ".join(_text(results[-1]).split()) if results else ""


def _shell_tool(body):
    names = [((t or {}).get("function") or {}).get("name") for t in body.get("tools") or []]
    return next((n for n in _SHELL_TOOLS if n in names), None)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def _json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "lab"}]})
        return self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": {"message": "bad json"}})
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        user = _last_user_text(body)
        text = "stub reply: " + " ".join(user.split())[:4000]
        find_m = re.search(r"\[\[find:([^\]\s]+)\]\]", user)
        if find_m:
            word = find_m.group(1)
            hay = json.dumps(body.get("messages") or [], ensure_ascii=False).replace(find_m.group(0), "")
            text = f"stub reply: {'found' if word in hay else 'not found'} {word}"
        if "[[model]]" in user:
            effort = body.get("reasoning_effort") or (body.get("reasoning") or {}).get("effort") or "-"
            text = f"stub reply ({body.get('model')}, {effort}): " + " ".join(user.split())[:4000]
        created = int(time.time())
        result, exec_m, media_m = _tool_result(body), _EXEC.search(user), _MEDIA.search(user)
        tool_m, think_m = _TOOL.search(user), _THINK.search(user)
        offered = [((t or {}).get("function") or {}).get("name") for t in body.get("tools") or []]
        call = None
        if result is not None:
            text = ("stub reply: the tool said: " if tool_m else "stub reply: the command said: ") + result[:1500]
        elif "[[tools]]" in user:
            text = "stub reply: tools " + " ".join(sorted(n for n in (((t or {}).get("function") or {}).get("name") for t in body.get("tools") or []) if n))
        elif tool_m and tool_m.group(1) in _WRAPPERS and tool_m.group(1) not in offered and _WRAPPERS & set(offered):
            # a test naming the wrapper itself ([[tool:tool_call {...}]]): the one this gateway offers, the same {id, args}
            call = {"index": 0, "id": f"call_{created}", "type": "function",
                    "function": {"name": sorted(_WRAPPERS & set(offered))[0], "arguments": tool_m.group(2) or "{}"}}
        elif tool_m and tool_m.group(1) not in offered and ("tool_call" in offered or "dispatch_action" in offered):
            # a deferred tool: OpenClaw offers it through its wrapper (2026.9 tool_call, 2026.11 dispatch_action; both {id, args})
            try:
                args = json.loads(tool_m.group(2) or "{}")
            except ValueError:
                args = {}
            wrapper = "tool_call" if "tool_call" in offered else "dispatch_action"
            call = {"index": 0, "id": f"call_{created}", "type": "function",
                    "function": {"name": wrapper, "arguments": json.dumps({"id": tool_m.group(1), "args": args})}}
        elif tool_m:
            call = {"index": 0, "id": f"call_{created}", "type": "function",
                    "function": {"name": tool_m.group(1), "arguments": tool_m.group(2) or "{}"}}
        elif exec_m and _shell_tool(body):
            call = {"index": 0, "id": f"call_{created}", "type": "function",
                    "function": {"name": _shell_tool(body), "arguments": json.dumps({"command": exec_m.group(1).strip()})}}
        elif media_m:
            text = "stub reply: here is the picture\nMEDIA:" + media_m.group(1)
        if call and not body.get("stream"):
            return self._json(200, {
                "id": "chatcmpl-stub", "object": "chat.completion", "created": created, "model": MODEL,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [call]}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
        if not body.get("stream"):
            return self._json(200, {
                "id": "chatcmpl-stub", "object": "chat.completion", "created": created, "model": MODEL,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def chunk(delta, finish=None, usage=None):
            payload = {"id": "chatcmpl-stub", "object": "chat.completion.chunk", "created": created, "model": MODEL,
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage:
                payload["usage"] = usage
            self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
            self.wfile.flush()

        if call:
            chunk({"role": "assistant", "content": None, "tool_calls": [call]})
            chunk({}, "tool_calls", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
            return
        slow = re.search(r"slow:(\d+)", text)
        pause = min(60.0, int(slow.group(1)) / 1000.0) / 20 if slow else 0
        chunk({"role": "assistant", "content": ""})
        if think_m and result is None:
            for start in range(0, len(think_m.group(1)), 16):
                chunk({"reasoning_content": think_m.group(1)[start:start + 16]})
        if pause:
            try:
                for i in range(20):
                    chunk({"content": f"{i} "})
                    time.sleep(pause)
            except OSError:  # (the gateway stopped the turn and hung up)
                return
        for start in range(0, len(text), 24):
            chunk({"content": text[start:start + 24]})
        chunk({}, "stop", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
