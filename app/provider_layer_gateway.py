"""The office server's own OpenClaw gateway calls while the copied layer owns OpenClaw (v0.11).

0.10 office features called the gateway with VO's own Python client: the New agent wizard (agents.create, its files),
the chat list and delete, the skills workshop, the gateway restart after a settings save, progress cards. With the layer
on, only the layer is paired with OpenClaw (from Docker's bridge network the Python client had no scopes, or opened a
second, nameless pairing request). ``LayerGatewayClient`` stands in for that client: the same ``request`` / ``status``
answers, carried by the layer's internal route (``/api/pl/internal/openclaw/call``, a fixed list of calls), so these
features work wherever the layer's link does. An office agent id or ``agent:<id>:...`` session key in the parameters
is turned into its OpenClaw agent id and connection (provider_layer_ids). No token ever passes through here.

``adopt_saved_gateway`` hands a gateway the setup wizard saved to the layer when it has no OpenClaw connection yet.
"""

import http.client
import json
import threading
import time

import provider_layer_ids
from openclaw_gateway_client import GatewayDisconnectedError, GatewayUnavailableError

STATUS_TTL_S = 1.5
_AGENT_PARAMS = ("agentId",)
_SESSION_PARAMS = ("sessionKey", "key")


def _post(layer, path, body, timeout):
    if layer is None or not layer.ready():
        raise GatewayUnavailableError(getattr(layer, "message", "") or "The OpenClaw and Hermes layer is not running")
    conn = http.client.HTTPConnection("127.0.0.1", layer.port, timeout=timeout)
    try:
        conn.request("POST", path, body=json.dumps(body).encode(),
                     headers={"X-VO-Principal": layer.internal_principal(), "Content-Type": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
    except (OSError, http.client.HTTPException) as exc:
        raise GatewayUnavailableError(f"The OpenClaw and Hermes layer did not answer: {type(exc).__name__}") from exc
    finally:
        conn.close()
    try:
        out = json.loads(raw or b"null")
    except ValueError:
        out = None
    return resp.status, out if isinstance(out, dict) else {}


def _office_row(office_id):
    ids = provider_layer_ids.ids()
    if ids is None or not office_id:
        return None
    return next((r for r in ids.all() if str(r.get("officeId")) == str(office_id) and r.get("kind") == "openclaw"), None)


def target(params):
    """(layer connection id or None, the parameters with an office agent id turned into OpenClaw's own)."""
    params = dict(params or {})
    connection = None
    for name in _AGENT_PARAMS:
        row = _office_row(params.get(name)) if isinstance(params.get(name), str) else None
        if row:
            params[name] = str(row.get("nativeId") or params[name])
            connection = row.get("connectionId")
    for name in _SESSION_PARAMS:
        value = params.get(name)
        if not isinstance(value, str) or not value.startswith("agent:"):
            continue
        parts = value.split(":", 2)
        row = _office_row(parts[1]) if len(parts) == 3 else None
        if row:
            params[name] = f"agent:{row.get('nativeId') or parts[1]}:{parts[2]}"
            connection = connection or row.get("connectionId")
    return connection, params


class LayerGatewayClient:
    """VO's Python OpenClaw client's place while the layer owns OpenClaw: request/status through the layer."""

    def __init__(self, layer_getter):
        self._layer = layer_getter
        self._lock = threading.Lock()
        self._status = None
        self._status_at = 0.0

    def request(self, method, params=None, *, timeout=20.0, config_key=None, expected_generation=None):
        timeout = max(1.0, float(timeout))
        connection, params = target(params)
        if expected_generation is not None:
            now = self.status(fresh=True)
            if not now.get("connected") or now.get("generation") != expected_generation:
                raise GatewayDisconnectedError("Gateway connection changed before the guarded request")
        status, out = _post(self._layer(), "/api/pl/internal/openclaw/call",
                            {"connection": connection, "method": str(method or ""), "params": params,
                             "timeoutMs": int(timeout * 1000)}, timeout + 10.0)
        error = out.get("error") if isinstance(out.get("error"), dict) else {}
        if status != 200:
            raise GatewayUnavailableError(error.get("message") or f"The OpenClaw layer answered HTTP {status}")
        if not out.get("ok"):
            return {"ok": False, "error": {"code": error.get("code") or "provider_error",
                                           "message": error.get("message") or f"{method} failed"}}
        return {"ok": True, "payload": out.get("payload")}

    def status(self, fresh=False):
        with self._lock:
            if not fresh and self._status is not None and time.time() - self._status_at < STATUS_TTL_S:
                return dict(self._status)
        base = {"transport": "layer", "endpointMode": "layer", "endpointLocation": "", "pendingRequests": 0,
                "subscriberCount": 0, "access": "full"}
        try:
            code, out = _post(self._layer(), "/api/pl/internal/openclaw/status", {}, 6.0)
            if code == 200 and out.get("ok"):
                version = str(out.get("version") or "")
                st = dict(base, connected=bool(out.get("connected")), lastError=None,
                          generation=f"pl{out.get('connectionId')}.{out.get('generation') or 0}",
                          state=str(out.get("state") or ""), connectionId=out.get("connectionId"),
                          **({"version": version} if version else {}),
                          **{k: str(out[k])[:400] for k in ("detail", "fix") if out.get(k)})
            else:
                st = dict(base, connected=False, generation=0, state="not_configured" if code == 409 else "error",
                          lastError=((out.get("error") or {}).get("message") if isinstance(out.get("error"), dict) else None)
                          or f"HTTP {code}")
        except GatewayUnavailableError as exc:
            st = dict(base, connected=False, generation=0, state="error", lastError=str(exc))
        with self._lock:
            self._status, self._status_at = st, time.time()
        return dict(st)

    def subscribe(self, *args, **kwargs):
        raise GatewayUnavailableError("OpenClaw's events come from the provider layer")

    def unsubscribe(self, subscription_id):
        return None

    def start(self, config_key=None):
        return None

    def close(self, timeout=5.0):
        return None

    def reconnect(self):
        with self._lock:
            self._status = None

    def current_config_key(self):
        return None

    def offers(self, method):
        return True

    def sends(self, event):
        return False

    def grants(self, scope):
        return bool(self.status().get("connected"))

    def hello(self):
        return {}


def adopt_saved_gateway(layer, url, token, log=print):
    """The gateway and token the office saved (setup wizard) become the layer's OpenClaw connection while it has none
    yet (vo-migrate.mjs adoptOpenClaw: idempotent). Returns the layer's answer, without any secret, or None."""
    url, token = str(url or "").strip(), str(token or "").strip()
    if not token or layer is None or not layer.ready():
        return None
    try:
        status, out = _post(layer, "/api/pl/internal/openclaw/adopt", {"url": url, "token": token}, 15.0)
    except GatewayUnavailableError as exc:
        log(f"[pl] the saved OpenClaw gateway was not handed to the layer: {exc}")
        return None
    if status != 200:
        log(f"[pl] the saved OpenClaw gateway was not handed to the layer (HTTP {status})")
        return None
    if out.get("adopted"):
        log(f"[pl] the saved OpenClaw gateway is the layer's OpenClaw connection now ({out.get('connectionId')})")
    return {k: out.get(k) for k in ("adopted", "connectionId", "reason") if k in out}
