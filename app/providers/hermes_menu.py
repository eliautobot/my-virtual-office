"""Hermes' settings menu in Agent Providers (design 3.7, phase C1; MVW 9094 server/providers/hermes/menu.js).

A fixed list of calls, each one of Hermes' own: its gateway JSON-RPC or its dashboard's REST, as its dashboard and
Desktop settings use them. Reads answer at both access levels; the changing calls (MENU_WRITE, the manifest's
menuWrite) only for a connection with Full access: under Chat only they are refused here too (403 `chat_only`, the
design 3.6 text), whatever route asked. No secret's value leaves Hermes for a page: a setting named like a key, token
or password comes back as {secret: True, set}, MCP servers' env/header values the same, and the keys list (env.list)
carries only whether each key is set, never a value or Hermes' own masked preview.
"""

from __future__ import annotations

import json
import re
import urllib.parse

from providers import hermes_link as hl

KIND = "hermes"
SECRET_KEY = re.compile(r"(^|[._-])(api[_-]?key|key|token|secret|password|passwd|credential|auth[_-]?token|"
                        r"private[_-]?key|client[_-]?secret|cookie|bearer)s?$", re.I)
NAME = re.compile(r"^[\w.@:+-]{1,128}$")
SETTING = re.compile(r"^[\w-]+(\.[\w-]+)*$")
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
BY_STATUS = {400: "bad_request", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large",
             415: "unsupported", 422: "bad_request"}
CHAT_ONLY_TEXT = "This connection has Chat only access: Hermes' settings are not changed from here."
CHAT_ONLY_FIX = "Edit the connection in Agent Providers and choose Full access."
CONFLICT_TEXT = "Hermes' settings were changed elsewhere meanwhile. Reload the tab and try again."


def fail(code: str, message: str, fix: str | None = None, status: int | None = None) -> hl.HermesError:
    err = hl.HermesError(code, message, fix)
    if status:
        err.status = status
    return err


def chat_only(area: str = "settings") -> hl.HermesError:
    """The refusal of a change under Chat only, with the office's own 3.6 text when it is there."""
    text, fix = CHAT_ONLY_TEXT, CHAT_ONLY_FIX
    try:
        import agent_providers
        text, fix = agent_providers.chat_only_reason(KIND, area), agent_providers.FIX_FULL_ACCESS
    except Exception:  # noqa: BLE001 - outside the server (tools, tests): the same words, kept here
        pass
    return fail("chat_only", text, fix, status=403)


# ------------------------------------------------------------------ redaction
def redact(v, key: str = ""):
    """A settings tree with every secret-like value replaced by whether it is set. Only text is a secret: a number
    named like one (compression.proactive_prune_tokens, max_tokens) is a setting and stays as it is."""
    if isinstance(v, str) and SECRET_KEY.search(key or ""):
        return {"secret": True, "set": v != ""}
    if isinstance(v, list):
        return [redact(x, "") for x in v]
    if isinstance(v, dict):
        return {k: redact(x, str(k)) for k, x in v.items()}
    return v


def _hidden(values) -> dict:
    """Env/header maps (MCP servers): names kept, every value only as set / not set."""
    if not isinstance(values, dict):
        return {}
    return {str(k): {"secret": True, "set": bool(v) and v != "***"} for k, v in values.items()}


def _is_placeholder(v) -> bool:
    return isinstance(v, dict) and v.get("secret") is True and set(v) <= {"secret", "set"}


# ------------------------------------------------------------------ params
def name(v) -> str:
    s = str(v if v is not None else "").strip()
    if not NAME.match(s):
        raise fail("bad_request", "That is not a name Hermes takes.", status=400)
    return s


def profile_of(p: dict) -> str | None:
    return name(p["profile"]) if p.get("profile") else None


def seg(v) -> str:
    return urllib.parse.quote(name(v), safe="")


def _at(tree, path: str):
    for k in path.split("."):
        if not isinstance(tree, dict) or k not in tree:
            return None
        tree = tree[k]
    return tree


def _nest(path: str, value) -> dict:
    for k in reversed(path.split(".")):
        value = {k: value}
    return value


def _merge(a: dict, b: dict) -> dict:
    for k, v in b.items():
        a[k] = _merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a


def _same(a, b) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


# ------------------------------------------------------------------ Hermes' calls
def _ready(link) -> None:
    wait = getattr(link, "wait_connected", None)
    if callable(wait):
        wait()


def _rest(link, method: str, path: str, p: dict | None = None, *, body=None, query=None, timeout: float = 30):
    q = dict(query or {})
    prof = profile_of(p or {})
    try:
        return link.rest(method, path, body, prof, query=q, timeout=timeout)
    except hl.HermesError as e:
        code = BY_STATUS.get(e.http_status or 0)
        if code:
            raise fail(code, e.detail, e.fix, status=e.http_status if e.http_status != 422 else 400) from None
        raise


def _rpc(link, method: str, params: dict, timeout: float = 30):
    try:
        return link.call(method, params, timeout=timeout)
    except hl.HermesError as e:
        if e.rpc_code == -32601:
            raise fail("unsupported", "This Hermes does not offer that yet (update Hermes).", status=400) from None
        if e.rpc_code is not None and e.code.startswith("hermes_"):
            raise fail("bad_request", e.detail, e.fix, status=400) from None
        raise


def _days(p) -> int:
    try:
        return min(90, max(1, int(p.get("days") or 30)))
    except (TypeError, ValueError):
        return 30


def _mcp_list(link, p):
    r = _rest(link, "GET", "/api/mcp/servers", p) or {}
    servers = []
    for raw in r.get("servers") or []:
        if not isinstance(raw, dict):
            continue
        out = redact({k: v for k, v in raw.items() if k not in ("env", "headers")})
        out["env"] = _hidden(raw.get("env"))     # (names kept, values only as set / not set)
        if raw.get("headers") is not None:
            out["headers"] = _hidden(raw.get("headers"))
        servers.append(out)
    return {"servers": servers}


def _env_list(link, p):
    r = _rest(link, "GET", "/api/env", p) or {}
    rows = r.items() if isinstance(r, dict) else ((x.get("key") or x.get("name"), x) for x in r if isinstance(x, dict))
    keys = []
    for k, row in rows:
        if not isinstance(row, dict) or not isinstance(k, str) or row.get("channel_managed"):
            continue
        keys.append({"key": k, "set": bool(row.get("is_set")), "secret": bool(row.get("is_password", True)),
                     "description": str(row.get("description") or "")[:400], "url": row.get("url") or None,
                     "category": str(row.get("category") or ""), "advanced": bool(row.get("advanced")),
                     "provider": str(row.get("provider") or ""), "providerLabel": str(row.get("provider_label") or "")})
    return {"keys": sorted(keys, key=lambda x: (x["category"], x["key"]))[:500]}


def _sessions_list(link, p):
    try:
        limit = min(200, max(1, int(p.get("limit") or 100)))
        offset = max(0, int(p.get("offset") or 0))
    except (TypeError, ValueError):
        limit, offset = 100, 0
    return _rest(link, "GET", "/api/sessions", p, query={"limit": limit, "offset": offset})


MENU_READ = {
    "status": lambda l, p: _rest(l, "GET", "/api/status"),
    "analytics": lambda l, p: _rest(l, "GET", "/api/analytics/usage", p, query={"days": _days(p)}),
    "profiles.list": lambda l, p: _rpc(l, "profiles.list", {}),
    "profiles.describe": lambda l, p: _rpc(l, "profiles.describe", {"name": name(p.get("name"))}),
    "models.options": lambda l, p: _rpc(l, "model.options", {"profile": profile_of(p)}, timeout=45),
    "config.get": lambda l, p: {"config": redact(_rest(l, "GET", "/api/config", p))},
    "config.schema": lambda l, p: _rest(l, "GET", "/api/config/schema", p),
    "toolsets.list": lambda l, p: _rest(l, "GET", "/api/tools/toolsets", p),
    "skills.list": lambda l, p: _rest(l, "GET", "/api/skills", p),
    "cron.list": lambda l, p: _rest(l, "GET", "/api/cron/jobs", p),
    "mcp.list": _mcp_list,
    "sessions.list": _sessions_list,
    "env.list": _env_list,
}


def _profiles_create(l, p):
    params = {"name": name(p.get("name"))}
    if p.get("description"):
        params["description"] = str(p["description"])[:500]
    if p.get("clone_from"):
        params["clone_from"] = name(p["clone_from"])
    return _rpc(l, "profiles.create", params, timeout=60)


def _model_default(l, p):
    if not isinstance(p.get("model"), str) or not p["model"] or not isinstance(p.get("provider"), str) \
            or not p["provider"]:
        raise fail("bad_request", "Which model?", status=400)
    body = {"scope": "main", "provider": p["provider"][:200], "model": p["model"][:200], "profile": profile_of(p)}
    if p.get("confirm") is True:
        body["confirm_expensive_model"] = True
    return redact(_rest(l, "POST", "/api/model/set", p, body=body))


def _toggle(path_of, body_of):
    def call(l, p):
        return redact(_rest(l, "PUT", path_of(p), p, body={**body_of(p), "enabled": p.get("enabled") is True,
                                                            "profile": profile_of(p)}))
    return call


def _cron(action):
    def call(l, p):
        if action == "remove":
            return _rest(l, "DELETE", f"/api/cron/jobs/{seg(p.get('id'))}", p)
        return _rest(l, "POST", f"/api/cron/jobs/{seg(p.get('id'))}/{action}", p, body={})
    return call


def _config_patch(l, p):
    """{profile, changes: {path: value}, base: {path: the value shown}}. Hermes has no revision to send with a change,
    so it is read again first: a setting changed elsewhere since the page read it refuses the whole change. Only the
    changed settings are sent (Hermes deep-merges them into its settings file)."""
    changes = p.get("changes")
    if not isinstance(changes, dict) or not changes:
        raise fail("bad_request", "Nothing to change.", status=400)
    if len(changes) > 100:
        raise fail("bad_request", "Too many changes at once.", status=400)
    base = p.get("base") if isinstance(p.get("base"), dict) else {}
    for path, v in changes.items():
        if not isinstance(path, str) or len(path) > 200 or not SETTING.match(path):
            raise fail("bad_request", "That is not a setting.", status=400)
        if _is_placeholder(v) or (isinstance(v, dict) and any(_is_placeholder(x) for x in v.values())):
            raise fail("bad_request", "Type the new value of a secret setting to change it.", status=400)
    now = redact(_rest(l, "GET", "/api/config", p))
    for path in changes:
        if path in base and not _same(_at(now, path), base[path]):
            raise fail("conflict", CONFLICT_TEXT, status=409)
    patch: dict = {}
    for path, v in changes.items():
        _merge(patch, _nest(path, v))
    _rest(l, "PUT", "/api/config", p, body={"config": patch, "profile": profile_of(p)})
    return {"ok": True, "changed": sorted(changes)}


def _env_set(l, p):
    key, value = p.get("key"), p.get("value")
    if not isinstance(key, str) or not ENV_KEY.match(key):
        raise fail("bad_request", "That is not a key name.", status=400)
    if not isinstance(value, str) or not value or len(value) > 8192:
        raise fail("bad_request", "Type the key's new value.", status=400)
    _rest(l, "PUT", "/api/env", p, body={"key": key, "value": value, "profile": profile_of(p)})
    return {"ok": True, "key": key, "set": True}


MENU_WRITE = {
    "profiles.create": _profiles_create,
    "model.default": _model_default,
    "toolsets.set": _toggle(lambda p: f"/api/tools/toolsets/{seg(p.get('name'))}", lambda p: {}),
    "skills.set": _toggle(lambda p: "/api/skills/toggle", lambda p: {"name": name(p.get("name"))}),
    "mcp.set": _toggle(lambda p: f"/api/mcp/servers/{seg(p.get('name'))}/enabled", lambda p: {}),
    "cron.pause": _cron("pause"),
    "cron.resume": _cron("resume"),
    "cron.run": _cron("trigger"),
    "cron.remove": _cron("remove"),
    "sessions.delete": lambda l, p: _rest(l, "DELETE", f"/api/sessions/{seg(p.get('id'))}", p),
    "config.patch": _config_patch,
    "env.set": _env_set,
}


def menu_call(link, method: str, params: dict | None = None, *, access: str = "chat", gated=None):
    """One menu call on a connection's link. `access` is the connection's level ('full' or 'chat'); `gated` is the
    set of writes the office route gates (passcode + audit): a write outside it is not offered."""
    p = params if isinstance(params, dict) else {}
    fn = MENU_READ.get(method)
    if fn is None:
        fn = MENU_WRITE.get(method)
        if fn is None:
            raise fail("unsupported", f"Hermes' menu has no call {method}.", status=400)
        if access != "full":
            raise chat_only("settings")
        if gated is not None and method not in gated:
            raise fail("unsupported", "This change is not offered from the office yet.", status=400)
    _ready(link)
    return fn(link, p)
