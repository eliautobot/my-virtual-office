#!/usr/bin/env python3
"""Gateway Presence — derives agent working/idle state from OpenClaw gateway events.

Replaces the old office.py manual status updates with automatic detection.
Connects to the gateway WebSocket, monitors session activity, and maintains
in-memory presence state that server.py can read.

Architecture:
  Gateway WS events + sessions.list polling → in-memory state dict → server.py reads it

Does NOT modify the gateway. Read-only observer.
"""

import asyncio
import json
import time
import threading
import traceback

try:
    import websockets
    from websockets.asyncio.client import connect as ws_connect
except ImportError:
    websockets = None


# ─── In-Memory Presence State ────────────────────────────────────

_state = {}        # agent_id → {state, task, updated, source}
_state_lock = threading.Lock()
_meetings = []     # Meetings still managed manually via office.py
_meetings_lock = threading.Lock()

# Manual overrides (from office.py or POST /api/presence) expire after this many seconds
MANUAL_OVERRIDE_TTL = 30

# How long after last activity before an agent is considered idle
IDLE_TIMEOUT_SEC = 120

# How often to poll sessions.list
SESSIONS_POLL_SEC = 10

# Track last known updatedAt per session key for change detection
_last_updated_at = {}  # session_key → updatedAt timestamp (ms)

# Track real-time event activity per agent
_last_event_at = {}   # agent_id → timestamp (seconds)
_last_event_task = {}  # agent_id → task description from event

# Manual override tracking
_manual_overrides = {}  # agent_id → {state, task, updated, expires}

# Gateway connection state
_gw_connected = False
_gw_error = None


def get_state():
    """Return current presence state dict. Called by server.py for /status endpoint."""
    with _state_lock:
        result = dict(_state)
    with _meetings_lock:
        result["_meetings"] = list(_meetings)
    return result


def get_agent_state(agent_id):
    """Return state for a single agent."""
    with _state_lock:
        return dict(_state.get(agent_id, {"state": "idle", "task": "", "updated": 0}))


def set_manual_override(agent_id, state, task=""):
    """Set a manual override (from office.py or POST /api/presence).
    Takes priority over gateway-derived state for MANUAL_OVERRIDE_TTL seconds."""
    now = int(time.time())
    _manual_overrides[agent_id] = {
        "state": state,
        "task": task,
        "updated": now,
        "expires": now + MANUAL_OVERRIDE_TTL
    }
    # Immediately apply to state
    with _state_lock:
        if agent_id not in _state:
            _state[agent_id] = {}
        _state[agent_id].update({
            "state": state,
            "task": task,
            "updated": now,
            "source": "manual"
        })


def set_meetings(meetings_list):
    """Replace meetings list (from office.py --meet/--end-meet)."""
    with _meetings_lock:
        _meetings.clear()
        _meetings.extend(meetings_list)


def get_meetings():
    """Get current meetings."""
    with _meetings_lock:
        return list(_meetings)


def add_meeting(meeting):
    """Add a meeting."""
    with _meetings_lock:
        # Remove existing with same id
        _meetings[:] = [m for m in _meetings if m.get("id") != meeting.get("id")]
        _meetings.append(meeting)


def end_meeting(meet_id):
    """End a meeting by id."""
    with _meetings_lock:
        before = len(_meetings)
        _meetings[:] = [m for m in _meetings if m.get("id") != meet_id]
        return len(_meetings) < before


def end_all_meetings():
    """End all meetings."""
    with _meetings_lock:
        _meetings.clear()


def get_connection_status():
    """Return gateway connection status."""
    return {"connected": _gw_connected, "error": _gw_error}


def init_agents(agent_ids):
    """Initialize state for discovered agents."""
    with _state_lock:
        for aid in agent_ids:
            if aid not in _state:
                _state[aid] = {"state": "idle", "task": "", "updated": 0, "source": "init"}


# ─── Event Processing ────────────────────────────────────────────

def _extract_agent_id(session_key):
    """Extract agent_id from session key like 'agent:pq-mike:main'."""
    if not session_key or not session_key.startswith("agent:"):
        return None
    parts = session_key.split(":")
    if len(parts) >= 2:
        return parts[1]
    return None


def _format_tool_task(name, arguments):
    """Format a tool call into a human-readable task description."""
    args = arguments or {}
    if name == "exec":
        cmd = args.get("command", "")
        if "openclaw agent" in cmd:
            import re
            m_agent = re.search(r'--agent\s+(\S+)', cmd)
            m_msg = re.search(r'--message\s+"([^"]*)"', cmd)
            aname = m_agent.group(1) if m_agent else "agent"
            mtxt = m_msg.group(1)[:40] if m_msg else ""
            return f"Delegating to {aname}" + (f": {mtxt}" if mtxt else "")
        elif "office.py" in cmd:
            return None  # Ignore office.py calls (legacy)
        elif "outlook-cli" in cmd:
            return "Working with Outlook"
        elif "gog " in cmd:
            return "Working with Google"
        elif "curl" in cmd:
            return "Making HTTP request"
        return f"Running command"
    elif name == "sessions_send":
        label = args.get("label", args.get("sessionKey", ""))
        return f"Messaging {label}" if label else "Messaging agent"
    elif name == "web_search":
        q = args.get("query", "")[:40]
        return f"Searching: {q}" if q else "Web search"
    elif name == "web_fetch":
        return "Fetching web page"
    elif name == "browser":
        return "Using browser"
    elif name == "read" or name == "Read":
        return "Reading file"
    elif name == "write" or name == "Write":
        return "Writing file"
    elif name == "edit" or name == "Edit":
        return "Editing file"
    elif name == "memory_search":
        return "Searching memory"
    elif name == "tts":
        return "Text to speech"
    elif name == "image":
        return "Analyzing image"
    elif name == "pdf":
        return "Analyzing PDF"
    return f"Using {name}"


def _process_event(event_type, payload):
    """Process a gateway event and update presence state."""
    session_key = payload.get("sessionKey", "")
    agent_id = _extract_agent_id(session_key)
    if not agent_id:
        return

    now = time.time()

    # Check if manual override is active
    override = _manual_overrides.get(agent_id)
    if override and override["expires"] > now:
        return  # Manual override still active, don't change state

    # Clear expired overrides
    if override and override["expires"] <= now:
        del _manual_overrides[agent_id]

    task = None

    if event_type == "chat":
        state_val = payload.get("state", "")
        if state_val in ("delta", "streaming"):
            task = "Responding..."
            _last_event_at[agent_id] = now
            _last_event_task[agent_id] = task
        elif state_val in ("final", "done"):
            # Turn complete — record recent activity, but don't force idle immediately.
            # Let sessions polling + idle timeout decide when the agent is truly idle.
            _last_event_at[agent_id] = now
            _last_event_task[agent_id] = ""
            return

    elif event_type == "agent":
        agent_type = payload.get("type", "")
        if agent_type == "thinking":
            task = "Thinking..."
        elif agent_type == "tool_start":
            name = payload.get("name", "")
            arguments = payload.get("arguments", {})
            task = _format_tool_task(name, arguments)
            if task is None:
                return  # Skip office.py calls
        elif agent_type == "tool_end" or agent_type == "tool_result":
            task = "Processing..."
        elif agent_type == "error":
            task = None  # Will be handled by idle timeout

        if task is not None:
            _last_event_at[agent_id] = now
            _last_event_task[agent_id] = task

    if task is not None:
        with _state_lock:
            if agent_id not in _state:
                _state[agent_id] = {}
            _state[agent_id].update({
                "state": "working",
                "task": task,
                "updated": int(now),
                "source": "gateway"
            })


def _process_sessions_list(sessions):
    """Process sessions.list response to detect activity changes."""
    now = time.time()
    now_ms = now * 1000

    for s in sessions:
        if not isinstance(s, dict):
            continue
        key = s.get("key", "")
        if not key.startswith("agent:") or not key.endswith(":main"):
            continue

        agent_id = _extract_agent_id(key)
        if not agent_id:
            continue

        updated_at = s.get("updatedAt", 0)
        prev_updated = _last_updated_at.get(key, 0)

        # Check if manual override is active
        override = _manual_overrides.get(agent_id)
        if override and override["expires"] > now:
            _last_updated_at[key] = updated_at
            continue

        # Clear expired overrides and reset source
        if override and override["expires"] <= now:
            del _manual_overrides[agent_id]
            with _state_lock:
                if agent_id in _state and _state[agent_id].get("source") == "manual":
                    _state[agent_id]["source"] = "manual-expired"

        # Auto-register agents discovered from gateway
        with _state_lock:
            if agent_id not in _state:
                _state[agent_id] = {"state": "idle", "task": "", "updated": 0, "source": "discovered"}

        session_is_fresh = updated_at and ((now_ms - updated_at) / 1000) < IDLE_TIMEOUT_SEC
        session_changed = updated_at > prev_updated

        if session_is_fresh and (session_changed or prev_updated == 0):
            # Session is active right now — mark working even on first sight.
            # This lets polling recover if the WS event stream missed activity.
            last_evt = _last_event_at.get(agent_id, 0)
            if now - last_evt > 5:
                # No recent real-time event, use sessions.list detection
                with _state_lock:
                    current = _state[agent_id].get("state", "idle")
                    current_task = _state[agent_id].get("task", "")
                    if current != "working" or not current_task:
                        _state[agent_id].update({
                            "state": "working",
                            "task": current_task or "Active",
                            "updated": int(now),
                            "source": "gateway-poll"
                        })

        _last_updated_at[key] = updated_at

        # Check for idle timeout
        last_activity = max(
            updated_at / 1000,
            _last_event_at.get(agent_id, 0)
        )
        idle_for = now - last_activity

        if idle_for > IDLE_TIMEOUT_SEC:
            with _state_lock:
                current_state = _state[agent_id].get("state", "idle")
                current_source = _state[agent_id].get("source", "")
                # Only skip if there's an ACTIVE (non-expired) manual override
                has_active_override = (agent_id in _manual_overrides and
                    _manual_overrides[agent_id]["expires"] > now)
                if current_state == "working" and not has_active_override:
                    _state[agent_id].update({
                        "state": "idle",
                        "task": "",
                        "updated": int(now),
                        "source": "gateway-idle"
                    })


# ─── Meeting File Sync ────────────────────────────────────────────

_meetings_file = None  # Set by start() to STATUS_FILE path


def set_meetings_file(filepath):
    """Set the path to the status file that office.py writes meetings to."""
    global _meetings_file
    _meetings_file = filepath


def _sync_meetings_from_file():
    """Read _meetings from the status JSON file (written by office.py --meet)."""
    if not _meetings_file:
        return
    try:
        with open(_meetings_file, "r") as f:
            data = json.load(f)
        file_meetings = data.get("_meetings", [])
        if isinstance(file_meetings, list):
            with _meetings_lock:
                _meetings.clear()
                _meetings.extend(file_meetings)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    except Exception as e:
        print(f"⚠️  Gateway presence: meeting sync error: {e}")


# ─── Gateway Connection ──────────────────────────────────────────

async def _gateway_loop(gateway_url, gateway_token, origin):
    """Main gateway connection loop with reconnection.
    
    Uses a single-reader architecture: one coroutine reads all WS messages
    and dispatches to event processing + routes responses to the poller.
    """
    global _gw_connected, _gw_error

    _consecutive_failures = 0
    _origin_tip_shown = False

    while True:
        try:
            _gw_error = None

            async with ws_connect(
                gateway_url,
                max_size=10 * 1024 * 1024,
                additional_headers={"Origin": origin},
                close_timeout=5,
            ) as ws:
                # Wait for challenge
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                msg = json.loads(raw)

                if msg.get("type") != "event" or msg.get("event") != "connect.challenge":
                    print(f"⚠️  Gateway presence: unexpected first message: {msg.get('type')}")
                    await asyncio.sleep(5)
                    continue

                # Send connect
                connect_msg = {
                    "type": "req",
                    "id": f"gp-connect-{int(time.time())}",
                    "method": "connect",
                    "params": {
                        "minProtocol": 3,
                        "maxProtocol": 3,
                        "client": {
                            "id": "openclaw-control-ui",
                            "version": "2026.2.9",
                            "platform": "server",
                            "mode": "webchat"
                        },
                        "role": "operator",
                        "scopes": ["operator.read"],
                        "caps": [],
                        "commands": [],
                        "permissions": {},
                        "auth": {"token": gateway_token}
                    }
                }
                await ws.send(json.dumps(connect_msg))

                # Wait for connect response
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                res = json.loads(raw)
                if not res.get("ok"):
                    err = res.get("error", {}).get("message", "unknown error")
                    _gw_error = err
                    _consecutive_failures += 1
                    should_log = (_consecutive_failures == 1 or _consecutive_failures % 10 == 0)
                    if should_log:
                        print(f"❌ Gateway presence: connect failed: {err} (attempt {_consecutive_failures})")
                    # Show one-time tip for origin not allowed
                    if not _origin_tip_shown and ("origin" in err.lower() or "not allowed" in err.lower()):
                        print("💡 Tip: Run the setup wizard or add your origin to gateway.controlUi.allowedOrigins in openclaw.json")
                        _origin_tip_shown = True
                    sleep_sec = min(60, 5 * (2 ** min(_consecutive_failures - 1, 4)))
                    await asyncio.sleep(sleep_sec)
                    continue

                # Successful connection — reset failure counter
                _consecutive_failures = 0
                _gw_connected = True
                print("✅ Gateway presence: connected")

                # Single-reader loop + poller + ping
                # Use an asyncio.Queue to pass responses from reader to poller
                response_queue = asyncio.Queue()

                await asyncio.gather(
                    _message_reader(ws, response_queue),
                    _sessions_poller(ws, response_queue),
                    _ping_loop(ws),
                )

        except asyncio.CancelledError:
            break
        except (ConnectionRefusedError, ConnectionResetError, OSError) as e:
            # Gateway not available — quiet retry, no traceback spam
            _gw_connected = False
            _gw_error = str(e)
            _consecutive_failures += 1
            should_log = (_consecutive_failures == 1 or _consecutive_failures % 10 == 0)
            if should_log:
                if "Connect call failed" in str(e) or "Connection refused" in str(e):
                    print(f"⚠️  Gateway presence: gateway not reachable at {gateway_url} (attempt {_consecutive_failures})")
                else:
                    print(f"⚠️  Gateway presence: connection error: {e} (attempt {_consecutive_failures})")
            sleep_sec = min(60, 5 * (2 ** min(_consecutive_failures - 1, 4)))
            await asyncio.sleep(sleep_sec)
        except Exception as e:
            _gw_connected = False
            _gw_error = str(e)
            _consecutive_failures += 1
            should_log = (_consecutive_failures == 1 or _consecutive_failures % 10 == 0)
            if should_log:
                print(f"⚠️  Gateway presence: error: {e} (attempt {_consecutive_failures})")
                traceback.print_exc()
            sleep_sec = min(60, 5 * (2 ** min(_consecutive_failures - 1, 4)))
            await asyncio.sleep(sleep_sec)


async def _message_reader(ws, response_queue):
    """Single reader: reads all WS messages, dispatches events, routes responses."""
    global _gw_connected
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "event":
                event = msg.get("event", "")
                payload = msg.get("payload", {})
                if event in ("chat", "agent"):
                    _process_event(event, payload)
                # Ignore health, tick, presence

            elif msg_type == "res":
                # Route response to poller
                await response_queue.put(msg)

    except websockets.exceptions.ConnectionClosed:
        _gw_connected = False
        print("⚠️  Gateway presence: connection closed")
    except Exception as e:
        _gw_connected = False
        print(f"⚠️  Gateway presence: reader error: {e}")


async def _sessions_poller(ws, response_queue):
    """Periodically send sessions.list requests and process responses."""
    req_counter = 0
    while True:
        try:
            await asyncio.sleep(SESSIONS_POLL_SEC)
            req_counter += 1
            req_id = f"gp-sl-{req_counter}"

            req = {
                "type": "req",
                "id": req_id,
                "method": "sessions.list",
                "params": {}
            }
            await ws.send(json.dumps(req))

            # Wait for our response from the queue
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    remaining = max(0.1, deadline - time.time())
                    msg = await asyncio.wait_for(response_queue.get(), timeout=remaining)

                    if msg.get("id") == req_id:
                        if msg.get("ok"):
                            sessions = msg.get("payload", {}).get("sessions", [])
                            _process_sessions_list(sessions)
                        # Sync meetings from file on each poll cycle
                        _sync_meetings_from_file()
                        break
                    # Not our response — discard (could be from another request)
                except asyncio.TimeoutError:
                    break

        except websockets.exceptions.ConnectionClosed:
            break
        except Exception as e:
            print(f"⚠️  Gateway presence: poll error: {e}")
            await asyncio.sleep(5)


async def _ping_loop(ws):
    """Keep connection alive."""
    try:
        while True:
            await asyncio.sleep(30)
            await ws.ping()
    except Exception:
        pass


# ─── Public Start/Stop ────────────────────────────────────────────

_thread = None
_loop = None


def start(gateway_url, gateway_token, port=8090):
    """Start the gateway presence listener in a background thread."""
    global _thread, _loop

    if websockets is None:
        print("⚠️  Gateway presence: websockets not installed, skipping")
        return

    if _thread and _thread.is_alive():
        print("⚠️  Gateway presence: already running")
        return

    origin = f"http://127.0.0.1:{port}"

    def run():
        global _loop
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
        try:
            _loop.run_until_complete(_gateway_loop(gateway_url, gateway_token, origin))
        except RuntimeError as e:
            if "Event loop stopped" not in str(e):
                print(f"⚠️  Gateway presence: runtime error: {e}")
        except Exception as e:
            print(f"⚠️  Gateway presence: thread error: {e}")
        finally:
            # Clean up pending tasks
            try:
                pending = asyncio.all_tasks(_loop)
                for task in pending:
                    task.cancel()
                if pending:
                    _loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                _loop.close()
            except Exception:
                pass

    _thread = threading.Thread(target=run, daemon=True, name="gateway-presence")
    _thread.start()
    print(f"🔌 Gateway presence: started background listener → {gateway_url}")


def stop():
    """Stop the gateway presence listener."""
    global _loop, _gw_connected
    _gw_connected = False
    if _loop:
        _loop.call_soon_threadsafe(_loop.stop)


# ─── Snapshot to Disk (for crash recovery) ────────────────────────

def save_snapshot(filepath):
    """Save current state to disk for crash recovery."""
    data = get_state()
    try:
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"⚠️  Gateway presence: snapshot save error: {e}")


def load_snapshot(filepath):
    """Load state from disk snapshot (on startup)."""
    try:
        with open(filepath, "r") as f:
            data = json.load(f)
        with _state_lock:
            for key, val in data.items():
                if key == "_meetings":
                    with _meetings_lock:
                        _meetings.clear()
                        _meetings.extend(val if isinstance(val, list) else [])
                elif isinstance(val, dict):
                    # Reset to idle on load (we don't know if they're still working)
                    _state[key] = {
                        "state": "idle",
                        "task": "",
                        "updated": val.get("updated", 0),
                        "source": "snapshot"
                    }
        print(f"✅ Gateway presence: loaded snapshot from {filepath}")
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"⚠️  Gateway presence: snapshot load error: {e}")
