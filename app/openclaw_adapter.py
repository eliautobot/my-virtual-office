"""OpenClaw adapter for the Agent Providers routes (Hermes/OpenClaw port, design 2.4, 2.8, 2.9).

It works on top of the process-wide ``OpenClawGatewayClient``: it never opens a
second connection and never reconfigures the shared one (every request carries the
key the client already has). Chat streaming stays on the browser path (design D5);
this adapter adds what the chat window and the provider menu need:

- the capability manifest (``can``), from what the Gateway offered in hello-ok;
- models and effort per chat (``models`` / ``set_prefs``);
- approvals and questions kept per agent + session (ApprovalBook / QuestionBook),
  answered only for an id that belongs to the posted agent + session;
- background tasks, the task progress card, the agents' browser, agent files and
  the provider menu (allow-listed methods, secrets redacted).

Access: "chat" (Chat only) still chats, switches model/effort, answers approvals
and questions, reads files; every settings write, admin read, the browser and
file writes need "full". The Gateway enforces the same through the scopes the
client asked for (no operator.admin under Chat only).
"""

from __future__ import annotations

import base64
import os
import queue
import re
import struct
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Callable, Iterable

from openclaw_device import pairing_status
from openclaw_gateway_client import ACCESS_CHAT, GatewayClientError, normalize_access, scope_problem

KIND = "openclaw"

# -- texts (design 3.6) ------------------------------------------------------------------------------------------
CHAT_ONLY_FIX = "Open Agent Providers, Edit the connection and choose Full access."
CHAT_ONLY_SETTINGS = "This connection has Chat only access: OpenClaw's settings are not changed from here."
CHAT_ONLY_ADMIN_READ = "This connection has Chat only access: edit the connection to see and change this."
CHAT_ONLY_FILES = "This connection has Chat only access: the agents' files on OpenClaw are not changed from here."
CHAT_ONLY_BROWSER = ("This connection is set up for chat only: the agents' browser needs Full access "
                     "(Agent Providers, then its connection).")
NO_ADMIN_GRANT = "The gateway did not give this connection operator.admin, which the agents' browser needs."
NO_BROWSER = "This gateway has no browser."
UNREACHABLE = "The gateway is not answering."
UNREACHABLE_FIX = "Check that OpenClaw's gateway is running at this address; the office keeps trying by itself."
AUTH_REFUSED = "The gateway refused the token."
AUTH_REFUSED_FIX = "Enter the gateway token again (Edit)."
TASK_GONE = "This task is no longer available."
TASK_STOP_REASON = "Stopped from the office"

# -- event lists -------------------------------------------------------------------------------------------------
# Gateway events the adapter subscribes to (the books, tasks, presence, progress card).
ADAPTER_EVENTS = frozenset({
    "exec.approval.requested", "exec.approval.resolved", "plugin.approval.requested", "plugin.approval.resolved",
    "session.approval", "question.requested", "question.resolved", "progressCard.changed", "task",
    "sessions.changed",
})
# Frames every chat of the office receives, whatever agent it shows (connection state, cron page).
GLOBAL_EVENTS = frozenset({"proxy.ready", "proxy.error", "cron", "shutdown"})
# Events for every chat of their agent (drawer dots, the Tasks "All of agent" view), not one session.
AGENT_WIDE_EVENTS = frozenset({"sessions.changed", "task"})
# Stream frames that may carry no identity at all: delivered as today (the page matches its runId).
UNTARGETED_STREAM_EVENTS = frozenset({"chat", "agent", "session.message"})

APPROVAL_DECISIONS = ("allow-once", "allow-always", "deny")
_DONE_STEPS = frozenset({"done", "completed", "complete", "skipped", "cancelled", "canceled", "failed", "error"})
TASKS_ACTIVE = ["queued", "running"]
TASKS_FINISHED = ["completed", "failed", "timed_out", "cancelled"]

# -- the provider menu (design 2.7, 3.7) -------------------------------------------------------------------------
MENU_WRITES = frozenset({
    "agents.create", "agents.update", "agents.delete", "skills.update", "plugins.setEnabled", "cron.update",
    "cron.run", "cron.remove", "exec.approvals.set", "exec.approval.grants.revoke", "sessions.delete",
    "config.patch",
})
MENU_ADMIN_READS = frozenset({
    "config.get", "config.schema.lookup", "settings.outline", "exec.approvals.get", "exec.approval.grants.list",
    "plugins.inspect", "update.status", "system.info",
})
MENU_READS = frozenset({
    "agents.list", "models.list", "models.authStatus", "skills.status", "tools.effective", "tools.catalog",
    "plugins.list", "cron.list", "exec.approval.list", "sessions.list", "channels.status",
}) | MENU_ADMIN_READS
_NAMED_SECRET = re.compile(r"(token|secret|password|passphrase|apikey|api_key|privatekey|private_key|credential)s?$", re.I)

# -- browser (design 2.9, S§3) -----------------------------------------------------------------------------------
BROWSER_KEYS = frozenset({
    "Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home",
    "End", "PageUp", "PageDown",
})
_TARGET = re.compile(r"^[\w-]{1,128}$")
_URL_MAX = 2048
_TEXT_MAX = 2000
_FRAME_MAX = 8 * 1024 * 1024
_FRAME_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")
_DOC_MAX = 2 * 1024 * 1024

_STATUS = {"bad_request": 400, "unsupported": 400, "chat_only": 403, "forbidden": 403, "not_found": 404,
           "conflict": 409, "too_large": 413, "offline": 503, "unavailable": 502, "gateway": 502}


class ProviderError(Exception):
    """A refusal or failure with a code, a plain message, an optional fix and an HTTP status."""

    def __init__(self, code: str, message: str, *, fix: str | None = None, status: int | None = None,
                 details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fix = fix
        self.status = status or _STATUS.get(code, 400)
        self.details = details

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": False, "code": self.code, "error": self.message}
        if self.fix:
            out["fix"] = self.fix
        return out


def _chat_only(text: str) -> ProviderError:
    return ProviderError("chat_only", text, fix=CHAT_ONLY_FIX, status=403)


# -- identity helpers --------------------------------------------------------------------------------------------
_AGENT_IN_KEY = re.compile(r"^agent:([^:]+):", re.I)


def _norm_agent(agent_id: Any) -> str:
    return str(agent_id or "").strip().lower()


def _refused_property(exc: Exception, name: str) -> bool:
    """True when the gateway refused a request because its schema does not know ``name`` (an older OpenClaw)."""
    message = str(getattr(exc, "message", "") or "")
    return getattr(exc, "code", "") == "gateway" and bool(
        re.search(r"unexpected property\W{0,3}" + re.escape(name) + r"\b", message))


def _task_end_time(task: Any) -> float:
    """When a task ended, for newest-first sorting: epoch ms numbers or ISO text; unknown sorts last."""
    if not isinstance(task, dict):
        return 0.0
    for field in ("endedAt", "finishedAt", "updatedAt"):
        value = task.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str) and value:
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
            except ValueError:
                continue
    return 0.0


def norm_session_key(key: Any, agent_id: Any = None) -> str:
    """``agent:<id>:<rest>`` in lower case; a bare key is placed under ``agent_id``."""
    text = str(key or "").strip().lower()
    if text and not text.startswith("agent:") and _norm_agent(agent_id):
        text = f"agent:{_norm_agent(agent_id)}:{text}"
    return text


def _agent_of_key(key: Any) -> str:
    match = _AGENT_IN_KEY.match(str(key or ""))
    return match.group(1).lower() if match else ""


def event_identity(event: Any) -> tuple[str, str]:
    """(agent id, session key) of a Gateway event, both '' when it carries none."""
    payload = event.get("payload") if isinstance(event, dict) else None
    if not isinstance(payload, dict):
        return "", ""
    places = [payload]
    for name in ("request", "task", "approval", "session"):
        if isinstance(payload.get(name), dict):
            places.append(payload[name])
    key = agent = ""
    for place in places:
        for field in ("sessionKey", "ownerKey", "childSessionKey"):
            if not key and isinstance(place.get(field), str) and place[field]:
                key = place[field]
        if not agent and isinstance(place.get("agentId"), str) and place["agentId"]:
            agent = place["agentId"]
    agent = _norm_agent(agent) or _agent_of_key(key)
    return agent, norm_session_key(key, agent)


def event_matches(event: Any, agent_id: Any, session_key: Any = None) -> bool:
    """Whether a Gateway event (or proxy frame) belongs to a chat of ``agent_id``
    (and, when given, its session ``session_key``). Used to filter the events
    stream per agent + session (design D5); GLOBAL_EVENTS go to everyone."""
    if not isinstance(event, dict):
        return False
    if event.get("type") != "event":
        return True
    name = event.get("event")
    if name in GLOBAL_EVENTS:
        return True
    agent, key = event_identity(event)
    if not agent and not key:
        return name in UNTARGETED_STREAM_EVENTS
    wanted_agent = _norm_agent(agent_id)
    if wanted_agent and agent and agent != wanted_agent:
        return False
    if session_key and key and name not in AGENT_WIDE_EVENTS:
        return key == norm_session_key(session_key, wanted_agent or agent)
    return True


def _ms(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


# -- books -------------------------------------------------------------------------------------------------------
class _Book:
    """Pending items per agent + session, bounded, expiring by ``expiresAt`` (ms)."""

    def __init__(self, limit: int = 500, clock: Callable[[], float] = time.time) -> None:
        self._lock = threading.RLock()
        self._items: dict[str, dict[str, Any]] = {}
        self._limit = max(1, int(limit))
        self._clock = clock

    def _put(self, item_id: str, entry: dict[str, Any]) -> None:
        with self._lock:
            self._items.pop(item_id, None)
            self._items[item_id] = entry
            while len(self._items) > self._limit:
                self._items.pop(next(iter(self._items)))

    def _prune(self) -> None:
        now = self._clock() * 1000
        for item_id in [i for i, e in self._items.items() if e.get("expiresAt") and e["expiresAt"] < now]:
            self._items.pop(item_id, None)

    def pending(self, agent_id: Any, session_key: Any) -> list[dict[str, Any]]:
        agent = _norm_agent(agent_id)
        key = norm_session_key(session_key, agent)
        with self._lock:
            self._prune()
            return [dict(e["card"]) for e in self._items.values()
                    if e["sessionKey"] == key and (not e["agentId"] or e["agentId"] == agent)]

    def lookup(self, agent_id: Any, session_key: Any, item_id: Any) -> dict[str, Any] | None:
        agent = _norm_agent(agent_id)
        key = norm_session_key(session_key, agent)
        with self._lock:
            self._prune()
            entry = self._items.get(str(item_id or ""))
            if not entry or entry["sessionKey"] != key or (entry["agentId"] and entry["agentId"] != agent):
                return None
            return dict(entry)

    def all_pending(self) -> list[dict[str, Any]]:
        """Every unexpired pending item (read-only copies of the routing fields, no card text)."""
        with self._lock:
            self._prune()
            return [{"id": e["id"], "kind": e.get("kind") or "", "agentId": e["agentId"], "sessionKey": e["sessionKey"],
                     "expiresAt": e.get("expiresAt")} for e in self._items.values()]

    def remove(self, item_id: Any) -> dict[str, Any] | None:
        with self._lock:
            return self._items.pop(str(item_id or ""), None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


class ApprovalBook(_Book):
    """Exec / plugin approvals waiting for an answer, from the adapter's own subscription."""

    def feed(self, name: str, payload: Any) -> dict[str, Any] | None:
        """Takes one Gateway event; returns the universal event it means, or None."""
        if not isinstance(payload, dict):
            return None
        if name == "session.approval":
            approval = payload.get("approval") if isinstance(payload.get("approval"), dict) else {}
            shown = approval.get("presentation") if isinstance(approval.get("presentation"), dict) else {}
            kind = shown.get("kind") if shown.get("kind") in ("plugin", "system-agent") else "exec"
            if payload.get("phase") == "pending":
                request = {"command": shown.get("commandText"), "warningText": shown.get("warningText"),
                           "title": shown.get("title"), "description": shown.get("description"),
                           "toolName": shown.get("toolName"), "pluginId": shown.get("pluginId"),
                           "allowedDecisions": shown.get("allowedDecisions"), "sessionKey": payload.get("sessionKey"),
                           "agentId": approval.get("agentId") or payload.get("agentId")}
                return self._asked(kind, {"id": approval.get("id"), "expiresAtMs": approval.get("expiresAtMs"),
                                          "request": request})
            decision = (approval.get("decision") or "allow-once") if approval.get("status") == "allowed" else "deny"
            return self._answered({"id": approval.get("id"), "decision": decision})
        if name in ("exec.approval.requested", "plugin.approval.requested"):
            return self._asked("plugin" if name.startswith("plugin") else "exec", payload)
        if name in ("exec.approval.resolved", "plugin.approval.resolved"):
            return self._answered(payload)
        return None

    def seed(self, rows: Any, kind: str = "exec") -> list[dict[str, Any]]:
        """Adds the pending approvals of an ``exec.approval.list`` reply (``[{id, request, createdAtMs,
        expiresAtMs, approvalKind}]``): the ones asked before the subscription started. Returns the
        universal events of the ones not known yet (known ones are refreshed, never repeated)."""
        out: list[dict[str, Any]] = []
        for row in (rows if isinstance(rows, list) else [])[:self._limit]:
            if not isinstance(row, dict):
                continue
            row_kind = row.get("approvalKind") if row.get("approvalKind") in ("exec", "plugin") else kind
            expires = _ms(row.get("expiresAtMs"))
            if expires and expires < self._clock() * 1000:
                continue
            event = self._asked(row_kind, row)
            if event:
                out.append(event)
        return out

    def _asked(self, kind: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        approval_id = str(payload.get("id") or "")
        request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
        agent = _norm_agent(request.get("agentId")) or _agent_of_key(request.get("sessionKey"))
        key = norm_session_key(request.get("sessionKey"), agent)
        if not approval_id or not key:
            return None
        allowed = request.get("allowedDecisions")
        options = [d for d in APPROVAL_DECISIONS if not isinstance(allowed, list) or not allowed or d in allowed]
        analysis = request.get("commandAnalysis") if isinstance(request.get("commandAnalysis"), dict) else {}
        risks = [str(x) for x in analysis.get("warningLines") or [] if isinstance(x, str)]
        card: dict[str, Any] = {
            "approvalId": approval_id,
            "approvalKind": kind,
            "tool": "exec" if kind == "exec" else str(request.get("toolName") or request.get("pluginId") or "plugin"),
            "title": "Run a command" if kind == "exec" else str(request.get("title") or "Allow this action")[:200],
            "summary": str(request.get("warningText") or " ".join(risks) or request.get("description") or "")[:1000],
            "options": options or ["deny"],
        }
        if isinstance(request.get("command"), str):
            card["command"] = request["command"][:8000]
        if isinstance(request.get("cwd"), str):
            card["cwd"] = request["cwd"][:1000]
        expires = _ms(payload.get("expiresAtMs"))
        if expires:
            card["expiresAt"] = expires
        with self._lock:
            known = approval_id in self._items
        self._put(approval_id, {"id": approval_id, "kind": kind, "agentId": agent, "sessionKey": key,
                                "expiresAt": expires, "options": card["options"], "card": card})
        if known:
            return None
        return {"type": "approval.requested", "agentId": agent, "sessionKey": key, **card}

    def _answered(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        entry = self.remove(payload.get("id"))
        if not entry:
            return None
        return {"type": "approval.resolved", "agentId": entry["agentId"], "sessionKey": entry["sessionKey"],
                "approvalId": entry["id"], "decision": str(payload.get("decision") or "")}


class QuestionBook(_Book):
    """Questions an agent asked the person (ask_user), waiting for answers."""

    def feed(self, name: str, payload: Any) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None
        if name == "question.requested":
            return self.asked(payload)
        if name == "question.resolved":
            entry = self.remove(payload.get("id"))
            if not entry:
                return None
            return {"type": "question.resolved", "agentId": entry["agentId"], "sessionKey": entry["sessionKey"],
                    "questionId": entry["id"], "status": str(payload.get("status") or "answered")}
        return None

    def asked(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        question_id = str(payload.get("id") or "")
        agent = _norm_agent(payload.get("agentId")) or _agent_of_key(payload.get("sessionKey"))
        key = norm_session_key(payload.get("sessionKey"), agent)
        rows = payload.get("questions") if isinstance(payload.get("questions"), list) else []
        if not question_id or not key or not rows or (payload.get("status") not in (None, "pending")):
            return None
        questions = []
        for index, row in enumerate(rows[:5]):
            if not isinstance(row, dict):
                continue
            options = [{"label": str(o.get("label") or "")[:200], "description": str(o.get("description") or "")[:500]}
                       for o in (row.get("options") or [])[:8] if isinstance(o, dict) and o.get("label")]
            questions.append({
                "questionId": str(row.get("id") or index),
                "header": str(row.get("header") or "")[:120],
                "question": str(row.get("question") or row.get("prompt") or "")[:2000],
                "options": options,
                "multiSelect": bool(row.get("multiSelect")),
                "secret": bool(row.get("isSecret")),
                "other": True,
            })
        if not questions:
            return None
        card: dict[str, Any] = {"questionId": question_id, "questions": questions}
        expires = _ms(payload.get("expiresAtMs"))
        if expires:
            card["expiresAt"] = expires
        with self._lock:
            known = question_id in self._items
        self._put(question_id, {"id": question_id, "agentId": agent, "sessionKey": key, "expiresAt": expires,
                                "ids": {q["questionId"] for q in questions}, "card": card})
        if known:
            return None
        return {"type": "question.requested", "agentId": agent, "sessionKey": key, **card}


# -- small pure helpers ------------------------------------------------------------------------------------------
def models_to_picker(result: Any) -> dict[str, Any]:
    rows = result.get("models") if isinstance(result, dict) and isinstance(result.get("models"), list) else []
    rows = [m for m in rows if isinstance(m, dict) and m.get("id") and m.get("available") is not False]

    def ref(model: dict) -> str:
        return f"{model['provider']}/{model['id']}" if model.get("provider") else str(model["id"])

    default = next((ref(m) for m in rows if isinstance(m.get("tags"), list) and "default" in m["tags"]), None)
    models = []
    for model in rows[:300]:
        item: dict[str, Any] = {"id": ref(model), "label": str(model.get("name") or model["id"])[:120],
                                "reasoning": bool(model.get("reasoning"))}
        if isinstance(model.get("contextWindow"), (int, float)):
            item["context"] = model["contextWindow"]
        if isinstance(model.get("input"), list):
            item["images"] = "image" in model["input"]
        if isinstance(model.get("thinkingLevels"), list):
            item["effort"] = [{"id": str(x["id"]), "label": str(x.get("label") or x["id"])}
                              for x in model["thinkingLevels"] if isinstance(x, dict) and x.get("id")]
        if model.get("thinkingDefault"):
            item["effortDefault"] = str(model["thinkingDefault"])
        models.append(item)
    return {"default": default, "models": models}


def session_row(row: dict[str, Any]) -> dict[str, Any]:
    title = (row.get("label") or row.get("displayName") or row.get("derivedTitle")
             or str(row.get("lastMessagePreview") or "")[:60] or "Chat")
    model = row.get("model")
    if model and row.get("modelProvider"):
        model = f"{row['modelProvider']}/{model}"
    return {"key": str(row.get("key")), "title": str(title)[:120], "updatedAt": row.get("updatedAt") or row.get("createdAt"),
            "model": model or None, "effort": row.get("thinkingLevel") or None, "active": bool(row.get("hasActiveRun"))}


def card_view(card: Any) -> dict[str, Any] | None:
    if not isinstance(card, dict):
        return None
    out: dict[str, Any] = {"steps": card["steps"] if isinstance(card.get("steps"), list) else [],
                           "markdown": str(card.get("markdown") or "")}
    if isinstance(card.get("revision"), int):
        out["revision"] = card["revision"]
    if isinstance(card.get("updatedAt"), (int, float)):
        out["updatedAt"] = card["updatedAt"]
    return out


def messages_view(rows: Any, limit: int = 100) -> list[dict[str, Any]]:
    out = []
    for row in (rows if isinstance(rows, list) else [])[:limit]:
        if not isinstance(row, dict):
            continue
        content = row.get("content")
        if isinstance(content, list):
            text = "\n".join(str(p.get("text") or "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        else:
            text = str(content or row.get("text") or "")
        out.append({"role": str(row.get("role") or ""), "text": text[:20000],
                    **({"at": row["timestamp"]} if isinstance(row.get("timestamp"), (int, float)) else {})})
    return out


def _schema_matcher(path: str) -> re.Pattern:
    parts = ["[^.]+" if part == "*" else re.escape(part) for part in path.split(".")]
    return re.compile("^" + r"\.".join(parts) + "$")


def redact(value: Any, sensitive: Iterable[re.Pattern] = (), path: str = "") -> Any:
    """Every value the Gateway marks sensitive (or named like a secret) becomes ``{secret: True, set}``."""
    key = path.rsplit(".", 1)[-1]
    if path and (any(m.match(path) for m in sensitive) or _NAMED_SECRET.search(key)):
        if value is not None and not isinstance(value, (bool, int, float)):
            return {"secret": True, "set": value != ""}
    if isinstance(value, list):
        return [redact(v, sensitive, f"{path}.{i}" if path else str(i)) for i, v in enumerate(value[:500])]
    if isinstance(value, dict):
        return {k: redact(v, sensitive, f"{path}.{k}" if path else str(k)) for k, v in list(value.items())[:2000]}
    return value


def web_url(value: Any, blank: bool = False) -> str:
    text = str(value or "").strip()
    if blank and (not text or text == "about:blank"):
        return "about:blank"
    if not text or len(text) > _URL_MAX:
        raise ProviderError("bad_request", "Enter an address")
    if not re.match(r"^[a-z][a-z\d+.-]*:", text, re.I):
        text = f"https://{text}"
    scheme = text.split(":", 1)[0].lower()
    if scheme not in ("http", "https"):
        raise ProviderError("bad_request", "Only web addresses (http and https) open here")
    if not re.match(r"^https?://[^/\s?#]+", text, re.I):
        raise ProviderError("bad_request", "That is not a web address")
    return text


def image_size(data: bytes) -> tuple[int, int] | None:
    """(width, height) of a PNG or JPEG, from its header."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:2] == b"\xff\xd8":
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                height, width = struct.unpack(">HH", data[index + 5:index + 9])
                return width, height
            index += 2 + struct.unpack(">H", data[index + 2:index + 4])[0]
    return None


def _num(value: Any, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ProviderError("bad_request", "Not a number") from None
    if number != number:
        raise ProviderError("bad_request", "Not a number")
    return min(high, max(low, number))


def _target(tab: Any) -> str:
    if not isinstance(tab, str) or not _TARGET.match(tab):
        raise ProviderError("bad_request", "Which tab?")
    return tab


def _rel(path: Any) -> str:
    return str(path or "").replace("\\", "/").strip("/")[:1000]


# -- the adapter -------------------------------------------------------------------------------------------------
class OpenClawAdapter:
    """Adapter call set (design 2.4) for the office's OpenClaw connection.

    ``client_getter()`` returns the shared OpenClawGatewayClient. ``config_key_getter()``
    returns the key the server uses for it (default: the client's current key).
    ``access_getter()`` returns the connection's access level ("full" / "chat"); default:
    the level the live connection was opened with. ``media_roots``: folders a browser
    screenshot path may be read from (the Gateway host's media store, when shared).
    """

    kind = KIND

    def __init__(self, client_getter: Callable[[], Any], *, config_key_getter: Callable[[], Any] | None = None,
                 access_getter: Callable[[], Any] | None = None, media_roots: Iterable[str] = (),
                 connection_id: str = "openclaw", connection_name: str = "OpenClaw",
                 clock: Callable[[], float] = time.time, logger: Callable[[str], None] | None = None) -> None:
        self._client_getter = client_getter
        self._config_key_getter = config_key_getter
        self._access_getter = access_getter
        self._media_roots = [os.path.realpath(r) for r in media_roots if r]
        self.connection_id = connection_id
        self.connection_name = connection_name
        self._clock = clock
        self._logger = logger or (lambda _message: None)
        self.approvals = ApprovalBook(clock=clock)
        self.questions = QuestionBook(clock=clock)
        self._prefs: dict[tuple[str, str], dict[str, Any]] = {}
        self._frames: dict[str, dict[str, Any]] = {}
        self._schema_cache: dict[str, Any] = {}
        self._tasks_sort_local_until = 0.0
        self._state_lock = threading.RLock()
        self._listeners: list[Callable[[dict[str, Any]], None]] = []
        self._pump: threading.Thread | None = None
        self._pump_stop = threading.Event()
        self._subscription = None

    # ---- plumbing ----------------------------------------------------------------------------------------------
    def _client(self) -> Any:
        client = self._client_getter()
        if client is None:
            raise ProviderError("offline", UNREACHABLE, fix=UNREACHABLE_FIX)
        return client

    def _key(self, client: Any) -> Any:
        if self._config_key_getter is not None:
            return self._config_key_getter()
        return client.current_config_key()

    def access(self) -> str:
        if self._access_getter is not None:
            return normalize_access(self._access_getter())
        try:
            return normalize_access(self._client().status().get("access"))
        except ProviderError:
            return "full"

    def _require_full(self, text: str) -> None:
        if self.access() == ACCESS_CHAT:
            raise _chat_only(text)

    def _ensure_connected(self, timeout: float = 3.0) -> Any:
        client = self._client()
        if client.status().get("connected"):
            return client
        key = self._key(client)
        if key is not None:
            try:
                client.start(key)
            except GatewayClientError:
                pass
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            if client.status().get("connected"):
                return client
            time.sleep(0.05)
        state = self.status()
        raise ProviderError("offline", state.get("detail") or UNREACHABLE, fix=state.get("fix") or UNREACHABLE_FIX)

    def _need(self, method: str) -> Any:
        client = self._ensure_connected()
        if not client.offers(method):
            raise ProviderError("unsupported", f"This OpenClaw gateway does not offer {method}")
        return client

    def _call(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 20.0,
              expected_generation: int | None = None) -> Any:
        client = self._client()
        try:
            response = client.request(method, params or {}, timeout=timeout, config_key=self._key(client),
                                      expected_generation=expected_generation)
        except GatewayClientError as exc:
            raise ProviderError("offline", UNREACHABLE, fix=UNREACHABLE_FIX, details=str(exc)[:300]) from exc
        if not isinstance(response, dict) or not response.get("ok"):
            error = response.get("error") if isinstance(response, dict) and isinstance(response.get("error"), dict) else {}
            message = str(error.get("message") or f"The gateway refused {method}")[:500]
            code = "unsupported" if message.startswith("unknown method") else "gateway"
            raise ProviderError(code, message, details={"gatewayCode": error.get("code"), "details": error.get("details")})
        return response.get("payload")

    # ---- events ------------------------------------------------------------------------------------------------
    def on_event(self, callback: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        """Universal events (approval/question requested+resolved, session.task, agent.activity,
        plan.changed), each with ``kind``, ``agentId`` and ``sessionKey``."""
        with self._state_lock:
            self._listeners.append(callback)

        def remove() -> None:
            with self._state_lock:
                if callback in self._listeners:
                    self._listeners.remove(callback)
        return remove

    def _publish(self, event: dict[str, Any]) -> None:
        event = {"kind": KIND, "connectionId": self.connection_id, **event}
        with self._state_lock:
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(event)
            except Exception as exc:  # a listener's failure never stops the pump
                self._logger(f"[openclaw-adapter] listener failed: {exc}")

    def feed(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        """Takes one Gateway frame (from the pump, or a test) and publishes what it means."""
        out: list[dict[str, Any]] = []
        if not isinstance(event, dict):
            return out
        if event.get("type") != "event":
            if event.get("type") == "proxy.ready":
                out.append({"type": "provider.status", **self.status()})
            for item in out:
                self._publish(item)
            return out
        name, payload = event.get("event"), event.get("payload")
        agent, key = event_identity(event)
        change = self.approvals.feed(name, payload) or self.questions.feed(name, payload)
        if change:
            out.append(change)
        elif name == "progressCard.changed" and key:
            out.append({"type": "plan.changed", "agentId": agent, "sessionKey": key,
                        "revision": payload.get("revision") if isinstance(payload, dict) else None})
        elif name == "task" and isinstance(payload, dict):
            out.append({"type": "session.task", "agentId": agent, "sessionKey": key,
                        "change": str(payload.get("action") or "upserted"),
                        **({"task": payload["task"]} if isinstance(payload.get("task"), dict) else {}),
                        **({"taskId": str(payload["taskId"])} if payload.get("taskId") else {})})
        elif name == "sessions.changed" and isinstance(payload, dict) and key:
            out.append({"type": "agent.activity", "agentId": agent, "sessionKey": key,
                        "active": bool(payload.get("hasActiveRun"))})
        for item in out:
            self._publish(item)
        return out

    def subscribe_events(self, events: Any, max_events: int = 256) -> Any:
        """A read-only subscription to exactly ``events`` on the shared client (same config key as
        the pump). The caller pumps and closes it."""
        client = self._client()
        return client.subscribe(config_key=self._key(client), events=frozenset(events), max_events=max_events)

    def seed_approvals(self, timeout: float = 10.0) -> int:
        """One read-only ``exec.approval.list``: exec approvals asked before the pump started are
        published once like new ones (questions have no list method: they come back only when the
        gateway sends them again). Returns how many were added; 0 when the gateway cannot answer."""
        try:
            rows = self._call("exec.approval.list", {}, timeout=timeout)
        except ProviderError:
            return 0
        events = self.approvals.seed(rows, "exec")
        for item in events:
            self._publish(item)
        return len(events)

    def start(self) -> None:
        """Starts the event pump (one subscription on the shared client, named events only)."""
        with self._state_lock:
            if self._pump and self._pump.is_alive():
                return
            client = self._client()
            self._subscription = client.subscribe(config_key=self._key(client), events=ADAPTER_EVENTS, max_events=1024)
            self._pump_stop.clear()
            self._pump = threading.Thread(target=self._pump_main, args=(self._subscription,),
                                          name="vo-openclaw-adapter", daemon=True)
            self._pump.start()

    def _pump_main(self, subscription: Any) -> None:
        while not self._pump_stop.is_set():
            try:
                event = subscription.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self.feed(event)
            except Exception as exc:
                self._logger(f"[openclaw-adapter] event skipped: {exc}")

    def close(self, cid: Any = None, reason: str | None = None) -> None:
        self._pump_stop.set()
        with self._state_lock:
            subscription, self._subscription = self._subscription, None
            pump, self._pump = self._pump, None
        if subscription is not None:
            subscription.close()
        if pump is not None and pump is not threading.current_thread():
            pump.join(timeout=2)
        self.approvals.clear()
        self.questions.clear()

    # ---- connection --------------------------------------------------------------------------------------------
    def status(self, cid: Any = None) -> dict[str, Any]:
        try:
            state = self._client().status()
        except ProviderError:
            return {"state": "offline", "code": "unreachable", "detail": UNREACHABLE, "fix": UNREACHABLE_FIX,
                    "version": None, "access": self.access()}
        base = {"version": state.get("version"), "access": normalize_access(state.get("access"))
                if self._access_getter is None else self.access()}
        waiting = pairing_status(state.get("device"))
        if waiting and not state.get("connected"):
            return {**waiting, **base}
        if state.get("connected"):
            problem = scope_problem(state.get("missingScopes"))
            if problem:
                return {**problem, **base}
            return {"state": "connected", "code": None, "detail": "Connected", "fix": None, **base}
        error = str(state.get("lastError") or "")
        if re.search(r"token|unauthori[sz]ed|auth(entication)? failed|AUTH_", error, re.I):
            return {"state": "error", "code": "auth_rejected", "detail": AUTH_REFUSED, "fix": AUTH_REFUSED_FIX, **base}
        if not error and not state.get("generation"):
            return {"state": "connecting", "code": None, "detail": "Connecting...", "fix": None, **base}
        return {"state": "offline", "code": "unreachable", "detail": UNREACHABLE, "fix": UNREACHABLE_FIX, **base}

    def test(self, values: Any = None, timeout: float = 8.0) -> dict[str, Any]:
        """Whether the office's live connection is up (it never opens another one)."""
        try:
            self._ensure_connected(timeout)
        except ProviderError:
            pass
        state = self.status()
        if state["state"] == "connected":
            return {"ok": True, "state": "connected", "detail": state["detail"], "version": state["version"],
                    **({"code": state["code"], "fix": state["fix"]} if state.get("code") else {})}
        return {"ok": False, "state": state["state"], "code": state["code"], "detail": state["detail"], "fix": state["fix"],
                **({"requestId": state["requestId"]} if state.get("requestId") else {})}

    def agents(self, cid: Any = None) -> dict[str, Any]:
        client = self._need("agents.list")
        result = self._call("agents.list", {}) or {}
        rows = [a for a in (result.get("agents") or []) if isinstance(a, dict) and isinstance(a.get("id"), str)
                and a["id"] and a.get("kind") != "system"][:200]
        identities: list[Any] = [None] * len(rows)
        if rows and client.offers("agent.identity.get"):
            def ask(agent_id: str) -> Any:
                try:
                    return self._call("agent.identity.get", {"agentId": agent_id}, timeout=8)
                except ProviderError:
                    return None
            with ThreadPoolExecutor(max_workers=4) as pool:
                identities = list(pool.map(ask, [a["id"] for a in rows]))
        agents = []
        for row, ident in zip(rows, identities):
            ident = ident if isinstance(ident, dict) else {}
            own = row.get("identity") if isinstance(row.get("identity"), dict) else {}
            name = ((ident.get("name") if ident.get("nameSource") != "default" else None) or own.get("name")
                    or row.get("name") or row["id"])
            agents.append({"id": row["id"][:120], "name": str(name)[:60],
                           "emoji": str(ident.get("emoji") or own.get("emoji") or "")[:32]})
        return {"defaultId": str(result["defaultId"]) if result.get("defaultId") else None, "agents": agents}

    def can(self, agent: Any, key: Any = None, *, manage: bool = False) -> dict[str, Any]:
        """The capability manifest (design 4.1) from what the live Gateway offers."""
        state = self.status()
        if state["state"] != "connected":
            return {"ok": False, "reason": "offline", "message": state["detail"], "fix": state["fix"]}
        client = self._client()
        offers = client.offers
        full = self.access() != ACCESS_CHAT
        browser_offered = offers("browser.request")
        browser_ok = full and browser_offered and client.grants("operator.admin")
        locked: dict[str, str] = {}
        if browser_offered and not full:
            locked["browser"] = CHAT_ONLY_BROWSER
        elif browser_offered and not browser_ok:
            locked["browser"] = NO_ADMIN_GRANT
        if offers("agents.files.set") and not full:
            locked["computerWrite"] = CHAT_ONLY_FILES
        approvals = offers("approval.resolve") or offers("exec.approval.resolve") or offers("plugin.approval.resolve")
        caps = {
            "stream": True, "sessions": True, "sessionCreate": True, "sessionRename": offers("sessions.patch"),
            "sessionDelete": full and offers("sessions.delete"), "history": True, "stop": True,
            "models": offers("models.list"), "effort": offers("models.list") and offers("sessions.patch"),
            "context": True, "attachments": True,
            "files": offers("agents.files.list") or offers("agents.workspace.list"),
            "approvals": approvals, "approvalOptions": list(APPROVAL_DECISIONS) if approvals else [],
            "questions": offers("question.resolve"), "secrets": False,
            "plan": True, "progressCard": offers("progressCard.get"),
            "progressRefresh": offers("progressCard.refresh"), "progressDismiss": offers("progressCard.put"),
            "tasks": offers("tasks.list"), "taskSteer": False, "taskCancel": offers("tasks.cancel"),
            "queue": "steer", "observe": False, "presence": True, "titles": False, "media": True,
            "browser": browser_ok, "screen": False,
            "computer": offers("agents.files.list") or offers("agents.workspace.list"),
            "computerWrite": full and offers("agents.files.set"),
        }
        policy = client.hello().get("policy") or {}
        attachments = policy.get("attachments") or {}
        limits = {k: v for k, v in (("attachmentBytes", attachments.get("maxBytes")),
                                    ("maxFiles", attachments.get("maxCount"))) if v is not None}
        with self._state_lock:
            prefs = dict(self._prefs.get((_norm_agent(agent), norm_session_key(key, agent)), {}))
        return {
            "ok": True, "agent": str(agent or ""), "kind": KIND, "transport": "openclaw", "view": "default",
            "manage": bool(manage), "access": "full" if full else "chat",
            "connection": {"id": self.connection_id, "name": self.connection_name, "state": state["state"],
                           "detail": state["detail"], "fix": state["fix"]},
            "caps": caps, "locked": locked, "limits": limits,
            "prefs": {"model": prefs.get("model"), "effort": prefs.get("effort")},
        }

    # ---- sessions, models, prefs -------------------------------------------------------------------------------
    def sessions(self, agent: Any, limit: int = 100) -> dict[str, Any]:
        self._need("sessions.list")
        result = self._call("sessions.list", {"agentId": str(agent), "limit": max(1, min(200, int(limit))),
                                               "includeDerivedTitles": True, "includeLastMessage": True,
                                               "excludeCron": True}) or {}
        rows = [r for r in (result.get("sessions") or []) if isinstance(r, dict) and r.get("key") and not r.get("isBackground")]
        return {"sessions": [session_row(r) for r in rows]}

    def session_op(self, agent: Any, op: str, key: Any, args: dict[str, Any] | None = None) -> dict[str, Any]:
        args = args or {}
        if op == "create":
            self._need("sessions.create")
            result = self._call("sessions.create", {"agentId": str(agent)}) or {}
            return {"ok": True, "key": result.get("key") or result.get("sessionKey")}
        if not key:
            raise ProviderError("bad_request", "Which chat?")
        if op == "rename":
            self._need("sessions.patch")
            label = str(args.get("title") or args.get("label") or "").strip()[:120]
            self._call("sessions.patch", {"key": str(key), "agentId": str(agent), "label": label or None})
            return {"ok": True}
        if op == "delete":
            self._require_full(CHAT_ONLY_SETTINGS)
            self._need("sessions.delete")
            self._call("sessions.delete", {"key": str(key), "agentId": str(agent)})
            with self._state_lock:
                self._prefs.pop((_norm_agent(agent), norm_session_key(key, agent)), None)
            return {"ok": True}
        raise ProviderError("unsupported", f"There is no chat operation {op}")

    def models(self, agent: Any, key: Any = None) -> dict[str, Any]:
        self._need("models.list")
        params: dict[str, Any] = {"agentId": str(agent)}
        if key:
            params["sessionKey"] = str(key)
        picker = models_to_picker(self._call("models.list", params))
        with self._state_lock:
            picker["current"] = dict(self._prefs.get((_norm_agent(agent), norm_session_key(key, agent)), {}))
        return picker

    _UNSET = object()

    def set_prefs(self, agent: Any, key: Any, model: Any = _UNSET, effort: Any = _UNSET) -> dict[str, Any]:
        """Model and effort for one chat (both access levels): sessions.patch on the Gateway."""
        if not key:
            raise ProviderError("bad_request", "Start the chat first: the model is set per chat.")
        self._need("sessions.patch")
        patch: dict[str, Any] = {}
        if model is not self._UNSET:
            if model is not None and (not isinstance(model, str) or len(model) > 200):
                raise ProviderError("bad_request", "Which model?")
            patch["model"] = model or None
        if effort is not self._UNSET:
            if effort is not None and (not isinstance(effort, str) or not re.match(r"^[\w-]{0,40}$", effort)):
                raise ProviderError("bad_request", "Which effort?")
            patch["thinkingLevel"] = effort or None
        if not patch:
            raise ProviderError("bad_request", "Choose a model or an effort")
        self._call("sessions.patch", {"key": str(key), "agentId": str(agent), **patch})
        slot = (_norm_agent(agent), norm_session_key(key, agent))
        with self._state_lock:
            prefs = dict(self._prefs.get(slot, {}))
            if "model" in patch:
                prefs["model"] = patch["model"]
            if "thinkingLevel" in patch:
                prefs["effort"] = patch["thinkingLevel"]
            self._prefs[slot] = prefs
        return {"ok": True, "prefs": {"model": prefs.get("model"), "effort": prefs.get("effort")}}

    # ---- approvals and questions -------------------------------------------------------------------------------
    @staticmethod
    def _decision(decision: Any) -> str:
        if decision is True:
            return "allow-once"
        if decision is False:
            return "deny"
        text = str(decision or "").strip().lower()
        return {"once": "allow-once", "allow": "allow-once", "always": "allow-always", "approve": "allow-once",
                "reject": "deny", "denied": "deny"}.get(text, text)

    def approve(self, agent: Any, key: Any, run_id: Any, approval_id: Any, decision: Any) -> dict[str, Any]:
        """Answers an approval that belongs to this agent + session (both access levels)."""
        entry = self.approvals.lookup(agent, key, approval_id)
        if not entry:
            raise ProviderError("not_found", "This approval is no longer waiting.")
        choice = self._decision(decision)
        if choice not in entry["options"]:
            raise ProviderError("bad_request", "That choice is not offered for this approval.")
        client = self._ensure_connected()
        specific = "plugin.approval.resolve" if entry["kind"] == "plugin" else "exec.approval.resolve"
        approval = str(entry["id"])
        if client.offers("approval.resolve"):
            try:
                self._call("approval.resolve", {"id": approval, "kind": entry["kind"], "decision": choice})
            except ProviderError as exc:
                if exc.code != "unsupported" or not client.offers(specific):
                    raise
                self._call(specific, {"id": approval, "decision": choice})
        elif client.offers(specific):
            self._call(specific, {"id": approval, "decision": choice})
        else:
            raise ProviderError("unsupported", "This OpenClaw gateway does not take approvals from the office")
        if self.approvals.remove(approval):
            self._publish({"type": "approval.resolved", "agentId": entry["agentId"], "sessionKey": entry["sessionKey"],
                           "approvalId": approval, "decision": choice})
        return {"ok": True, "decision": choice}

    def answer(self, agent: Any, key: Any, run_id: Any, question_id: Any, answers: Any = None,
               cancel: bool = False) -> dict[str, Any]:
        entry = self.questions.lookup(agent, key, question_id)
        if not entry:
            raise ProviderError("not_found", "This question is no longer waiting for an answer.")
        self._need("question.resolve")
        qid = str(entry["id"])
        if cancel:
            self._call("question.resolve", {"id": qid, "cancel": True})
            status = "cancelled"
        else:
            if not isinstance(answers, dict) or not answers:
                raise ProviderError("bad_request", "Choose or write an answer")
            clean: dict[str, list[str]] = {}
            for name, value in list(answers.items())[:5]:
                if entry["ids"] and str(name) not in entry["ids"]:
                    raise ProviderError("bad_request", "That answer is for a question that was not asked.")
                values = value if isinstance(value, list) else [value]
                clean[str(name)] = [str(v)[:2000] for v in values[:8] if v is not None and str(v) != ""]
            if not any(clean.values()):
                raise ProviderError("bad_request", "Choose or write an answer")
            self._call("question.resolve", {"id": qid, "answers": {"answers": clean}})
            status = "answered"
        if self.questions.remove(qid):
            self._publish({"type": "question.resolved", "agentId": entry["agentId"], "sessionKey": entry["sessionKey"],
                           "questionId": qid, "status": status})
        return {"ok": True, "status": status}

    def state(self, agent: Any, key: Any) -> dict[str, Any]:
        """What a reloaded page re-shows for a chat: pending approvals and questions, the progress card."""
        if not key:
            return {"approvals": [], "questions": []}
        client = self._client()
        connected = bool(client.status().get("connected"))
        if connected and client.offers("question.list"):
            try:
                listed = self._call("question.list", {"sessionKey": str(key)}, timeout=8) or {}
                for row in listed.get("questions") or []:
                    if isinstance(row, dict):
                        self.questions.asked({"sessionKey": key, **row})
            except ProviderError:
                pass
        out: dict[str, Any] = {"approvals": self.approvals.pending(agent, key),
                               "questions": self.questions.pending(agent, key)}
        if connected and client.offers("progressCard.get"):
            try:
                out["plan"] = card_view((self._call("progressCard.get", {"sessionKey": str(key),
                                                                         "agentId": str(agent)}) or {}).get("card"))
            except ProviderError:
                pass
        return out

    # ---- tasks (side panel) ------------------------------------------------------------------------------------
    @staticmethod
    def _belongs(task: Any, agent: Any, key: Any) -> bool:
        if not isinstance(task, dict) or not key:
            return False
        wanted = norm_session_key(key, agent)
        if wanted not in (norm_session_key(task.get("sessionKey")), norm_session_key(task.get("ownerKey"))):
            return False
        return not task.get("agentId") or not agent or _norm_agent(task["agentId"]) == _norm_agent(agent)

    @staticmethod
    def _task_agent(task: Any) -> str:
        if not isinstance(task, dict):
            return ""
        if task.get("agentId"):
            return _norm_agent(task["agentId"])
        for field in ("sessionKey", "childSessionKey", "ownerKey"):
            found = _agent_of_key(task.get(field))
            if found:
                return found
        return ""

    def _scope_check(self, agent: Any, key: Any, scope: str) -> bool:
        whole = scope == "agent"
        if whole and not agent:
            raise ProviderError("bad_request", "Which agent?")
        if not whole and not key:
            raise ProviderError("bad_request", "This chat has no tasks yet")
        return whole

    def tasks(self, agent: Any, key: Any = None, scope: str = "chat") -> dict[str, Any]:
        whole = self._scope_check(agent, key, scope)
        self._need("tasks.list")
        base = {"agentId": str(agent)} if whole else {"sessionKey": str(key), **({"agentId": str(agent)} if agent else {})}
        active = self._call("tasks.list", {**base, "status": TASKS_ACTIVE, "limit": 200}) or {}
        recent = self._recent_tasks({**base, "status": TASKS_FINISHED, "limit": 100})

        def rows(result: dict) -> list[dict]:
            keep = []
            for task in result.get("tasks") or []:
                ours = (self._task_agent(task) == _norm_agent(agent)) if whole else self._belongs(task, agent, key)
                if ours:
                    keep.append({**task, "here": self._belongs(task, agent, key)})
            return keep
        return {"active": rows(active), "recent": rows(recent)}

    def _recent_tasks(self, params: dict[str, Any]) -> dict[str, Any]:
        """Finished tasks, newest first. Older OpenClaw (2026.7.x) refuses ``sortBy`` ("invalid tasks.list params:
        at root: unexpected property 'sortBy'"): then the list is asked for without it and sorted here, and
        ``sortBy`` is left out for the next 10 minutes (v0.10.1 upgrade fix: no 502 on an older gateway)."""
        if time.time() >= self._tasks_sort_local_until:
            try:
                return self._call("tasks.list", {**params, "sortBy": "endedAt"}) or {}
            except ProviderError as exc:
                if not _refused_property(exc, "sortBy"):
                    raise
                self._tasks_sort_local_until = time.time() + 600
                self._logger("[openclaw-adapter] this OpenClaw does not sort tasks.list (sortBy); sorting here")
        result = self._call("tasks.list", params) or {}
        if isinstance(result.get("tasks"), list):
            result = {**result, "tasks": sorted(result["tasks"], key=_task_end_time, reverse=True)}
        return result

    def _mine(self, agent: Any, task_id: Any, key: Any, scope: str) -> dict[str, Any]:
        whole = self._scope_check(agent, key, scope)
        if not isinstance(task_id, str) or not task_id or len(task_id) > 200:
            raise ProviderError("bad_request", "Which task?")
        self._need("tasks.get")
        try:
            task = (self._call("tasks.get", {"taskId": task_id}) or {}).get("task")
        except ProviderError as exc:
            if exc.code == "gateway" and (exc.details or {}).get("gatewayCode") in ("INVALID_REQUEST", "NOT_FOUND"):
                raise ProviderError("not_found", TASK_GONE) from exc
            raise
        ours = (self._task_agent(task) == _norm_agent(agent)) if whole else self._belongs(task, agent, key)
        if not ours:
            raise ProviderError("not_found", TASK_GONE)
        return task

    def task(self, agent: Any, task_id: Any, key: Any = None, scope: str = "chat") -> dict[str, Any]:
        return {"task": self._mine(agent, task_id, key, scope)}

    def task_history(self, agent: Any, task_id: Any, key: Any = None, scope: str = "chat",
                     cursor: Any = None) -> dict[str, Any]:
        task = self._mine(agent, task_id, key, scope)
        if task.get("hasTranscript") is False:
            return {"messages": []}
        self._need("tasks.history")
        params: dict[str, Any] = {"taskId": task["id"], "limit": 100}
        if isinstance(cursor, str) and cursor:
            params["cursor"] = cursor[:8192]
        result = self._call("tasks.history", params) or {}
        out: dict[str, Any] = {"messages": messages_view(result.get("messages"))}
        if isinstance(result.get("nextCursor"), str) and result["nextCursor"]:
            out["nextCursor"] = result["nextCursor"]
        return out

    def cancel_task(self, agent: Any, task_id: Any, key: Any = None, scope: str = "chat") -> dict[str, Any]:
        task = self._mine(agent, task_id, key, scope)
        self._need("tasks.cancel")
        result = self._call("tasks.cancel", {"taskId": task["id"], "reason": TASK_STOP_REASON}) or {}
        out: dict[str, Any] = {"cancelled": bool(result.get("cancelled"))}
        if result.get("reason"):
            out["reason"] = str(result["reason"])
        if isinstance(result.get("task"), dict):
            out["task"] = result["task"]
        return out

    def steer_task(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise ProviderError("unsupported", "OpenClaw tasks are not steered from the office")

    # ---- the task progress card --------------------------------------------------------------------------------
    def progress(self, agent: Any, key: Any, op: str = "get", *, revision: Any = None,
                 idempotency_key: Any = None) -> dict[str, Any]:
        if not key:
            raise ProviderError("bad_request", "This chat has no progress card yet")
        ident = {"sessionKey": str(key), "agentId": str(agent)}
        if op == "get":
            client = self._need("progressCard.get")
            card = card_view((self._call("progressCard.get", ident) or {}).get("card"))
            return {"plan": card, "can": {"refresh": client.offers("progressCard.refresh"),
                                          "dismiss": client.offers("progressCard.put")}}
        if op == "refresh":
            self._need("progressCard.refresh")
            idem = str(idempotency_key or uuid.uuid4())[:200]
            result = self._call("progressCard.refresh", {**ident, "idempotencyKey": idem}) or {}
            return {"accepted": result.get("status") == "accepted",
                    "revision": result["revision"] if isinstance(result.get("revision"), int) else None}
        if op == "dismiss":
            client = self._need("progressCard.put")
            if type(revision) is not int or revision < 1:
                raise ProviderError("bad_request", "Which version of the card?")
            generation = client.status().get("generation")
            card = card_view((self._call("progressCard.get", ident) or {}).get("card")) if client.offers("progressCard.get") else None
            if card is not None:
                if card.get("revision") != revision:
                    return {"dismissed": False, "changed": True, "plan": card}
                if any(str((s or {}).get("status") or "").lower() not in _DONE_STEPS for s in card["steps"] if isinstance(s, dict)):
                    raise ProviderError("bad_request", "The card can be dismissed once every step is done.")
            # Guarded: never lands on a replacement connection (same rule as the browser path's dismissal).
            result = self._call("progressCard.put", {**ident, "expectedRevision": revision},
                                expected_generation=generation) or {}
            kept = card_view(result.get("card"))
            return {"dismissed": kept is None, **({"plan": kept} if kept else {})}
        raise ProviderError("unsupported", f"There is no progress card operation {op}")

    # ---- the agents' browser (Full access) ---------------------------------------------------------------------
    def browser_available(self) -> dict[str, Any]:
        client = self._client()
        if not client.status().get("connected"):
            return {"available": False, "reason": UNREACHABLE}
        if not client.offers("browser.request"):
            return {"available": False, "reason": NO_BROWSER}
        if self.access() == ACCESS_CHAT:
            return {"available": False, "reason": CHAT_ONLY_BROWSER, "fix": CHAT_ONLY_FIX}
        if not client.grants("operator.admin"):
            return {"available": False, "reason": NO_ADMIN_GRANT}
        return {"available": True}

    def _browser_req(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        available = self.browser_available()
        if not available["available"]:
            if available["reason"] == CHAT_ONLY_BROWSER:
                raise _chat_only(CHAT_ONLY_BROWSER)
            raise ProviderError("forbidden", available["reason"])
        params: dict[str, Any] = {"method": method, "path": path}
        if body is not None:
            params["body"] = body
        try:
            return self._call("browser.request", params, timeout=30)
        except ProviderError as exc:
            details = exc.details or {}
            if exc.code != "gateway" or details.get("gatewayCode") != "INVALID_REQUEST":
                raise
            extra = details.get("details") if isinstance(details.get("details"), dict) else {}
            if re.search(r"tab not found", exc.message, re.I):
                raise ProviderError("not_found", "This tab is no longer open") from exc
            if extra.get("reason") == "navigation_blocked" or re.search(r"navigation blocked", exc.message, re.I):
                raise ProviderError("bad_request", "The browser's navigation rules block this address") from exc
            if re.search(r"evaluateEnabled=false|ACT_EVALUATE_DISABLED", f"{exc.message} {extra}"):
                raise ProviderError("forbidden", "The gateway's browser settings do not allow this "
                                                 "(browser.evaluateEnabled is off)") from exc
            raise ProviderError("bad_request", exc.message) from exc

    @staticmethod
    def _tab_view(tab: Any) -> dict[str, Any] | None:
        if not isinstance(tab, dict) or not isinstance(tab.get("targetId"), str) or not _TARGET.match(tab["targetId"]):
            return None
        out = {"id": tab["targetId"], "title": str(tab.get("title") or "")[:300], "url": str(tab.get("url") or "")[:_URL_MAX]}
        if tab.get("urlUnavailableReason") in ("navigation_blocked", "navigation_check_failed"):
            out["blocked"] = tab["urlUnavailableReason"]
        return out

    def _evaluate(self, tab: str, fn: str) -> None:
        self._browser_req("POST", "/act", {"kind": "evaluate", "targetId": tab, "fn": fn})

    def browser(self, agent: Any, op: str, params: dict[str, Any] | None = None) -> Any:
        """The agents' browser (Full access). ``state`` answers ``{available: False, reason}`` when
        it may not be used; every other op is refused with the Chat only text."""
        p = params or {}
        if op == "state":
            available = self.browser_available()
            if not available["available"]:
                return {**available, "running": False, "tabs": []}
            result = self._browser_req("GET", "/tabs") or {}
            tabs = [t for t in (self._tab_view(t) for t in (result.get("tabs") or [])) if t][:50]
            out: dict[str, Any] = {"available": True, "running": bool(result.get("running")), "tabs": tabs}
            with self._state_lock:
                frame = self._frames.get(str(p.get("tab") or ""))
            if frame:
                out["view"] = {"width": frame["width"], "height": frame["height"], "at": frame["at"]}
            return out
        self._require_full(CHAT_ONLY_BROWSER)
        if op == "start":
            self._browser_req("POST", "/start", {})
            return {"ok": True}
        if op == "open":
            tab = self._tab_view(self._browser_req("POST", "/tabs/open", {"url": web_url(p.get("url"), blank=True)}))
            return {"ok": True, **({"tab": tab} if tab else {})}
        tab = _target(p.get("tab"))
        if op == "focus":
            self._browser_req("POST", "/tabs/focus", {"targetId": tab})
            return {"ok": True}
        if op == "close":
            self._browser_req("DELETE", f"/tabs/{tab}")
            with self._state_lock:
                self._frames.pop(tab, None)
            return {"ok": True}
        if op in ("navigate", "reload"):
            result = self._browser_req("POST", "/navigate", {"targetId": tab, "url": web_url(p.get("url"))}) or {}
            return {"ok": True, "url": str(result.get("url") or "")}
        if op in ("back", "forward"):
            try:
                self._evaluate(tab, "() => { history.go(%d); return true; }" % (-1 if op == "back" else 1))
            except ProviderError as exc:
                if not re.search(r"Execution context was destroyed|because of a navigation", exc.message, re.I):
                    raise
            return {"ok": True}
        if op == "scroll":
            dx = round(_num(p.get("dx") or 0, -5000, 5000))
            dy = round(_num(p.get("dy") or 0, -5000, 5000))
            self._evaluate(tab, "() => { window.scrollBy(%d, %d); return true; }" % (dx, dy))
            return {"ok": True}
        if op == "click":
            with self._state_lock:
                frame = self._frames.get(tab)
            if not frame:
                raise ProviderError("bad_request", "The page is not showing yet")
            body = {"kind": "clickCoords", "targetId": tab, "x": round(_num(p.get("fx"), 0, 1) * frame["width"]),
                    "y": round(_num(p.get("fy"), 0, 1) * frame["height"])}
            if p.get("double") is True:
                body["doubleClick"] = True
            self._browser_req("POST", "/act", body)
            return {"ok": True}
        if op == "key":
            if p.get("key") not in BROWSER_KEYS:
                raise ProviderError("bad_request", "Not a key the page takes")
            self._browser_req("POST", "/act", {"kind": "press", "targetId": tab, "key": p["key"]})
            return {"ok": True}
        if op == "text":
            text = str(p.get("text") or "")
            if not text or len(text) > _TEXT_MAX:
                raise ProviderError("bad_request", f"Type 1 to {_TEXT_MAX} characters at a time")
            self._browser_req("POST", "/act", {"kind": "insertText", "targetId": tab, "text": text})
            return {"ok": True}
        if op == "frame":
            return self._frame(tab)
        raise ProviderError("bad_request", "Not something the browser does")

    def _frame(self, tab: str) -> dict[str, Any]:
        """One picture of the tab (v1: a screenshot polled by the page, design 2.9)."""
        result = self._browser_req("POST", "/screenshot", {"targetId": tab, "type": "jpeg"}) or {}
        data = None
        for field in ("imageBase64", "base64", "data"):
            if isinstance(result.get(field), str) and result[field]:
                try:
                    data = base64.b64decode(result[field], validate=False)
                except ValueError:
                    data = None
                break
        if data is None and isinstance(result.get("path"), str):
            data = self._read_frame(result["path"])
        if not data:
            raise ProviderError("unavailable", "The gateway's picture of this tab is not reachable from the office.")
        if len(data) > _FRAME_MAX:
            raise ProviderError("too_large", "Too large to show here")
        size = image_size(data)
        if not size:
            raise ProviderError("unavailable", "The gateway sent a picture the office cannot read.")
        mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
        with self._state_lock:
            self._frames[tab] = {"width": size[0], "height": size[1], "at": int(self._clock() * 1000)}
            while len(self._frames) > 50:
                self._frames.pop(next(iter(self._frames)))
        return {"mime": mime, "data": data, "width": size[0], "height": size[1]}

    def _read_frame(self, path: str) -> bytes | None:
        real = os.path.realpath(path)
        if not real.lower().endswith(_FRAME_SUFFIXES):
            return None
        if not any(real == root or real.startswith(root + os.sep) for root in self._media_roots):
            return None
        try:
            if os.path.getsize(real) > _FRAME_MAX:
                raise ProviderError("too_large", "Too large to show here")
            with open(real, "rb") as handle:
                return handle.read(_FRAME_MAX + 1)
        except OSError:
            return None

    # ---- agent files -------------------------------------------------------------------------------------------
    def files(self, agent: Any, op: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """The agent's workspace (read) and its documents (read; write needs Full access)."""
        p = params or {}
        agent_id = str(agent or "")
        if not agent_id:
            raise ProviderError("bad_request", "Which agent?")
        if op == "list":
            self._need("agents.workspace.list")
            r = self._call("agents.workspace.list", {"agentId": agent_id, "path": _rel(p.get("path")),
                                                     "offset": max(0, int(p.get("offset") or 0)),
                                                     "limit": min(500, max(1, int(p.get("limit") or 250)))}) or {}
            entries = [{"name": e.get("name"), "path": e.get("path"), "dir": e.get("kind") == "directory",
                        "size": e.get("size"), "modified": _ms(e.get("updatedAtMs"))}
                       for e in (r.get("entries") or []) if isinstance(e, dict)]
            return {"path": r.get("path") or "", "parent": r.get("parentPath"), "entries": entries,
                    "total": r.get("totalEntries", len(entries))}
        if op == "read":
            self._need("agents.workspace.get")
            f = (self._call("agents.workspace.get", {"agentId": agent_id, "path": _rel(p.get("path"))}, timeout=30) or {}).get("file") or {}
            return {"name": f.get("name"), "path": f.get("path"), "size": f.get("size"), "modified": _ms(f.get("updatedAtMs")),
                    "mime": f.get("mimeType") or "text/plain", "encoding": "base64" if f.get("encoding") == "base64" else "utf8",
                    "content": f.get("content") or ""}
        if op == "docs":
            self._need("agents.files.list")
            r = self._call("agents.files.list", {"agentId": agent_id}) or {}
            return {"files": [{"name": f.get("name"), "size": f.get("size"), "modified": _ms(f.get("updatedAtMs") or f.get("mtimeMs")),
                               "missing": bool(f.get("missing"))} for f in (r.get("files") or []) if isinstance(f, dict)]}
        name = str(p.get("name") or "")[:200]
        if op == "doc":
            self._need("agents.files.get")
            r = self._call("agents.files.get", {"agentId": agent_id, "name": name}) or {}
            f = r.get("file") if isinstance(r.get("file"), dict) else r
            return {"name": f.get("name") or name, "content": f.get("content") or "", "hash": f.get("hash") or r.get("hash"),
                    "missing": bool(f.get("missing"))}
        if op == "docSet":
            self._require_full(CHAT_ONLY_FILES)
            self._need("agents.files.set")
            content = p.get("content")
            if not isinstance(content, str):
                raise ProviderError("bad_request", "Send the text")
            if len(content.encode("utf-8")) > _DOC_MAX:
                raise ProviderError("too_large", "An agent document is at most 2 MB")
            body = {"agentId": agent_id, "name": name, "content": content}
            if p.get("expectedHash"):
                body["expectedHash"] = str(p["expectedHash"])
            try:
                r = self._call("agents.files.set", body, timeout=30) or {}
            except ProviderError as exc:
                extra = (exc.details or {}).get("details") or {}
                if (isinstance(extra, dict) and extra.get("type") == "agent_file_conflict") or "changed since it was read" in exc.message:
                    raise ProviderError("conflict", f"{name} was changed since it was read: open it again") from exc
                raise
            return {"ok": True, "name": name, "hash": r.get("hash") or (r.get("file") or {}).get("hash")}
        raise ProviderError("unsupported", f"There is no file call {op}")

    # ---- the provider menu -------------------------------------------------------------------------------------
    def menu(self, cid: Any, method: str, params: dict[str, Any] | None = None) -> Any:
        """One allow-listed menu call; writes and admin reads need Full access; secrets never come back."""
        method = str(method or "")
        if method not in MENU_READS and method not in MENU_WRITES:
            raise ProviderError("unsupported", f"{method} is not in OpenClaw's menu")
        if method in MENU_WRITES:
            self._require_full(CHAT_ONLY_SETTINGS)
        elif method in MENU_ADMIN_READS:
            self._require_full(CHAT_ONLY_ADMIN_READ)
        if method == "settings.outline":
            return self._outline()
        self._need(method)
        result = self._call(method, params or {}, timeout=30)
        if method == "config.schema.lookup":
            return result
        if method == "config.get":
            result = result or {}
            return {"config": redact(result.get("config"), self._sensitive()), "hash": result.get("hash"),
                    "valid": result.get("valid"), "issues": result.get("issues"), "warnings": result.get("warnings")}
        return redact(result)

    def _schema(self) -> dict[str, Any]:
        version = self._client().status().get("version")
        with self._state_lock:
            if self._schema_cache.get("version") == version and self._schema_cache:
                return self._schema_cache
        self._need("config.schema")
        result = self._call("config.schema", {}, timeout=30) or {}
        hints = result.get("uiHints") if isinstance(result.get("uiHints"), dict) else {}
        sensitive = [k for k, h in hints.items() if isinstance(h, dict) and h.get("sensitive")]
        schema = result.get("schema") if isinstance(result.get("schema"), dict) else {}
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        cache = {"version": version, "hints": hints, "sensitive": sensitive,
                 "matchers": [_schema_matcher(k) for k in sensitive], "top": list(properties)}
        with self._state_lock:
            self._schema_cache = cache
        return cache

    def _sensitive(self) -> list[re.Pattern]:
        try:
            return self._schema()["matchers"]
        except ProviderError:
            return []

    def _outline(self) -> dict[str, Any]:
        schema = self._schema()
        sections = []
        for key, hint in schema["hints"].items():
            if "." in key or key not in schema["top"] or not isinstance(hint, dict):
                continue
            sections.append({"key": key, "label": hint.get("label") or key, "group": hint.get("group") or hint.get("label") or key,
                             "order": hint.get("order") if isinstance(hint.get("order"), (int, float)) else 1000,
                             "help": hint.get("help") or "", "advanced": bool(hint.get("advanced"))})
        for key in schema["top"]:
            if not any(s["key"] == key for s in sections):
                sections.append({"key": key, "label": key[:1].upper() + key[1:], "group": "Other", "order": 2000,
                                 "help": "", "advanced": True})
        sections.sort(key=lambda s: (s["order"], s["label"]))
        return {"sections": sections, "sensitive": schema["sensitive"]}

    # ---- not on this adapter (chat streaming stays on the browser path, design D5) -----------------------------
    def _unsupported(self, name: str) -> ProviderError:
        return ProviderError("unsupported", f"OpenClaw's {name} goes through the office's chat stream")

    def history(self, *_a: Any, **_k: Any) -> Any:
        raise self._unsupported("history")

    def run(self, *_a: Any, **_k: Any) -> Any:
        raise self._unsupported("send")

    def stop(self, *_a: Any, **_k: Any) -> Any:
        raise self._unsupported("stop")

    def watch(self, *_a: Any, **_k: Any) -> Any:
        raise self._unsupported("watch")

    def media(self, *_a: Any, **_k: Any) -> Any:
        raise self._unsupported("media")

    def detect(self, *_a: Any, **_k: Any) -> Any:
        raise ProviderError("unsupported", "The office finds OpenClaw's gateway through its own endpoint settings")

    def screen_state(self, *_a: Any, **_k: Any) -> dict[str, Any]:
        return {"available": False, "reason": "OpenClaw agents have no Bot Desktop screen."}

    def screen_act(self, *_a: Any, **_k: Any) -> Any:
        raise ProviderError("unsupported", "OpenClaw agents have no Bot Desktop screen.")

    screen_thumb = screen_act
