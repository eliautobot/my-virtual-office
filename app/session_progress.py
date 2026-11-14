"""Session progress facade. Native state remains provider-owned; no authoring API.

Dependencies are injected so tests cannot accidentally reach a native service.
The hosting application supplies its existing trusted-operator authorization.
"""
import re
import json
import hashlib
import time

SCHEMA = "vw-session-progress/v1"
IDENTITY_KEYS = ("connectionId", "providerKind", "nativeOwnerId", "nativeSessionId")
CAPABILITIES = {
    "readSnapshot": False, "changeNotifications": False, "checklist": False,
    "markdownNote": False, "nativeItemIds": False, "multipleActiveSteps": False,
    "cancelled": False, "nativeRevision": False, "dismissCompleted": False,
    "write": False,
}
OPENCLAW_CAPABILITIES = dict(CAPABILITIES, readSnapshot=True, changeNotifications=True,
    checklist=True, markdownNote=True, nativeRevision=True, dismissCompleted=True)
INVISIBLE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]")


def text(value, limit):
    if not isinstance(value, str) or len(value.encode("utf-8")) > limit:
        raise ValueError("invalid_payload")
    return INVISIBLE.sub("", value)


def identity_from(body, roster):
    identity = body.get("identity")
    if not isinstance(identity, dict) or set(identity) != set(IDENTITY_KEYS):
        raise ValueError("invalid_identity")
    for value in identity.values():
        if not isinstance(value, str) or not value or len(value) > 1024 or INVISIBLE.search(value):
            raise ValueError("invalid_identity")
    # No profile/agent alias lookup: all four identity dimensions are mandatory.
    matches = [a for a in roster if
        str(a.get("providerKind") or "openclaw") == identity["providerKind"] and
        str(a.get("providerConnectionId") or "default") == identity["connectionId"] and
        str(a.get("providerAgentId") or a.get("id") or "") == identity["nativeOwnerId"]]
    if len(matches) != 1:
        raise PermissionError("identity_denied")
    session = identity["nativeSessionId"]
    if "@new" in session:
        raise ValueError("no_native_session")
    if identity["providerKind"] == "openclaw":
        owner = identity["nativeOwnerId"]
        if not session.startswith(f"agent:{owner}:") or session == f"agent:{owner}:":
            raise PermissionError("identity_denied")
        # The built-in Gateway connector owns default only. Never route another
        # registry connection through that connector by similarity of agent name.
        if identity["connectionId"] != "default":
            raise ValueError("unsupported_connection")
    return dict(identity)


def normalize_openclaw(raw, session):
    if raw is None:
        return None
    if not isinstance(raw, dict) or raw.get("sessionKey") != session:
        raise ValueError("session_mismatch")
    revision = raw.get("revision")
    if type(revision) is not int or revision < 1 or revision > 9007199254740991:
        raise ValueError("invalid_payload")
    steps = raw.get("steps", [])
    if not isinstance(steps, list) or len(steps) > 50:
        raise ValueError("invalid_payload")
    items = []
    for step in steps:
        if not isinstance(step, dict) or step.get("status") not in ("pending", "in_progress", "completed"):
            raise ValueError("invalid_payload")
        label = text(step.get("step"), 512)
        if not label.strip():
            raise ValueError("invalid_payload")
        items.append({"text": label, "status": step["status"], "nativeStatus": step["status"]})
    if sum(i["status"] == "in_progress" for i in items) > 1:
        raise ValueError("invalid_payload")
    note = text(raw.get("markdown", ""), 8192)
    updated = raw.get("updatedAt")
    if type(updated) not in (int, float) or not 0 < updated < 8640000000000000:
        raise ValueError("invalid_payload")
    return {"items": items, "note": {"format": "markdown", "content": note},
            "nativeRevision": revision, "nativeUpdatedAt": updated}


def classify_error(result):
    error = result.get("error")
    error = error if isinstance(error, dict) else {}
    # Never return upstream messages: those can contain credentials/paths.
    code = str(error.get("code") or "").lower()
    message = str(error.get("message") or "").lower()
    if any(word in code + " " + message for word in ("denied", "forbidden", "unauthorized", "permission", "participat", "scope", "pairing")):
        return "denied"
    if any(word in code + " " + message for word in ("unknown method", "method_not_found", "not supported", "method not found")):
        return "unsupported"
    return "unavailable"


def hermes_history_snapshot(page, session):
    """Newest paired native todo FULL result in one bounded newest-500 page.

    Missing pair/compaction/lineage is UNKNOWN, never an inferred empty plan.
    No request arguments, prose, reasoning, or unrelated tool output is exposed.
    """
    if not isinstance(page, dict) or page.get("session_id") != session:
        raise ValueError("session_mismatch")
    rows = page.get("data")
    if not isinstance(rows, list) or len(rows) > 500:
        raise ValueError("invalid_payload")
    previous_id = -1
    for row in rows:
        if not isinstance(row, dict) or row.get("session_id") != session or type(row.get("id")) is not int or row["id"] <= previous_id:
            raise ValueError("invalid_payload")
        previous_id = row["id"]
    for index in range(len(rows) - 1, -1, -1):
        row = rows[index]
        if row.get("role") != "tool" or not isinstance(row.get("tool_call_id"), str):
            continue
        call_id = row["tool_call_id"]
        assistant = None
        for candidate in reversed(rows[:index]):
            if candidate.get("role") in ("user", "system"):
                break
            if candidate.get("role") == "assistant":
                assistant = candidate
                break
        calls = (assistant or {}).get("tool_calls")
        if not isinstance(calls, list) or len(calls) > 256:
            if row.get("tool_name") == "todo":
                return {"availability": "unknown", "card": None, "code": "history_snapshot_missing"}
            continue
        matches = [c for c in calls if isinstance(c, dict) and c.get("id") == call_id]
        if len(matches) != 1 or not isinstance(matches[0].get("function"), dict) or matches[0]["function"].get("name") != "todo":
            if row.get("tool_name") == "todo":
                return {"availability": "unknown", "card": None, "code": "history_snapshot_missing"}
            continue
        raw = row.get("content")
        if not isinstance(raw, str) or len(raw) > 512000:
            raise ValueError("invalid_payload")
        try:
            result = json.loads(raw)
        except (ValueError, RecursionError):
            raise ValueError("invalid_payload") from None
        if not isinstance(result, dict) or not isinstance(result.get("todos"), list):
            # A failed native tool update supplies no snapshot. Do not resurrect
            # an older plan or guess from attempted merge arguments.
            return {"availability": "unknown", "card": None, "code": "history_snapshot_missing"}
        todos = result["todos"]
        if len(todos) > 256:
            raise ValueError("invalid_payload")
        items, ids = [], set()
        for todo in todos:
            if not isinstance(todo, dict):
                raise ValueError("invalid_payload")
            native_id = text(todo.get("id"), 4096)
            label = text(todo.get("content"), 16000)
            if len(label) > 4000 or not native_id or native_id in ids:
                raise ValueError("invalid_payload")
            ids.add(native_id)
            status = todo.get("status")
            if status not in ("pending", "in_progress", "completed", "cancelled"):
                raise ValueError("invalid_payload")
            items.append({"nativeId": native_id, "text": label, "status": status, "nativeStatus": status})
        digest = hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest()
        return {"availability": "supported", "card": {"items": items, "snapshotDigest": digest} if items else None,
                "code": "hermes_history_limited"}
    return {"availability": "unknown", "card": None, "code": "history_snapshot_missing"}


class ProgressService:
    def __init__(self, *, roster, gateway, connection_epoch, hermes=None):
        self.hermes = hermes
        self.roster = roster
        self.gateway = gateway
        self.connection_epoch = connection_epoch

    def handle(self, body):
        response = {"schemaVersion": SCHEMA, "availability": "unknown", "card": None,
                    "capabilities": dict(CAPABILITIES), "run": {"state": "unknown"},
                    "observedAt": int(time.time() * 1000)}
        try:
            if not isinstance(body, dict) or set(body) - {"identity", "action", "expectedRevision", "connectionEpoch"}:
                raise ValueError("invalid_request")
            action = body.get("action", "read")
            if action not in ("read", "dismiss"):
                raise ValueError("invalid_action")
            identity = identity_from(body, self.roster())
            response["identity"] = identity
            if identity["providerKind"] == "hermes" and self.hermes and action == "read":
                snapshot = self.hermes(identity)
                response.update(snapshot)
                response["source"] = {"authority": "adapter_snapshot", "kind": "hermes-paired-todo-history", "persistence": "transcript-backed-limited", "pageLimit": 500}
                response["capabilities"] = (dict(CAPABILITIES) if snapshot.get("availability") == "unsupported" else
                    dict(CAPABILITIES, readSnapshot=True, checklist=True, nativeItemIds=True, multipleActiveSteps=True, cancelled=True))
                return response
            if identity["providerKind"] != "openclaw":
                response.update(availability="unsupported", code=("hermes_native_bridge_required" if identity["providerKind"] == "hermes" else "provider_progress_unsupported"))
                return response
            response["capabilities"] = dict(OPENCLAW_CAPABILITIES)
            response["source"] = {"authority": "native", "kind": "openclaw-progress-card", "persistence": "native-durable"}
            epoch = self.connection_epoch()
            response["connectionEpoch"] = epoch
            params = {"sessionKey": identity["nativeSessionId"]}
            method = "progressCard.get"
            if action == "dismiss":
                revision = body.get("expectedRevision")
                if type(revision) is not int or not 1 <= revision <= 9007199254740991:
                    raise ValueError("revision_required")
                if body.get("connectionEpoch") != epoch:
                    raise ValueError("connection_changed")
                # Native put's expectedRevision is a completed-plan-only clear.
                # There is intentionally NO general put/plan/markdown facade.
                method = "progressCard.put"
                params["expectedRevision"] = revision
            elif "expectedRevision" in body:
                raise ValueError("invalid_request")
            result = self.gateway(method, params)
            if self.connection_epoch() != epoch:
                raise ValueError("connection_changed")
            if not isinstance(result, dict) or not result.get("ok"):
                response.update(availability=classify_error(result if isinstance(result, dict) else {}), code="native_request_rejected")
                return response
            payload = result.get("payload")
            if not isinstance(payload, dict) or "card" not in payload:
                raise ValueError("invalid_payload")
            response["card"] = normalize_openclaw(payload["card"], identity["nativeSessionId"])
            response["availability"] = "supported"
            return response
        except PermissionError:
            response.update(availability="denied", card=None, code="identity_denied")
        except ValueError as exc:
            code = str(exc)
            response.update(availability="unsupported" if code == "unsupported_connection" else "unknown" if code == "no_native_session" else "unavailable", card=None,
                            code=code if code in {"unsupported_connection", "no_native_session", "connection_changed", "invalid_identity", "invalid_request", "invalid_action", "invalid_payload", "session_mismatch", "revision_required"} else "invalid_payload")
        except Exception:
            response.update(availability="unavailable", card=None, code="progress_unavailable")
        return response
