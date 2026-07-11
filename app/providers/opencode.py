"""OpenCode provider adapter for My Virtual Office.

OpenCode is a multi-provider coding agent with TUI, serve, and one-shot modes.
This adapter discovers OpenCode agents, manages sessions, and sends chat messages
through the ``opencode run`` CLI surface.

For Docker deployments, install OpenCode inside the container image or set
``VO_OPENCODE_BIN`` to an OpenCode executable path available inside the container.
Set ``VO_OPENCODE_HOME`` to a deployment-specific config directory so auth and
config stay out of the repo.  Mount or otherwise expose the OpenCode config
directory only when you want session history or profile management.

Useful variables: ``VO_OPENCODE_BIN``, ``VO_OPENCODE_HOME``,
``VO_OPENCODE_WORKSPACE_ROOT``, ``VO_OPENCODE_MAIN_WORKSPACE``,
``VO_OPENCODE_MODEL``, ``VO_OPENCODE_INCLUDE_MAIN``,
``VO_OPENCODE_INCLUDE_AGENTS``, ``VO_OPENCODE_TIMEOUT_SEC``.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable


ProgressCallback = Callable[[dict[str, Any]], None]

_ACTIVE_RUNS: dict[str, subprocess.Popen] = {}
_ACTIVE_RUNS_LOCK = threading.Lock()


@dataclass
class OpenCodeProvider:
    """Provider adapter for local OpenCode-backed Office agents."""

    home_path: str | None = None
    binary: str | None = None
    workspace_root: str | None = None
    enabled: bool = True
    timeout_sec: int = 900
    model: str = ""
    main_workspace: str | None = None
    include_main: bool = True
    include_agents: bool = True

    provider_kind: str = "opencode"
    provider_type: str = "harness"

    def __post_init__(self) -> None:
        status_dir = os.environ.get("VO_STATUS_DIR", "/data")
        self.home_path = os.path.expanduser(
            self.home_path
            or os.environ.get("VO_OPENCODE_HOME")
            or os.environ.get("OPENCODE_HOME")
            or "~/.config/opencode"
        )
        self.binary = self._resolve_binary(self.binary)
        self.workspace_root = os.path.expanduser(
            self.workspace_root
            or os.environ.get("VO_OPENCODE_WORKSPACE_ROOT")
            or os.path.join(status_dir, "opencode-agents")
        )
        self.main_workspace = os.path.expanduser(
            self.main_workspace
            or os.environ.get("VO_OPENCODE_MAIN_WORKSPACE")
            or os.path.join(status_dir, "opencode-main")
        )
        self.model = str(self.model or os.environ.get("VO_OPENCODE_MODEL") or "")
        self.include_main = str(
            os.environ.get("VO_OPENCODE_INCLUDE_MAIN", str(self.include_main))
        ).lower() not in ("0", "false", "no", "off")
        self.include_agents = str(
            os.environ.get("VO_OPENCODE_INCLUDE_AGENTS", str(self.include_agents))
        ).lower() not in ("0", "false", "no", "off")

    # ------------------------------------------------------------------
    # Availability / health
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        return bool(
            self.enabled
            and self.binary
            and os.path.isfile(self.binary)
            and os.access(self.binary, os.X_OK)
        )

    def test(self) -> dict[str, Any]:
        if not self.binary or not os.path.isfile(self.binary):
            return {
                "ok": False,
                "installed": False,
                "error": "OpenCode CLI not found. Set VO_OPENCODE_BIN or install opencode on PATH.",
                "agents": [],
            }
        if not os.access(self.binary, os.X_OK):
            return {
                "ok": False,
                "installed": True,
                "error": f"OpenCode CLI is not executable at {self.binary}",
                "agents": [],
            }
        try:
            result = subprocess.run(
                [self.binary, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
                env=self._subprocess_env(),
            )
            version = (result.stdout or result.stderr or "").strip()
            ok = result.returncode == 0
            return {
                "ok": ok,
                "installed": True,
                "version": version,
                "binary": self.binary,
                "homePath": self.home_path,
                "workspaceRoot": self.workspace_root,
                "mainWorkspace": self._main_workspace(),
                "error": "" if ok else f"OpenCode version check failed: {version}",
                "agents": self.discover_agents() if ok else [],
            }
        except Exception as exc:
            return {"ok": False, "installed": True, "error": str(exc), "agents": []}

    # ------------------------------------------------------------------
    # Agent discovery
    # ------------------------------------------------------------------

    def discover_agents(self) -> list[dict[str, Any]]:
        if not self.is_available():
            return []

        agents: list[dict[str, Any]] = []
        seen: set[str] = set()

        # Main agent (always present)
        if self.include_main:
            agents.append(
                self._agent_entry(
                    profile="main",
                    name="Main",
                    emoji="⚡",
                    role="Default OpenCode agent",
                    model=self.model or "",
                    workspace=self._main_workspace(),
                    source="opencode-main",
                    last_active=self._last_active(self._main_workspace()),
                )
            )
            seen.add("main")

        # Discover saved agents from OpenCode config
        if self.include_agents:
            agents.extend(self._discover_config_agents(seen))

        return agents

    def _discover_config_agents(self, seen: set[str]) -> list[dict[str, Any]]:
        """Discover agents from OpenCode's agent config directory."""
        agents: list[dict[str, Any]] = []
        agents_dir = os.path.join(self.home_path, "agents")
        if not os.path.isdir(agents_dir):
            return agents

        for name in sorted(os.listdir(agents_dir)):
            if name in seen:
                continue
            agent_path = os.path.join(agents_dir, name)
            if not os.path.isdir(agent_path):
                continue
            # Try to read agent metadata
            meta = self._load_agent_meta(agent_path)
            profile = self._safe_profile_name(meta.get("profile") or name)
            if not profile or profile in seen:
                continue
            seen.add(profile)
            agents.append(
                self._agent_entry(
                    profile=profile,
                    name=meta.get("name") or self._display_name(profile),
                    emoji=meta.get("emoji") or "⚡",
                    role=meta.get("role") or "OpenCode Agent",
                    model=meta.get("model") or self.model or "",
                    workspace=agent_path,
                    source="opencode-config",
                    last_active=self._last_active(agent_path),
                )
            )
        return agents

    # ------------------------------------------------------------------
    # Chat
    # ------------------------------------------------------------------

    def send_chat_message(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        if not self.is_available():
            return {
                "ok": False,
                "error": f"OpenCode CLI is not available at {self.binary}",
                "reply": "",
                "sessionId": session_id or "",
            }
        if not message.strip():
            return {
                "ok": False,
                "error": "message is required",
                "reply": "",
                "sessionId": session_id or "",
            }

        safe_profile = self._safe_profile_name(profile or "main")
        workspace = self._workspace_for_profile(safe_profile)
        os.makedirs(workspace, exist_ok=True)

        cmd = [self.binary, "run"]
        if session_id:
            cmd.extend(["--session", session_id])
        elif safe_profile and safe_profile != "main":
            # Use --continue to resume last session for this profile
            cmd.append("--continue")
        if self.model:
            cmd.extend(["-m", self.model])
        cmd.append(message)

        deadline = time.time() + int(timeout_sec or self.timeout_sec or 900)
        reply_lines: list[str] = []
        stderr_lines: list[str] = []
        proc: subprocess.Popen | None = None
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=workspace,
                env=self._subprocess_env(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            with _ACTIVE_RUNS_LOCK:
                _ACTIVE_RUNS[safe_profile] = proc

            def read_stderr() -> None:
                if not proc or not proc.stderr:
                    return
                try:
                    for raw in proc.stderr:
                        if raw:
                            stderr_lines.append(raw.rstrip("\n"))
                except Exception:
                    pass

            threading.Thread(target=read_stderr, daemon=True).start()

            if not proc.stdout:
                return {
                    "ok": False,
                    "error": "OpenCode stdout pipe was not available",
                    "reply": "",
                    "sessionId": session_id or "",
                }

            for raw in proc.stdout:
                if time.time() > deadline:
                    proc.kill()
                    return {
                        "ok": False,
                        "error": "OpenCode call timed out",
                        "reply": "\n".join(reply_lines),
                        "sessionId": session_id or "",
                    }
                line = raw.rstrip("\n")
                if line:
                    reply_lines.append(line)
                    if on_progress:
                        on_progress(
                            {
                                "reply": "\n".join(reply_lines),
                                "status": "streaming",
                                "profile": safe_profile,
                            }
                        )

            exit_code = proc.wait(timeout=5)
            reply = "\n".join(reply_lines)
            error_msg = ""
            if exit_code != 0:
                error_msg = "\n".join(stderr_lines)[-1000:] or f"CLI process exited with code {exit_code}"
            return {
                "ok": exit_code == 0,
                "reply": reply,
                "error": error_msg,
                "stderr": "\n".join(stderr_lines)[-4000:],
                "exitCode": exit_code,
                "sessionId": session_id or "",
                "providerPath": "opencode-cli",
                "model": self.model,
            }
        except subprocess.TimeoutExpired:
            if proc:
                proc.kill()
            return {
                "ok": False,
                "error": "OpenCode call timed out",
                "reply": "\n".join(reply_lines),
                "sessionId": session_id or "",
            }
        except Exception as exc:
            return {
                "ok": False,
                "error": str(exc),
                "reply": "\n".join(reply_lines),
                "sessionId": session_id or "",
            }
        finally:
            with _ACTIVE_RUNS_LOCK:
                if _ACTIVE_RUNS.get(safe_profile) is proc:
                    _ACTIVE_RUNS.pop(safe_profile, None)

    def interrupt(self, profile: str) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile or "main")
        with _ACTIVE_RUNS_LOCK:
            proc = _ACTIVE_RUNS.get(safe_profile)
        if proc and proc.poll() is None:
            proc.kill()
            return {"ok": True, "message": f"Killed OpenCode process for {safe_profile}"}
        return {"ok": False, "error": f"No active OpenCode run for {safe_profile}"}

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def list_sessions(self, profile: str, limit: int = 40) -> dict[str, Any]:
        """List recent OpenCode sessions via CLI."""
        if not self.is_available():
            return {"ok": False, "error": "OpenCode CLI not available", "sessions": []}
        try:
            result = subprocess.run(
                [self.binary or '', "session", "list"],
                capture_output=True,
                text=True,
                timeout=15,
                env=self._subprocess_env(),
            )
            if result.returncode != 0:
                return {
                    "ok": False,
                    "error": (result.stderr or result.stdout or "").strip()[:500],
                    "sessions": [],
                }
            # Parse session list output (text format)
            sessions = []
            for line in (result.stdout or "").strip().split("\n"):
                line = line.strip()
                if not line or line.startswith("ID") or line.startswith("-"):
                    continue
                parts = line.split(None, 1)
                if parts:
                    sessions.append({"id": parts[0], "title": parts[1] if len(parts) > 1 else ""})
            return {"ok": True, "sessions": sessions[:limit]}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "sessions": []}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _subprocess_env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.home_path:
            env["OPENCODE_HOME"] = self.home_path
        return env

    def _agent_entry(
        self,
        profile: str,
        name: str,
        emoji: str,
        role: str,
        model: str,
        workspace: str,
        source: str,
        last_active: int,
    ) -> dict[str, Any]:
        return {
            "id": f"opencode-{profile}",
            "statusKey": f"opencode-{profile}",
            "providerKind": self.provider_kind,
            "providerType": self.provider_type,
            "providerAgentId": profile,
            "profile": profile,
            "name": name,
            "emoji": emoji,
            "role": role,
            "model": model,
            "workspace": workspace,
            "home": self.home_path or "",
            "binary": self.binary or "",
            "lastActiveAt": last_active,
            "capabilities": ["chat", "status", "sessions"],
            "connectionModes": ["cli"],
            "cliAvailable": True,
            "apiAvailable": False,
            "desktopAvailable": False,
            "source": source,
        }

    def _workspace_for_profile(self, profile: str) -> str:
        if profile == "main":
            return self._main_workspace()
        return os.path.join(self.workspace_root or '', profile)

    def _main_workspace(self) -> str:
        return self.main_workspace or os.path.join(
            os.environ.get("VO_STATUS_DIR", "/data"), "opencode-main"
        )

    def _load_agent_meta(self, agent_dir: str) -> dict[str, Any]:
        meta_path = os.path.join(agent_dir, "opencode-agent.json")
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        # Fallback: try reading AGENTS.md for name/role
        agents_md = os.path.join(agent_dir, "AGENTS.md")
        try:
            with open(agents_md, "r", encoding="utf-8") as f:
                content = f.read(2000)
            name_match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
            return {"name": name_match.group(1) if name_match else ""}
        except (FileNotFoundError, OSError):
            return {}

    @staticmethod
    def _resolve_binary(value: str | None) -> str:
        expanded = os.path.expanduser(
            value
            or os.environ.get("VO_OPENCODE_BIN")
            or shutil.which("opencode")
            or ""
        )
        return expanded

    @staticmethod
    def _safe_profile_name(value: str | None) -> str:
        if not value:
            return "main"
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip())[:80]
        return safe or "main"

    @staticmethod
    def _display_name(profile: str) -> str:
        return profile.replace("-", " ").replace("_", " ").title()

    @staticmethod
    def _last_active(path: str) -> int:
        if not path or not os.path.isdir(path):
            return 0
        newest = 0
        for entry in os.scandir(path):
            try:
                mtime = entry.stat().st_mtime
                if mtime > newest:
                    newest = mtime
            except OSError:
                continue
        return int(newest)
