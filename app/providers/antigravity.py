"""Antigravity (agy) provider adapter for My Virtual Office.

Antigravity is a Gemini-powered autonomous coding agent optimized for
structured reviews, audits, and quick implementations.  It operates in
one-shot mode (``agy --print``) with no persistent sessions — each call
is stateless.

For Docker deployments, install Antigravity inside the container image or
set ``VO_ANTIGRAVITY_BIN`` to an ``agy`` executable path available inside
the container.  Set ``VO_ANTIGRAVITY_HOME`` to a deployment-specific data
directory so auth and config stay out of the repo.

Useful variables: ``VO_ANTIGRAVITY_BIN``, ``VO_ANTIGRAVITY_HOME``,
``VO_ANTIGRAVITY_WORKSPACE_ROOT``, ``VO_ANTIGRAVITY_TIMEOUT_SEC``,
``VO_ANTIGRAVITY_PRINT_TIMEOUT``.
"""

from __future__ import annotations

import json
import os
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
class AntigravityProvider:
    """Provider adapter for local Antigravity (agy) CLI."""

    home_path: str | None = None
    binary: str | None = None
    workspace_root: str | None = None
    enabled: bool = True
    timeout_sec: int = 600
    print_timeout: str = "5m"

    provider_kind: str = "antigravity"
    provider_type: str = "harness"

    def __post_init__(self) -> None:
        status_dir = os.environ.get("VO_STATUS_DIR", "/data")
        self.home_path = os.path.expanduser(
            self.home_path
            or os.environ.get("VO_ANTIGRAVITY_HOME")
            or os.environ.get("ANTIGRAVITY_HOME")
            or "~/.gemini/antigravity-cli"
        )
        self.binary = self._resolve_binary(self.binary)
        self.workspace_root = os.path.expanduser(
            self.workspace_root
            or os.environ.get("VO_ANTIGRAVITY_WORKSPACE_ROOT")
            or os.path.join(status_dir, "antigravity-workspace")
        )
        self.print_timeout = str(
            os.environ.get("VO_ANTIGRAVITY_PRINT_TIMEOUT")
            or self.print_timeout
            or "5m"
        )

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
                "error": "Antigravity CLI not found. Set VO_ANTIGRAVITY_BIN or install agy on PATH.",
                "agents": [],
            }
        if not os.access(self.binary, os.X_OK):
            return {
                "ok": False,
                "installed": True,
                "error": f"Antigravity CLI is not executable at {self.binary}",
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
                "error": "" if ok else f"Antigravity version check failed: {version}",
                "agents": self.discover_agents() if ok else [],
            }
        except Exception as exc:
            return {"ok": False, "installed": True, "error": str(exc), "agents": []}

    # ------------------------------------------------------------------
    # Agent discovery
    # ------------------------------------------------------------------

    def discover_agents(self) -> list[dict[str, Any]]:
        """Antigravity exposes a single 'agy' agent (stateless one-shot tool)."""
        if not self.is_available():
            return []

        last_active = self._last_active(self.home_path or "")
        return [
            {
                "id": "antigravity-main",
                "statusKey": "antigravity-main",
                "providerKind": self.provider_kind,
                "providerType": self.provider_type,
                "providerAgentId": "main",
                "profile": "main",
                "name": "Antigravity",
                "emoji": "🔬",
                "role": "Gemini-powered code analyst",
                "model": "gemini",
                "workspace": self.workspace_root or "",
                "home": self.home_path or "",
                "binary": self.binary or "",
                "lastActiveAt": last_active,
                "capabilities": ["chat"],
                "connectionModes": ["cli"],
                "cliAvailable": True,
                "apiAvailable": False,
                "source": "antigravity-cli",
            }
        ]

    # ------------------------------------------------------------------
    # Chat (one-shot)
    # ------------------------------------------------------------------

    def send_chat_message(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        """Send a one-shot prompt to Antigravity via ``agy --print``.

        Antigravity has no session persistence — each call is stateless.
        The ``session_id`` parameter is accepted for API compatibility but
        ignored.
        """
        if not self.is_available():
            return {
                "ok": False,
                "error": f"Antigravity CLI is not available at {self.binary}",
                "reply": "",
                "sessionId": "",
            }
        if not message.strip():
            return {
                "ok": False,
                "error": "message is required",
                "reply": "",
                "sessionId": "",
            }

        workspace = self.workspace_root or os.getcwd()
        os.makedirs(workspace, exist_ok=True)

        cmd = [
            self.binary,
            "--print-timeout",
            self.print_timeout,
            "--print",
            message,
        ]

        effective_timeout = int(timeout_sec or self.timeout_sec or 600)
        deadline = time.time() + effective_timeout
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
                _ACTIVE_RUNS["main"] = proc

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
                    "error": "Antigravity stdout pipe was not available",
                    "reply": "",
                    "sessionId": "",
                }

            for raw in proc.stdout:
                if time.time() > deadline:
                    proc.kill()
                    return {
                        "ok": False,
                        "error": "Antigravity call timed out",
                        "reply": "\n".join(reply_lines),
                        "sessionId": "",
                    }
                line = raw.rstrip("\n")
                if line:
                    reply_lines.append(line)
                    if on_progress:
                        on_progress(
                            {
                                "reply": "\n".join(reply_lines),
                                "status": "streaming",
                                "profile": "main",
                            }
                        )

            exit_code = proc.wait(timeout=5)
            reply = "\n".join(reply_lines)
            return {
                "ok": exit_code == 0,
                "reply": reply,
                "stderr": "\n".join(stderr_lines)[-4000:],
                "exitCode": exit_code,
                "sessionId": "",
                "providerPath": "antigravity-cli",
            }
        except subprocess.TimeoutExpired:
            if proc:
                proc.kill()
            return {
                "ok": False,
                "error": "Antigravity call timed out",
                "reply": "\n".join(reply_lines),
                "sessionId": "",
            }
        except Exception as exc:
            return {
                "ok": False,
                "error": str(exc),
                "reply": "\n".join(reply_lines),
                "sessionId": "",
            }
        finally:
            with _ACTIVE_RUNS_LOCK:
                if _ACTIVE_RUNS.get("main") is proc:
                    _ACTIVE_RUNS.pop("main", None)

    def interrupt(self, profile: str) -> dict[str, Any]:
        with _ACTIVE_RUNS_LOCK:
            proc = _ACTIVE_RUNS.get("main")
        if proc and proc.poll() is None:
            proc.kill()
            return {"ok": True, "message": "Killed Antigravity process"}
        return {"ok": False, "error": "No active Antigravity run"}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _subprocess_env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.home_path:
            env["ANTIGRAVITY_HOME"] = self.home_path
        return env

    @staticmethod
    def _resolve_binary(value: str | None) -> str:
        return os.path.expanduser(
            value
            or os.environ.get("VO_ANTIGRAVITY_BIN")
            or shutil.which("agy")
            or ""
        )

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
