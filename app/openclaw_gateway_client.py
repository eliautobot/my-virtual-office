"""Reusable OpenClaw Gateway client for Virtual Office's server-side proxy.

One process-level WebSocket carries concurrent RPC requests and Gateway events.
HTTP request threads submit work to a dedicated asyncio loop; browser SSE clients
subscribe to a fan-out queue.  Requests that may have reached the Gateway are
never replayed automatically after a disconnect.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import queue
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from typing import Any


# Access levels of the office's OpenClaw connection. "chat" still chats, answers
# approvals and questions; only "full" asks for operator.admin (settings writes,
# the agents' browser, admin reads). The gateway enforces the scopes it grants.
ACCESS_FULL = "full"
ACCESS_CHAT = "chat"
_SCOPES_CHAT = ("operator.read", "operator.write", "operator.approvals", "operator.questions")
_SCOPES_FULL = _SCOPES_CHAT + ("operator.admin",)
# What each level cannot work without: chat, sessions and the agent list need read + write; Full access also
# needs operator.admin. (approvals/questions are asked for, but older gateways do not name them in hello-ok.)
_NEEDED_CHAT = ("operator.read", "operator.write")
_NEEDED_FULL = _NEEDED_CHAT + ("operator.admin",)
_HELLO_LIST_MAX = 4096

SCOPE_MISSING_FIX = ("OpenClaw gives no permission to a token-only connection that does not come from its own "
                     "computer (for example a Docker bridge network or another machine). Run the office on the "
                     "OpenClaw computer (or with Docker host networking), or pair the office with OpenClaw as a device.")
SCOPE_LIMITED_FIX = "Approve the office with full access in OpenClaw, or set this connection to Chat only."


def normalize_access(value: Any) -> str:
    """``chat`` only when asked for exactly; anything else is today's full access."""
    return ACCESS_CHAT if str(value or "").strip().lower() == ACCESS_CHAT else ACCESS_FULL


def scopes_for_access(access: Any) -> list[str]:
    return list(_SCOPES_CHAT if normalize_access(access) == ACCESS_CHAT else _SCOPES_FULL)


def needed_scopes(access: Any) -> list[str]:
    return list(_NEEDED_CHAT if normalize_access(access) == ACCESS_CHAT else _NEEDED_FULL)


def missing_scopes(granted: Any, access: Any) -> list[str]:
    """The scopes ``access`` needs that ``granted`` (hello-ok's list) lacks. None (the gateway did not say) and
    operator.admin (it covers every operator scope) mean nothing is missing."""
    if granted is None:
        return []
    granted = set(granted)
    if "operator.admin" in granted:
        return []
    return [scope for scope in needed_scopes(access) if scope not in granted]


def scope_problem(missing: Any, fix: str | None = None) -> dict[str, Any] | None:
    """Provider status words for a connection that is up but short of scopes; None when nothing is missing.
    Without read/write nothing works ("error"); without only operator.admin chat still works ("connected",
    code scope_limited). Never a plain "Connected"."""
    missing = [str(scope) for scope in (missing or []) if scope]
    if not missing:
        return None
    names = ", ".join(missing)
    if set(missing) & set(_NEEDED_CHAT):
        return {"state": "error", "code": "scope_missing", "missingScopes": missing,
                "detail": f"Connected, but OpenClaw did not give this office permission (missing {names}), "
                          "so its agents cannot chat or be listed.",
                "fix": fix or SCOPE_MISSING_FIX}
    return {"state": "connected", "code": "scope_limited", "missingScopes": missing,
            "detail": f"Connected, but OpenClaw did not give this office full access (missing {names}): chat "
                      "works, settings and the agents' browser do not.",
            "fix": SCOPE_LIMITED_FIX}


def _challenge_of(raw: Any) -> dict[str, Any] | None:
    """The payload of the gateway's pre-connect ``connect.challenge`` event (None for anything else)."""
    try:
        message = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if isinstance(message, dict) and message.get("event") == "connect.challenge" \
            and isinstance(message.get("payload"), dict):
        return message["payload"]
    return None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value[:_HELLO_LIST_MAX] if isinstance(item, str) and item]


class GatewayClientError(RuntimeError):
    """Base error raised by the reusable Gateway client."""


class GatewayUnavailableError(GatewayClientError):
    """The client could not establish a ready Gateway connection in time."""


class GatewayDisconnectedError(GatewayClientError):
    """The Gateway disconnected after a request may have been transmitted."""


class GatewayPairingRequired(GatewayUnavailableError):
    """OpenClaw is waiting for the one-time approval of the office's device."""


class _RetryAsDevice(GatewayClientError):
    """A token-only handshake came back short of scopes: connect again at once, as a device."""


class GatewaySubscription:
    """Thread-safe event subscription owned by one downstream SSE request."""

    def __init__(self, owner: "OpenClawGatewayClient", subscription_id: str, events: queue.Queue):
        self._owner = owner
        self.id = subscription_id
        self.events = events
        self._closed = False

    def get(self, timeout: float | None = None) -> dict[str, Any]:
        return self.events.get(timeout=timeout)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._owner.unsubscribe(self.id)

    def __enter__(self) -> "GatewaySubscription":
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()


class OpenClawGatewayClient:
    """Long-lived, multiplexed OpenClaw Gateway connection.

    ``connection_factory`` is called only when a connection must be established
    or re-established.  It receives the current opaque configuration key and
    returns ``url``, ``token``, ``origin``, and optional public metadata.
    """

    def __init__(
        self,
        connection_factory: Callable[[Any], dict[str, Any]],
        connector: Callable[..., Any],
        *,
        max_size: int = 8 * 1024 * 1024,
        reconnect_min_sec: float = 0.25,
        reconnect_max_sec: float = 5.0,
        event_names: set[str] | None = None,
        logger: Callable[[str], None] | None = None,
        device: Any = None,
    ) -> None:
        if connector is None:
            raise ValueError("Gateway websocket connector is required")
        self._connection_factory = connection_factory
        self._connector = connector
        self._max_size = max(1024 * 1024, int(max_size))
        self._reconnect_min_sec = max(0.01, float(reconnect_min_sec))
        self._reconnect_max_sec = max(self._reconnect_min_sec, float(reconnect_max_sec))
        self._event_names = event_names or {"chat", "agent", "session.message", "progressCard.changed", "cron"}
        self._logger = logger or (lambda _message: None)
        # openclaw_device.OpenClawDevice (or None): identity + one-time pairing for non-loopback gateways.
        self._device = device

        self._lifecycle_lock = threading.RLock()
        self._subscriber_lock = threading.RLock()
        self._status_lock = threading.RLock()
        self._subscribers: dict[str, queue.Queue] = {}
        # Per-subscriber event names (None = the client's default set), and the
        # union the receiver forwards at all.
        self._subscriber_events: dict[str, frozenset[str] | None] = {}
        self._wanted_events: frozenset[str] = frozenset(self._event_names)
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_ready = threading.Event()
        self._stopped = threading.Event()
        self._desired_config_key: Any = None

        # The fields below are mutated by the asyncio thread. Status readers use
        # ``_status_lock`` and never receive credentials or raw config keys.
        self._ready: asyncio.Event | None = None
        self._send_lock: asyncio.Lock | None = None
        self._websocket = None
        self._pending: dict[str, asyncio.Future] = {}
        self._connected_config_key: Any = None
        self._last_error = ""
        self._connected_at = 0.0
        self._connection_generation = 0
        self._endpoint_metadata: dict[str, Any] = {}
        self._connected = False
        # What the live connection's hello-ok announced (methods, events, granted
        # scopes, limits), and the access level it was opened with.
        self._hello: dict[str, Any] = {}
        self._access: str | None = None

    def _set_desired_config_key(self, config_key: Any) -> bool:
        changed = False
        with self._lifecycle_lock:
            if self._desired_config_key != config_key:
                self._desired_config_key = config_key
                changed = True
        if changed and self._loop and self._loop.is_running():
            try:
                asyncio.run_coroutine_threadsafe(self._interrupt_for_config_change(), self._loop)
            except RuntimeError:
                pass
        return changed

    def start(self, config_key: Any) -> None:
        self._set_desired_config_key(config_key)
        with self._lifecycle_lock:
            if not (self._thread and self._thread.is_alive()):
                self._stopped.clear()
                self._loop_ready.clear()
                self._thread = threading.Thread(
                    target=self._thread_main,
                    name="vo-openclaw-gateway",
                    daemon=True,
                )
                self._thread.start()
        # Every simultaneous first caller waits for the same loop readiness;
        # only the caller that created the thread used to wait here.
        if not self._loop_ready.wait(timeout=5):
            raise GatewayUnavailableError("OpenClaw Gateway client thread did not start")

    def close(self, timeout: float = 5.0) -> None:
        self._stopped.set()
        loop = self._loop
        if loop and loop.is_running():
            try:
                future = asyncio.run_coroutine_threadsafe(self._shutdown_async(), loop)
                future.result(timeout=max(0.1, timeout))
            except Exception:
                pass
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(0.1, timeout))

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 20.0,
        config_key: Any = None,
        expected_generation: int | None = None,
    ) -> dict[str, Any]:
        timeout = max(0.1, float(timeout))
        if expected_generation is None:
            self.start(config_key)
        elif not self.status().get("connected") or self.status().get("generation") != expected_generation:
            raise GatewayDisconnectedError("Gateway connection changed before the guarded request")
        loop = self._loop
        if not loop or not loop.is_running():
            raise GatewayUnavailableError("OpenClaw Gateway client is unavailable")
        future = asyncio.run_coroutine_threadsafe(
            self._request_async(str(method or ""), params or {}, timeout, config_key, expected_generation),
            loop,
        )
        try:
            return future.result(timeout=timeout + 1.0)
        except concurrent.futures.TimeoutError as exc:
            future.cancel()
            raise GatewayUnavailableError(f"Gateway request '{method}' timed out") from exc

    def subscribe(
        self,
        *,
        config_key: Any = None,
        max_events: int = 2048,
        events: Iterable[str] | None = None,
    ) -> GatewaySubscription:
        """Subscribe to Gateway events. ``events`` names exactly which Gateway
        events this subscriber receives; None keeps the client's default set, so
        existing browser streams never see events added for other consumers."""
        self.start(config_key)
        subscription_id = uuid.uuid4().hex
        event_queue: queue.Queue = queue.Queue(maxsize=max(32, int(max_events)))
        names = None if events is None else frozenset(str(name) for name in events if name)
        with self._subscriber_lock:
            self._subscribers[subscription_id] = event_queue
            self._subscriber_events[subscription_id] = names
            self._recompute_wanted_events()
        status = self.status()
        if status["connected"]:
            self._queue_event(event_queue, self._ready_event(status))
        return GatewaySubscription(self, subscription_id, event_queue)

    def unsubscribe(self, subscription_id: str) -> None:
        with self._subscriber_lock:
            self._subscribers.pop(str(subscription_id), None)
            self._subscriber_events.pop(str(subscription_id), None)
            self._recompute_wanted_events()

    def _recompute_wanted_events(self) -> None:
        wanted = set(self._event_names)
        for names in self._subscriber_events.values():
            if names:
                wanted.update(names)
        self._wanted_events = frozenset(wanted)

    def status(self) -> dict[str, Any]:
        with self._status_lock:
            return {
                "connected": bool(self._connected),
                "connectedAt": self._connected_at,
                "generation": self._connection_generation,
                "pendingRequests": len(self._pending),
                "subscriberCount": len(self._subscribers),
                "lastError": self._last_error,
                "access": self._access,
                **({"version": self._hello["version"]} if self._connected and self._hello.get("version") else {}),
                **({"missingScopes": missing_scopes(self._hello.get("scopes"), self._access)}
                   if self._connected else {}),
                **({"device": self._device.public()} if self._device is not None else {}),
                **self._endpoint_metadata,
            }

    def reconnect(self) -> None:
        """Drop the live connection (if any) so the loop connects again at once with fresh settings."""
        if self._loop and self._loop.is_running():
            try:
                asyncio.run_coroutine_threadsafe(self._interrupt_for_config_change(), self._loop)
            except RuntimeError:
                pass

    def current_config_key(self) -> Any:
        """The configuration key the client is (re)connecting for, so other
        callers can share the connection without reconfiguring it."""
        with self._lifecycle_lock:
            return self._desired_config_key

    def offers(self, method: str) -> bool:
        """Whether the connected Gateway announced ``method`` in hello-ok. What a
        Gateway offers is discovered, never assumed: False while disconnected."""
        with self._status_lock:
            return bool(self._connected) and str(method or "") in self._hello.get("methods", ())

    def sends(self, event: str) -> bool:
        with self._status_lock:
            return bool(self._connected) and str(event or "") in self._hello.get("events", ())

    def grants(self, scope: str) -> bool:
        """Whether the live connection holds ``scope``: the scopes hello-ok says
        were granted, else the ones this connection asked for."""
        with self._status_lock:
            if not self._connected:
                return False
            granted = self._hello.get("scopes")
            if granted is None:
                granted = self._hello.get("requestedScopes", ())
            return str(scope or "") in granted

    def hello(self) -> dict[str, Any]:
        """Public facts from the live hello-ok (no credentials): version,
        protocol, limits, counts. Empty while disconnected."""
        with self._status_lock:
            if not self._connected:
                return {}
            return {
                "version": self._hello.get("version"),
                "protocol": self._hello.get("protocol"),
                "policy": dict(self._hello.get("policy") or {}),
                "methodCount": len(self._hello.get("methods", ())),
                "access": self._access,
            }

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop

        async def run() -> None:
            self._ready = asyncio.Event()
            self._send_lock = asyncio.Lock()
            # Set readiness only after the event loop is actually running. This
            # prevents simultaneous first requests from observing a loop object
            # in the tiny window before ``run_until_complete`` starts it.
            self._loop_ready.set()
            await self._connection_loop()

        try:
            loop.run_until_complete(run())
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            loop.close()
            self._loop = None

    async def _connection_loop(self) -> None:
        backoff = self._reconnect_min_sec
        last_logged = ""
        while not self._stopped.is_set():
            with self._lifecycle_lock:
                config_key = self._desired_config_key
            if config_key is None:
                await asyncio.sleep(0.05)
                continue
            was_connected = False
            try:
                settings = await asyncio.to_thread(self._connection_factory, config_key)
                if not isinstance(settings, dict) or not settings.get("url") or not settings.get("token"):
                    raise GatewayUnavailableError("Gateway connection settings are incomplete")
                with self._lifecycle_lock:
                    if config_key != self._desired_config_key:
                        continue
                await self._run_connection(config_key, settings)
                was_connected = True
                backoff = self._reconnect_min_sec
            except asyncio.CancelledError:
                break
            except _RetryAsDevice:
                continue
            except Exception as exc:
                message = str(exc)[:500] or type(exc).__name__
                with self._status_lock:
                    was_connected = was_connected or self._connected
                    self._last_error = message
                if was_connected:
                    backoff = self._reconnect_min_sec
                self._mark_disconnected(message)
                if not self._stopped.is_set():
                    self._broadcast({"type": "proxy.error", "payload": {"message": message}})
                    if message != last_logged:  # a pending approval is retried quietly
                        self._logger(f"[openclaw-proxy] Gateway unavailable: {message}")
                    last_logged = message if isinstance(exc, GatewayPairingRequired) else ""
            if self._stopped.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(self._reconnect_max_sec, backoff * 2)

    async def _run_connection(self, config_key: Any, settings: dict[str, Any]) -> None:
        connector_options = {
            "max_size": self._max_size,
            "close_timeout": 3,
        }
        url = str(settings["url"])
        async with self._connector(url, **connector_options) as websocket:
            self._websocket = websocket
            first = await asyncio.wait_for(websocket.recv(), timeout=5)
            access = normalize_access(settings.get("access"))
            scopes = scopes_for_access(access)
            connect_id = f"vo-gateway-connect-{uuid.uuid4()}"
            client = {
                "id": "gateway-client",
                "version": str(settings.get("clientVersion") or "unknown"),
                "platform": "server",
                "mode": "backend",
            }
            params = {
                "minProtocol": 4,
                "maxProtocol": 4,
                "client": client,
                "role": "operator",
                "scopes": scopes,
                "caps": ["tool-events"],
                "commands": [],
                "permissions": {},
                "auth": {"token": str(settings["token"])},
                "locale": "en-US",
                "userAgent": "virtual-office-server/gateway-client",
            }
            # Device identity (signed challenge) only where OpenClaw needs it: see openclaw_device.py.
            device = None
            wanted = self._device is not None and self._device.wanted(url)
            if wanted:
                device = await asyncio.to_thread(self._device.sign_connect, _challenge_of(first), client,
                                                 "operator", scopes, str(settings["token"]))
                if device:
                    params["device"] = device
            await websocket.send(json.dumps({"type": "req", "id": connect_id, "method": "connect", "params": params}))
            while True:
                response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
                if response.get("id") != connect_id:
                    continue
                if not response.get("ok"):
                    error = response.get("error") if isinstance(response.get("error"), dict) else {}
                    waiting = self._device.note_refusal(url, error) if device else None
                    if waiting:
                        raise GatewayPairingRequired(waiting)
                    raise GatewayUnavailableError(error.get("message") or "Gateway authentication failed")
                break
            payload = response.get("payload") if isinstance(response.get("payload"), dict) else {}
            hello = self._hello_facts(payload, scopes)
            if device:
                await asyncio.to_thread(self._device.note_hello, url, payload.get("auth"))
            elif self._device is not None and not wanted and \
                    set(missing_scopes(hello.get("scopes"), access)) & set(_NEEDED_CHAT):
                # A token-only handshake without read/write (OpenClaw outside loopback, or a proxy in front of
                # it): retry once as a device; from then on this gateway always gets the device.
                await asyncio.to_thread(self._device.require, url)
                await websocket.close(code=1000, reason="Retrying with device identity")
                raise _RetryAsDevice("retrying with device identity")

            with self._lifecycle_lock:
                if config_key != self._desired_config_key:
                    await websocket.close(code=1000, reason="Gateway configuration changed")
                    return
            self._connected_config_key = config_key
            public_metadata = {
                key: value
                for key, value in settings.items()
                if key in {"transport", "endpointMode", "endpointLocation", "endpointLabel"}
            }
            with self._status_lock:
                self._connected = True
                self._connected_at = time.time()
                self._connection_generation += 1
                self._last_error = ""
                self._endpoint_metadata = public_metadata
                self._hello = hello
                self._access = access
                generation = self._connection_generation
            self._ready.set()
            short = missing_scopes(hello.get("scopes"), access)
            self._logger(f"[openclaw-proxy] Gateway connection ready (generation {generation})"
                         + (f", but OpenClaw did not grant {', '.join(short)}" if short else ""))
            self._broadcast(self._ready_event(self.status()))

            try:
                async for raw in websocket:
                    try:
                        message = json.loads(raw)
                    except (TypeError, ValueError):
                        continue
                    message_type = message.get("type")
                    if message_type == "res":
                        pending = self._pending.pop(str(message.get("id") or ""), None)
                        if pending and not pending.done():
                            pending.set_result(message)
                    elif message_type == "event" and message.get("event") in self._wanted_events:
                        self._broadcast(message)
            finally:
                self._websocket = None
                if not self._stopped.is_set():
                    raise GatewayDisconnectedError("OpenClaw Gateway connection closed")

    async def _request_async(
        self,
        method: str,
        params: dict[str, Any],
        timeout: float,
        expected_config_key: Any,
        expected_generation: int | None = None,
    ) -> dict[str, Any]:
        if not method:
            raise ValueError("Gateway method is required")
        started = asyncio.get_running_loop().time()
        while True:
            with self._lifecycle_lock:
                desired = self._desired_config_key
            if desired != expected_config_key:
                raise GatewayUnavailableError("Gateway configuration changed before the request was sent")
            remaining = timeout - (asyncio.get_running_loop().time() - started)
            if remaining <= 0:
                error = self.status().get("lastError") or "Gateway connection timed out"
                raise GatewayUnavailableError(str(error))
            try:
                await asyncio.wait_for(self._ready.wait(), timeout=remaining)
            except asyncio.TimeoutError as exc:
                error = self.status().get("lastError") or "Gateway connection timed out"
                raise GatewayUnavailableError(str(error)) from exc
            if self._connected_config_key == expected_config_key and self._websocket is not None:
                break
            await asyncio.sleep(0)

        request_id = f"vo-gateway-{uuid.uuid4()}"
        response_future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = response_future
        frame = {"type": "req", "id": request_id, "method": method, "params": params}
        try:
            async with self._send_lock:
                websocket = self._websocket
                if websocket is None:
                    raise GatewayDisconnectedError("Gateway disconnected before the request was sent")
                if expected_generation is not None:
                    # Guard within the send lock, after every await: a queued
                    # completed-plan dismissal must NEVER land on a replacement
                    # connection with a coincidentally matching native revision.
                    if (self._connection_generation != expected_generation
                            or self._connected_config_key != expected_config_key
                            or self._desired_config_key != expected_config_key):
                        raise GatewayDisconnectedError("Gateway connection changed before the guarded request")
                await websocket.send(json.dumps(frame))
            remaining = timeout - (asyncio.get_running_loop().time() - started)
            if remaining <= 0:
                raise asyncio.TimeoutError
            return await asyncio.wait_for(response_future, timeout=remaining)
        except asyncio.TimeoutError as exc:
            raise GatewayUnavailableError(f"Gateway request '{method}' timed out") from exc
        finally:
            pending = self._pending.pop(request_id, None)
            if pending and not pending.done():
                pending.cancel()

    async def _interrupt_for_config_change(self) -> None:
        websocket = self._websocket
        if websocket is not None:
            await websocket.close(code=1000, reason="Gateway configuration changed")

    async def _shutdown_async(self) -> None:
        self._stopped.set()
        websocket = self._websocket
        if websocket is not None:
            try:
                await websocket.close(code=1001, reason="Virtual Office shutting down")
            except Exception:
                pass
        self._mark_disconnected("Virtual Office Gateway client stopped")

    def _mark_disconnected(self, message: str) -> None:
        if self._ready:
            self._ready.clear()
        self._connected_config_key = None
        with self._status_lock:
            self._connected = False
            self._hello = {}
            if message:
                self._last_error = str(message)[:500]
        error = GatewayDisconnectedError(
            "Gateway disconnected while awaiting a response; the request was not replayed"
        )
        pending = list(self._pending.values())
        self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(error)

    @staticmethod
    def _hello_facts(payload: Any, requested_scopes: list[str]) -> dict[str, Any]:
        """The parts of hello-ok the office uses: offered methods/events, granted
        scopes (None when the Gateway does not say), limits and version."""
        hello = payload if isinstance(payload, dict) else {}
        features = hello.get("features") if isinstance(hello.get("features"), dict) else {}
        auth = hello.get("auth") if isinstance(hello.get("auth"), dict) else {}
        server = hello.get("server") if isinstance(hello.get("server"), dict) else {}
        policy = hello.get("policy") if isinstance(hello.get("policy"), dict) else {}
        attachments = policy.get("attachments") if isinstance(policy.get("attachments"), dict) else {}
        limits: dict[str, Any] = {}
        if isinstance(policy.get("maxPayload"), int):
            limits["maxPayload"] = policy["maxPayload"]
        clean_attachments = {
            key: attachments[key]
            for key in ("maxBytes", "maxImageBytes", "maxCount")
            if isinstance(attachments.get(key), int)
        }
        if clean_attachments:
            limits["attachments"] = clean_attachments
        version = server.get("version")
        return {
            "methods": frozenset(_string_list(features.get("methods"))),
            "events": frozenset(_string_list(features.get("events"))),
            "scopes": frozenset(_string_list(auth.get("scopes"))) if isinstance(auth.get("scopes"), list) else None,
            "requestedScopes": frozenset(requested_scopes),
            "policy": limits,
            "version": str(version)[:64] if isinstance(version, (str, int, float)) and version != "" else None,
            "protocol": hello.get("protocol") if isinstance(hello.get("protocol"), int) else None,
        }

    def _ready_event(self, status: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "proxy.ready",
            "payload": {
                "transport": "server-proxy",
                "generation": status.get("generation") or 0,
            },
        }

    def _broadcast(self, event: dict[str, Any]) -> None:
        if event.get("event") == "progressCard.changed":
            payload = event.get("payload")
            if not isinstance(payload, dict):
                return
            key, revision = payload.get("sessionKey"), payload.get("revision")
            if not isinstance(key, str) or not key.startswith("agent:") or len(key) > 1024:
                return
            if revision is not None and (type(revision) is not int or not 1 <= revision <= 9007199254740991):
                return
            # Progress notifications expose identity/revision only, never a raw
            # native payload, transcript, notes, tool results or private fields.
            event = {"type": "event", "event": "progressCard.changed", "payload": {"sessionKey": key, "revision": revision}}
        name = event.get("event") if event.get("type") == "event" else None
        with self._subscriber_lock:
            subscribers = [
                (events, self._subscriber_events.get(subscription_id))
                for subscription_id, events in self._subscribers.items()
            ]
        for events, names in subscribers:
            # proxy.* frames reach everyone; a Gateway event only the
            # subscribers that asked for its name (default set when unnamed).
            if name is not None and name not in (self._event_names if names is None else names):
                continue
            self._queue_event(events, event)

    @staticmethod
    def _queue_event(events: queue.Queue, event: dict[str, Any]) -> None:
        try:
            events.put_nowait(event)
            return
        except queue.Full:
            pass
        # A stalled browser must not block the Gateway receiver. Drop the oldest
        # event; the browser's existing final/history reconciliation repairs it.
        try:
            events.get_nowait()
        except queue.Empty:
            pass
        try:
            events.put_nowait(event)
        except queue.Full:
            pass
