"""Antigravity (agy) provider adapter for My Virtual Office.

Antigravity runs through the ``agy --print`` CLI surface. The integration is
intentionally one-shot: Virtual Office stores local chat history, but the
provider does not claim native session list/read/delete support.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

try:
    from .process_env import resolve_executable, sanitized_env
except ImportError:
    from process_env import resolve_executable, sanitized_env


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
    model: str = ""
    sandbox: str = ""

    provider_kind: str = "antigravity"
    provider_type: str = "harness"

    def __post_init__(self) -> None:
        status_dir = os.environ.get("VO_STATUS_DIR", "/data")
        self.home_path = os.path.expanduser(
            self.home_path
            or os.environ.get("VO_ANTIGRAVITY_HOME")
            or "~/.gemini/antigravity-cli"
        )
        self.binary = self._resolve_binary(self.binary)
        self.workspace_root = os.path.expanduser(
            self.workspace_root
            or os.environ.get("VO_ANTIGRAVITY_WORKSPACE_ROOT")
            or os.path.join(status_dir, "antigravity-workspace")
        )
        self.print_timeout = str(os.environ.get("VO_ANTIGRAVITY_PRINT_TIMEOUT") or self.print_timeout or "5m")
        self.model = str(self.model or os.environ.get("VO_ANTIGRAVITY_MODEL") or "")
        self.sandbox = str(self.sandbox or os.environ.get("VO_ANTIGRAVITY_SANDBOX") or "")

    def is_available(self) -> bool:
        return bool(
            self.enabled
            and self.binary
            and os.path.isfile(self.binary)
            and os.access(self.binary, os.X_OK)
        )

    def test(self) -> dict[str, Any]:
        if not self.enabled:
            return {"ok": False, "enabled": False, "installed": bool(self.binary), "error": "Antigravity provider is disabled.", "agents": []}
        if not self.binary or not os.path.isfile(self.binary):
            return {"ok": False, "enabled": True, "installed": False, "error": "Antigravity CLI not found. Set VO_ANTIGRAVITY_BIN or install agy on PATH.", "agents": []}
        if not os.access(self.binary, os.X_OK):
            return {"ok": False, "enabled": True, "installed": True, "error": f"Antigravity CLI is not executable at {self.binary}", "agents": []}
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
                "enabled": True,
                "installed": True,
                "version": version,
                "binary": self.binary,
                "workspaceRoot": self.workspace_root,
                "model": self.model,
                "sandbox": self.sandbox,
                "error": "" if ok else f"Antigravity version check failed: {version}",
                "agents": self.discover_agents() if ok else [],
            }
        except Exception as exc:
            return {"ok": False, "enabled": True, "installed": True, "error": str(exc), "agents": []}

    def discover_agents(self) -> list[dict[str, Any]]:
        if not self.is_available():
            return []

        last_active = self._last_active(self.workspace_root or "")
        model = self.model or "gemini"
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
                "role": "Gemini-powered one-shot code analyst",
                "model": model,
                "provider": "Antigravity",
                "workspace": self.workspace_root or "",
                "home": self.workspace_root or "",
                "binary": self.binary or "",
                "lastActiveAt": last_active,
                "capabilities": ["chat", "interrupt"],
                "connectionModes": ["cli"],
                "cliAvailable": True,
                "apiAvailable": False,
                "desktopAvailable": False,
                "source": "antigravity-cli",
            }
        ]

    def send_chat_message(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": f"Antigravity CLI is not available at {self.binary}", "reply": "", "sessionId": ""}
        if not message.strip():
            return {"ok": False, "error": "message is required", "reply": "", "sessionId": ""}

        workspace = self.workspace_root or os.getcwd()
        os.makedirs(workspace, exist_ok=True)

        cmd = [self.binary or "agy"]
        if self.model:
            cmd.extend(["--model", self.model])
        if self.sandbox:
            cmd.extend(["--sandbox", self.sandbox])
        if self.print_timeout:
            cmd.extend(["--print-timeout", self.print_timeout])
        cmd.extend(["--print", message])

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
                return {"ok": False, "error": "Antigravity stdout pipe was not available", "reply": "", "sessionId": ""}

            for raw in proc.stdout:
                if time.time() > deadline:
                    proc.kill()
                    return {"ok": False, "error": "Antigravity call timed out", "reply": "\n".join(reply_lines), "sessionId": ""}
                line = raw.rstrip("\n")
                if line:
                    reply_lines.append(line)
                    if on_progress:
                        on_progress({"reply": "\n".join(reply_lines), "status": "streaming", "profile": "main"})

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
                "sessionId": "",
                "providerPath": "antigravity-cli",
                "model": self.model or "gemini",
            }
        except subprocess.TimeoutExpired:
            if proc:
                proc.kill()
            return {"ok": False, "error": "Antigravity call timed out", "reply": "\n".join(reply_lines), "sessionId": ""}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "reply": "\n".join(reply_lines), "sessionId": ""}
        finally:
            with _ACTIVE_RUNS_LOCK:
                if _ACTIVE_RUNS.get("main") is proc:
                    _ACTIVE_RUNS.pop("main", None)

    def interrupt(self, profile: str) -> dict[str, Any]:
        with _ACTIVE_RUNS_LOCK:
            proc = _ACTIVE_RUNS.get("main")
        if proc and proc.poll() is None:
            proc.terminate()
            return {"ok": True, "interrupted": True, "profile": "main"}
        return {"ok": False, "error": "No active Antigravity run"}

    def _subprocess_env(self) -> dict[str, str]:
        return sanitized_env("VO_ANTIGRAVITY_ENV_ALLOWLIST")

    @staticmethod
    def _resolve_binary(value: str | None) -> str:
        return resolve_executable(value, "VO_ANTIGRAVITY_BIN", "agy")

    @staticmethod
    def _last_active(path: str) -> int:
        latest = 0
        try:
            if os.path.isfile(path):
                return int(os.path.getmtime(path))
            for root, dirs, files in os.walk(path):
                dirs[:] = [d for d in dirs if d not in {"node_modules", ".git"}]
                for fname in files:
                    latest = max(latest, int(os.path.getmtime(os.path.join(root, fname))))
        except OSError:
            pass
        return latest
