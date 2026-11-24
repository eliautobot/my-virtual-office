"""Per-agent permissions for the agents the office launches itself (v0.13.1).

Codex and Claude Code agents are started by the office (``codex app-server``, ``claude -p``), so the office
chooses how much they may do on every run. OpenClaw and Hermes agents are not here: their permissions stay in
their own gateway. The user picks a mode per agent in the chat window (like the native apps' approval modes);
the choice is kept in ``<data>/agent-permissions.json`` and applied when the next message starts a run.

Codex modes (``sandbox`` + ``approvalPolicy`` of the app-server thread / turn):
  read-only  Codex's sandbox, read only; it asks to do more            (offered when the sandbox works here)
  ask        asks in the chat before any command or change it is not sure is safe (approval "untrusted")
  full       no sandbox, never asks
Codex's sandbox (bubblewrap) usually cannot start inside a Docker container (no user namespaces): there "ask"
runs without it and Read only is not offered, rather than every command failing.

Claude Code modes (``--permission-mode``; the office runs it with ``-p``, where nobody can be asked):
  read-only  "default": it reads and answers; edits and commands are refused
  plan       "plan": it plans changes without making them
  edits      "acceptEdits": it edits files; commands that need permission are refused
  full       "bypassPermissions": everything, without asking

Only the office's owner (a signed-in browser or this machine; never the agent API token) changes a mode, so an
agent cannot give itself more access.

What the owner picks is kept: the file lives in the data folder, so it stays through updates, image rebuilds and
restarts, and a saved mode always wins over the office's settings (VO_CODEX_APPROVAL_POLICY etc. only give the
starting mode of an agent nobody has set yet: Ask first for Codex unless the office says otherwise). The mode ids
below are saved in that file: never rename one. A mode this place cannot offer (Read only without Codex's sandbox)
is kept in the file and used again where it can be. A damaged file is set aside (agent-permissions.json.bad-<time>),
never silently replaced; a file the office cannot read is never overwritten. Deleting an agent forgets its mode, so
a new agent with the same name starts at the default, not at what the old one was allowed.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time

import private_files

KINDS = ("codex", "claude-code")

CODEX_MODES = {
    "read-only": {"label": "Read only", "hint": "Reads files and answers. Asks you before it changes anything.",
                  "needsSandbox": True},
    "ask": {"label": "Ask first", "hint": "Asks you in this chat before it runs a command or changes files."},
    "full": {"label": "Full access", "hint": "Runs commands and changes files without asking.", "warn": True},
}
CLAUDE_MODES = {
    "read-only": {"label": "Read only", "hint": "Reads files and answers. No edits or commands."},
    "plan": {"label": "Plan only", "hint": "Plans the changes without making them."},
    "edits": {"label": "Edit files", "hint": "Edits files. Commands that need permission are refused."},
    "full": {"label": "Full access", "hint": "Edits files and runs any command without asking.", "warn": True},
}
CLAUDE_PERMISSION_MODE = {"read-only": "default", "plan": "plan", "edits": "acceptEdits", "full": "bypassPermissions"}
FULL_WARNING = ("Full access lets this agent run any command and change any file the office can reach, "
                "without asking you first.")

FILE_VERSION = 1
RUN_KEY = "run"            # {"run": {kind: {agent: {"model": ..., "effort": ...}}}}: model and thinking level
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,119}$")
_EFFORT_RE = re.compile(r"^[a-z][a-z0-9-]{0,23}$")
CODEX_DEFAULT_APPROVAL = "untrusted"     # a new Codex agent starts at Ask first

_LOCK = threading.Lock()
_SANDBOX = {}           # codex binary -> (checked at, works)
_SANDBOX_TTL_S = 6 * 3600


def _path(data_dir):
    return os.path.join(data_dir, "agent-permissions.json")


def _load(data_dir, for_write=False):
    """The saved modes. for_write (about to save): a file the office cannot read raises (it is never overwritten),
    a damaged one is set aside first; reading for a run just falls back to the defaults."""
    path = _path(data_dir)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except ValueError:
        data = None
    except OSError:
        if for_write:
            raise
        return {}
    if isinstance(data, dict):
        return data
    if for_write:
        try:
            os.replace(path, f"{path}.bad-{int(time.time())}")
        except OSError:
            raise OSError("agent-permissions.json is damaged and could not be set aside")
    return {}


def _save(data_dir, data):
    data = {k: v for k, v in data.items() if k in KINDS + (RUN_KEY,) and isinstance(v, dict)}
    data["version"] = FILE_VERSION
    # private (0600), keeps its owner; a new file takes the data folder's owner (Docker runs as root)
    private_files.write_private(_path(data_dir), json.dumps(data, indent=1, sort_keys=True) + "\n")


def _kind_table(data, kind):
    table = data.get(kind) if isinstance(data, dict) else None
    return dict(table) if isinstance(table, dict) else {}


def codex_sandbox_works(binary, timeout=10):
    """True when Codex's own sandbox can start here (checked once, again after 6 h)."""
    binary = str(binary or "codex")
    now = time.time()
    with _LOCK:
        hit = _SANDBOX.get(binary)
        if hit and now - hit[0] < _SANDBOX_TTL_S:
            return hit[1]
    works = False
    try:
        proc = subprocess.run([binary, "sandbox", "--", "true"], capture_output=True, timeout=timeout,
                              stdin=subprocess.DEVNULL)
        works = proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        works = False
    with _LOCK:
        _SANDBOX[binary] = (now, works)
    return works


def _modes(kind, sandbox):
    if kind == "codex":
        return [(mid, m) for mid, m in CODEX_MODES.items() if sandbox or not m.get("needsSandbox")]
    return list(CLAUDE_MODES.items())


def default_mode(kind, config, sandbox=True):
    """The mode a new agent starts in: from the office's settings (VO_CODEX_APPROVAL_POLICY / _SANDBOX,
    VO_CLAUDE_CODE_PERMISSION_MODE)."""
    config = config if isinstance(config, dict) else {}
    if kind == "codex":
        policy = str(config.get("approvalPolicy") or CODEX_DEFAULT_APPROVAL).strip()
        if str(config.get("sandbox") or "") == "read-only" and sandbox:
            return "read-only"
        return "full" if policy == "never" else "ask"
    mode = str(config.get("permissionMode") or "acceptEdits").strip()
    return {"bypassPermissions": "full", "acceptEdits": "edits", "plan": "plan"}.get(mode, "read-only")


def current(data_dir, kind, agent_id, config, sandbox=True):
    """(mode, saved) for one agent; a saved mode the place no longer offers falls back to the default."""
    saved = _kind_table(_load(data_dir), kind).get(str(agent_id))
    saved = saved.strip() if isinstance(saved, str) else ""
    offered = {mid for mid, _m in _modes(kind, sandbox)}
    if saved in offered:
        return saved, True
    return default_mode(kind, config, sandbox), False


def describe(data_dir, kind, agent_id, config, sandbox=True, can_change=False):
    mode, saved = current(data_dir, kind, agent_id, config, sandbox)
    note = ""
    if kind == "codex" and not sandbox:
        note = "Codex's own sandbox cannot start here (in Docker it needs extra privileges), so Read only is not offered."
    if kind == "claude-code":
        note = "The office starts Claude Code without a way to ask you, so a step it may not take is refused."
    return {"ok": True, "kind": kind, "agent": str(agent_id), "mode": mode, "saved": saved, "canChange": bool(can_change),
            "options": [{"id": mid, "label": m["label"], "hint": m["hint"], "warn": bool(m.get("warn"))}
                        for mid, m in _modes(kind, sandbox)],
            "warning": FULL_WARNING, "note": note}


def set_mode(data_dir, kind, agent_id, mode, sandbox=True):
    if kind not in KINDS:
        raise ValueError("unknown agent kind")
    if mode not in {mid for mid, _m in _modes(kind, sandbox)}:
        raise ValueError("that permission mode is not offered here")
    agent_id = str(agent_id or "").strip()
    if not agent_id or len(agent_id) > 200:
        raise ValueError("agent is required")
    with _LOCK:
        data = _load(data_dir, for_write=True)
        data[kind] = {**_kind_table(data, kind), agent_id: mode}
        _save(data_dir, data)


def forget(data_dir, kind, agent_id):
    """An agent was deleted: drop its mode (a new agent with the same name starts at the default)."""
    agent_id = str(agent_id or "").strip()
    if kind not in KINDS or not agent_id:
        return False
    with _LOCK:
        data = _load(data_dir, for_write=True)
        table = _kind_table(data, kind)
        runs = _kind_table(data.get(RUN_KEY) if isinstance(data.get(RUN_KEY), dict) else {}, kind)
        if agent_id not in table and agent_id not in runs:
            return False
        table.pop(agent_id, None)
        runs.pop(agent_id, None)
        data[kind] = table
        data[RUN_KEY] = {**(data.get(RUN_KEY) if isinstance(data.get(RUN_KEY), dict) else {}), kind: runs}
        _save(data_dir, data)
    return True


# Model and thinking level (v0.13.1): picked per agent in the chat window, like the native apps' pickers, kept in the
# same file (so they too stay through updates) and used from the agent's next run. "" = the agent's own model / the
# model's own thinking level. Changing the model in the agent's settings (Agent Studio) clears the picked one.
def run_settings(data_dir, kind, agent_id):
    runs = _load(data_dir).get(RUN_KEY)
    row = _kind_table(runs if isinstance(runs, dict) else {}, kind).get(str(agent_id))
    row = row if isinstance(row, dict) else {}
    model = row.get("model") if isinstance(row.get("model"), str) else ""
    effort = row.get("effort") if isinstance(row.get("effort"), str) else ""
    return {"model": model if _MODEL_RE.match(model or "") else "", "effort": effort if _EFFORT_RE.match(effort or "") else ""}


def set_run_settings(data_dir, kind, agent_id, **changes):
    """changes: model= / effort= (None or "" clears). Raises ValueError for a malformed value."""
    if kind not in KINDS:
        raise ValueError("unknown agent kind")
    agent_id = str(agent_id or "").strip()
    if not agent_id or len(agent_id) > 200:
        raise ValueError("agent is required")
    clean = {}
    for key, pattern in (("model", _MODEL_RE), ("effort", _EFFORT_RE)):
        if key not in changes:
            continue
        value = str(changes.get(key) or "").strip()
        if value and not pattern.match(value):
            raise ValueError(f"that {key} is not valid")
        clean[key] = value
    with _LOCK:
        data = _load(data_dir, for_write=True)
        runs = data.get(RUN_KEY) if isinstance(data.get(RUN_KEY), dict) else {}
        table = _kind_table(runs, kind)
        row = table.get(agent_id) if isinstance(table.get(agent_id), dict) else {}
        row = {k: v for k, v in {**row, **clean}.items() if k in ("model", "effort") and v}
        if row:
            table[agent_id] = row
        else:
            table.pop(agent_id, None)
        data[RUN_KEY] = {**runs, kind: table}
        _save(data_dir, data)
    return run_settings(data_dir, kind, agent_id)


def codex_run_settings(mode, sandbox_works):
    """(sandbox, approvalPolicy) for a Codex run in ``mode``."""
    if mode == "read-only" and sandbox_works:
        return "read-only", "on-request"
    if mode == "full":
        return "danger-full-access", "never"
    # Ask first: Codex's sandbox when it works here, else none; asks before anything not known to be safe
    return ("workspace-write" if sandbox_works else "danger-full-access"), "untrusted"


def claude_permission_mode(mode):
    return CLAUDE_PERMISSION_MODE.get(mode, "acceptEdits")
