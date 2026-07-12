"""OpenCode provider adapter for My Virtual Office.

OpenCode is a multi-provider coding agent with TUI, serve, and one-shot modes.
This adapter discovers OpenCode markdown agents, creates managed workspaces,
and sends chat messages through the documented ``opencode run`` CLI surface.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import hashlib
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
    register_agents: bool = True

    provider_kind: str = "opencode"
    provider_type: str = "harness"

    def __post_init__(self) -> None:
        status_dir = os.environ.get("VO_STATUS_DIR", "/data")
        self.home_path = os.path.expanduser(
            self.home_path
            or os.environ.get("VO_OPENCODE_CONFIG_DIR")
            or os.environ.get("OPENCODE_CONFIG_DIR")
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
        self.include_main = str(os.environ.get("VO_OPENCODE_INCLUDE_MAIN", str(self.include_main))).lower() not in ("0", "false", "no", "off")
        self.include_agents = str(os.environ.get("VO_OPENCODE_INCLUDE_AGENTS", str(self.include_agents))).lower() not in ("0", "false", "no", "off")
        self.register_agents = str(os.environ.get("VO_OPENCODE_REGISTER_AGENTS", str(self.register_agents))).lower() not in ("0", "false", "no", "off")

    def is_available(self) -> bool:
        return bool(
            self.enabled
            and self.binary
            and os.path.isfile(self.binary)
            and os.access(self.binary, os.X_OK)
        )

    def test(self) -> dict[str, Any]:
        if not self.enabled:
            return {"ok": False, "enabled": False, "installed": bool(self.binary), "error": "OpenCode provider is disabled.", "agents": []}
        if not self.binary or not os.path.isfile(self.binary):
            return {"ok": False, "enabled": True, "installed": False, "error": "OpenCode CLI not found. Set VO_OPENCODE_BIN or install opencode on PATH.", "agents": []}
        if not os.access(self.binary, os.X_OK):
            return {"ok": False, "enabled": True, "installed": True, "error": f"OpenCode CLI is not executable at {self.binary}", "agents": []}
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
                "homePath": self.home_path,
                "configDir": self.home_path,
                "workspaceRoot": self.workspace_root,
                "mainWorkspace": self._main_workspace(),
                "error": "" if ok else f"OpenCode version check failed: {version}",
                "agents": self.discover_agents() if ok else [],
            }
        except Exception as exc:
            return {"ok": False, "enabled": True, "installed": True, "error": str(exc), "agents": []}

    def discover_agents(self) -> list[dict[str, Any]]:
        if not self.is_available():
            return []

        agents: list[dict[str, Any]] = []
        seen_profiles: set[str] = set()
        if self.include_main:
            agents.append(self._agent_entry(
                profile="main",
                name="Main",
                emoji="⚡",
                role="Default OpenCode agent",
                model=self.model or "",
                workspace=self._main_workspace(),
                source="native-main",
                last_active=self._last_active(self._main_workspace()),
            ))
            seen_profiles.add("main")

        if self.include_agents:
            agents.extend(self._discover_office_agents(seen_profiles))
            agents.extend(self._discover_native_agents(seen_profiles))
        return agents

    def create_agent(
        self,
        name: str,
        role: str = "OpenCode Agent",
        model: str | None = None,
        emoji: str = "⚡",
        profile: str | None = None,
        prompt: str | None = None,
        creation_mode: str = "standard",
        custom_directory: str | None = None,
    ) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": "OpenCode CLI is not available. Set VO_OPENCODE_BIN or install opencode on PATH."}

        safe_profile = self._safe_profile_name(profile or name)
        if safe_profile == "main":
            return {"ok": False, "error": "OpenCode Main already exists"}
        if self._profile_exists(safe_profile):
            return {"ok": False, "error": f"OpenCode agent '{safe_profile}' already exists"}

        mode = str(creation_mode or "standard").strip().lower()
        if mode not in {"standard", "custom"}:
            mode = "standard"
        if mode == "custom":
            parent_dir = self._resolve_custom_parent(custom_directory)
            if not parent_dir:
                return {"ok": False, "error": "A custom parent directory is required for custom OpenCode agent creation"}
            native_agents_dir = self._native_agents_dir()
            if native_agents_dir and self._path_is_inside(parent_dir, native_agents_dir):
                return {"ok": False, "error": "Custom workspace directory cannot be inside the OpenCode agents directory. Use the standard option instead."}
            agent_dir = os.path.join(parent_dir, safe_profile)
        else:
            agent_dir = os.path.join(self.workspace_root or "", safe_profile)

        native_agent_path = self._native_agent_file_path(safe_profile) if mode == "standard" else ""
        should_register_native = mode == "standard" and self.register_agents and native_agent_path
        if should_register_native and os.path.exists(native_agent_path):
            return {"ok": False, "error": f"Native OpenCode agent '{safe_profile}' already exists in {native_agent_path}"}

        instructions = (prompt or role or "OpenCode Agent").strip()
        model_value = (model or self.model or "").strip()
        project_agent_path = os.path.join(agent_dir, ".opencode", "agents", f"{safe_profile}.md")
        os.makedirs(os.path.dirname(project_agent_path), exist_ok=True)
        meta = {
            "profile": safe_profile,
            "name": name,
            "emoji": emoji or "⚡",
            "role": role or "OpenCode Agent",
            "prompt": instructions,
            "model": model_value,
            "providerKind": self.provider_kind,
            "providerType": self.provider_type,
            "creationMode": mode,
            "customParentDirectory": os.path.dirname(agent_dir) if mode == "custom" else "",
            "nativeAgentPath": native_agent_path if should_register_native else "",
            "projectAgentPath": project_agent_path,
            "createdAt": int(time.time()),
        }
        self._write_json(os.path.join(agent_dir, "opencode-agent.json"), meta)
        self._write_text(os.path.join(agent_dir, "IDENTITY.md"), self._identity_md(name, role, emoji))
        self._write_text(os.path.join(agent_dir, "AGENTS.md"), self._agents_md(name, role, instructions))
        self._write_text(project_agent_path, self._agent_md(safe_profile, role, instructions, model_value))
        if should_register_native:
            self._write_text(native_agent_path, self._agent_md(safe_profile, role, instructions, model_value))
        if mode == "custom":
            self._save_external_agent(safe_profile, agent_dir)

        return {
            "ok": True,
            "profile": safe_profile,
            "agentId": f"opencode-{safe_profile}",
            "name": name,
            "workspace": agent_dir,
            "creationMode": mode,
            "nativeAgentPath": native_agent_path if should_register_native else "",
            "message": f"OpenCode agent '{name}' created successfully",
        }

    def delete_agent(self, profile: str) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        if not safe_profile:
            return {"ok": False, "error": "profile is required"}
        if safe_profile == "main":
            return {"ok": False, "error": "The built-in OpenCode Main agent cannot be deleted"}

        agent_dir = os.path.join(self.workspace_root or "", safe_profile)
        meta = self._load_meta(agent_dir)
        deleted = False
        if self._is_managed_agent_dir(agent_dir, safe_profile):
            shutil.rmtree(agent_dir)
            self._remove_external_agent(safe_profile)
            deleted = True
        else:
            external_dir = self._external_agent_dir(safe_profile)
            if external_dir and self._is_managed_agent_dir(external_dir, safe_profile):
                meta = self._load_meta(external_dir)
                shutil.rmtree(external_dir)
                self._remove_external_agent(safe_profile)
                deleted = True

        native_path = str(meta.get("nativeAgentPath") or self._native_agent_file_path(safe_profile) or "")
        if native_path and os.path.isfile(native_path) and self._is_native_agent_path(native_path):
            try:
                os.remove(native_path)
                deleted = True
            except OSError:
                pass
        return {"ok": True, "deleted": deleted, "profile": safe_profile, "agentId": f"opencode-{safe_profile}"}

    def send_chat_message(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
        on_progress: ProgressCallback | None = None,
        files: list[str] | None = None,
        auto_approve: bool = False,
    ) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": f"OpenCode CLI is not available at {self.binary}", "reply": "", "sessionId": session_id or ""}
        if not message.strip():
            return {"ok": False, "error": "message is required", "reply": "", "sessionId": session_id or ""}

        safe_profile = self._safe_profile_name(profile or "main")
        workspace = self._workspace_for_profile(safe_profile)
        os.makedirs(workspace, exist_ok=True)

        cmd = [self.binary or "opencode", "run", "--format", "json"]
        if safe_profile and safe_profile != "main":
            cmd.extend(["--agent", safe_profile])
        if session_id:
            cmd.extend(["--session", session_id])
        elif safe_profile and safe_profile != "main":
            cmd.append("--continue")
        if self.model:
            cmd.extend(["--model", self.model])
        if auto_approve:
            cmd.append("--auto")
        for file_path in files or []:
            clean_path = os.path.abspath(os.path.expanduser(str(file_path or "").strip()))
            if clean_path and os.path.isfile(clean_path):
                cmd.extend(["--file", clean_path])
        cmd.append(message)

        deadline = time.time() + int(timeout_sec or self.timeout_sec or 900)
        reply_lines: list[str] = []
        stderr_lines: list[str] = []
        raw_events: list[dict[str, Any]] = []
        tools_by_id: dict[str, dict[str, Any]] = {}
        approval: dict[str, Any] | None = None
        observed_json_events = False
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
                return {"ok": False, "error": "OpenCode stdout pipe was not available", "reply": "", "sessionId": session_id or ""}

            for raw in proc.stdout:
                if time.time() > deadline:
                    proc.kill()
                    return {"ok": False, "error": "OpenCode call timed out", "reply": "\n".join(reply_lines), "sessionId": session_id or ""}
                line = raw.rstrip("\n")
                if not line:
                    continue
                event = self._json_event(line)
                if event is not None:
                    observed_json_events = True
                    raw_events.append(event)
                    event_state = self._consume_run_event(event, reply_lines, tools_by_id, safe_profile, session_id or "")
                    if event_state.get("sessionId"):
                        session_id = str(event_state.get("sessionId") or "")
                    if isinstance(event_state.get("approval"), dict):
                        approval = event_state["approval"]
                    if on_progress:
                        on_progress({
                            "reply": "\n".join(reply_lines),
                            "status": event_state.get("status") or "streaming",
                            "profile": safe_profile,
                            "sessionId": session_id or "",
                            "tools": list(tools_by_id.values()),
                            "approval": approval,
                            "rawEvent": event,
                        })
                    continue

                reply_lines.append(line)
                if on_progress:
                    on_progress({
                        "reply": "\n".join(reply_lines),
                        "status": "streaming",
                        "profile": safe_profile,
                        "sessionId": session_id or "",
                        "tools": list(tools_by_id.values()),
                        "approval": approval,
                    })

            exit_code = proc.wait(timeout=5)
            reply = "\n".join(reply_lines)
            error_msg = ""
            if exit_code != 0:
                error_msg = "\n".join(stderr_lines)[-1000:] or f"CLI process exited with code {exit_code}"
                approval = approval or self._approval_from_text(error_msg, safe_profile)
            return {
                "ok": exit_code == 0,
                "reply": reply,
                "error": error_msg,
                "stderr": "\n".join(stderr_lines)[-4000:],
                "exitCode": exit_code,
                "sessionId": session_id or "",
                "providerPath": "opencode-cli",
                "model": self.model,
                "tools": list(tools_by_id.values()),
                "approval": approval,
                "rawEvents": raw_events[-200:],
                "jsonEvents": observed_json_events,
            }
        except subprocess.TimeoutExpired:
            if proc:
                proc.kill()
            return {"ok": False, "error": "OpenCode call timed out", "reply": "\n".join(reply_lines), "sessionId": session_id or ""}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "reply": "\n".join(reply_lines), "sessionId": session_id or ""}
        finally:
            with _ACTIVE_RUNS_LOCK:
                if _ACTIVE_RUNS.get(safe_profile) is proc:
                    _ACTIVE_RUNS.pop(safe_profile, None)

    def interrupt(self, profile: str) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile or "main")
        with _ACTIVE_RUNS_LOCK:
            proc = _ACTIVE_RUNS.get(safe_profile)
        if proc and proc.poll() is None:
            proc.terminate()
            return {"ok": True, "interrupted": True, "profile": safe_profile}
        return {"ok": False, "error": f"No active OpenCode run for {safe_profile}"}

    def list_sessions(self, profile: str, limit: int = 40) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": "OpenCode CLI not available", "sessions": []}
        safe_profile = self._safe_profile_name(profile or "main")
        try:
            result = subprocess.run(
                [self.binary or "opencode", "session", "list", "--format", "json", "--max-count", str(max(1, int(limit or 40)))],
                cwd=self._workspace_for_profile(safe_profile),
                capture_output=True,
                text=True,
                timeout=15,
                env=self._subprocess_env(),
            )
            if result.returncode != 0:
                return {"ok": False, "error": (result.stderr or result.stdout or "").strip()[:500], "sessions": []}
            return {"ok": True, "sessions": self._parse_session_list(result.stdout or "")[:limit]}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "sessions": []}

    def export_session(self, profile: str, session_id: str, sanitize: bool = False) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": "OpenCode CLI not available", "session": {}}
        session_id = str(session_id or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", session_id):
            return {"ok": False, "error": "Invalid OpenCode session id", "session": {}}
        safe_profile = self._safe_profile_name(profile or "main")
        cmd = [self.binary or "opencode", "export", session_id]
        if sanitize:
            cmd.append("--sanitize")
        try:
            result = subprocess.run(
                cmd,
                cwd=self._workspace_for_profile(safe_profile),
                capture_output=True,
                text=True,
                timeout=30,
                env=self._subprocess_env(),
            )
            if result.returncode != 0:
                return {"ok": False, "error": (result.stderr or result.stdout or "").strip()[:500], "session": {}}
            raw = result.stdout or ""
            parsed = json.loads(raw) if raw.strip() else {}
            if isinstance(parsed, dict):
                parsed.setdefault("id", session_id)
                return {"ok": True, "session": parsed}
            return {"ok": True, "session": {"id": session_id, "messages": parsed if isinstance(parsed, list) else []}}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "session": {}}

    def delete_session(self, profile: str, session_id: str) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": "OpenCode CLI not available"}
        session_id = str(session_id or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", session_id):
            return {"ok": False, "error": "Invalid OpenCode session id"}
        safe_profile = self._safe_profile_name(profile or "main")
        try:
            result = subprocess.run(
                [self.binary or "opencode", "session", "delete", session_id],
                cwd=self._workspace_for_profile(safe_profile),
                capture_output=True,
                text=True,
                timeout=20,
                env=self._subprocess_env(),
            )
            if result.returncode != 0:
                return {"ok": False, "error": (result.stderr or result.stdout or "").strip()[:500]}
            return {"ok": True, "deleted": True, "sessionId": session_id}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _subprocess_env(self) -> dict[str, str]:
        env = sanitized_env("VO_OPENCODE_ENV_ALLOWLIST")
        if self.home_path:
            env["OPENCODE_CONFIG_DIR"] = self.home_path
        return env

    def _discover_office_agents(self, seen_profiles: set[str]) -> list[dict[str, Any]]:
        agents: list[dict[str, Any]] = []
        for agent_dir in self._office_agent_dirs():
            meta = self._load_meta(agent_dir)
            profile = self._safe_profile_name(meta.get("profile") or os.path.basename(agent_dir))
            if not profile or profile in seen_profiles:
                continue
            seen_profiles.add(profile)
            agents.append(self._agent_entry(
                profile=profile,
                name=meta.get("name") or self._display_name(profile),
                emoji=meta.get("emoji") or "⚡",
                role=meta.get("role") or "OpenCode Agent",
                model=meta.get("model") or self.model or "",
                workspace=agent_dir,
                source=meta.get("creationMode") or "virtual-office",
                last_active=self._last_active(agent_dir),
                native_agent_path=meta.get("nativeAgentPath") or "",
            ))
        return agents

    def _discover_native_agents(self, seen_profiles: set[str]) -> list[dict[str, Any]]:
        agents_dir = self._native_agents_dir()
        if not agents_dir or not os.path.isdir(agents_dir):
            return []
        agents: list[dict[str, Any]] = []
        for filename in sorted(os.listdir(agents_dir)):
            if not filename.endswith(".md"):
                continue
            path = os.path.join(agents_dir, filename)
            meta = self._load_agent_md(path)
            profile = self._safe_profile_name(meta.get("name") or os.path.splitext(filename)[0])
            if not profile or profile in seen_profiles:
                continue
            seen_profiles.add(profile)
            agents.append(self._agent_entry(
                profile=profile,
                name=meta.get("displayName") or self._display_name(profile),
                emoji="⚡",
                role=meta.get("description") or "OpenCode Agent",
                model=meta.get("model") or self.model or "",
                workspace=self._workspace_for_profile(profile),
                source="native-user-agent",
                last_active=self._last_active(path),
                native_agent_path=path,
            ))
        return agents

    def _agent_entry(
        self,
        *,
        profile: str,
        name: str,
        emoji: str,
        role: str,
        model: str,
        workspace: str,
        source: str,
        last_active: int = 0,
        native_agent_path: str = "",
    ) -> dict[str, Any]:
        suffix = self._safe_suffix(profile)
        return {
            "id": f"opencode-{suffix}",
            "statusKey": f"opencode-{suffix}",
            "providerKind": self.provider_kind,
            "providerType": self.provider_type,
            "providerAgentId": profile,
            "profile": profile,
            "name": name or self._display_name(profile),
            "emoji": emoji or "⚡",
            "role": role or "OpenCode Agent",
            "model": model or self.model or "inherit",
            "provider": "OpenCode",
            "workspace": workspace,
            "home": workspace,
            "configDir": self.home_path or "",
            "binary": self.binary or "",
            "lastActiveAt": last_active,
            "opencodeSource": source,
            "nativeAgentPath": native_agent_path,
            "capabilities": ["chat", "status", "sessions", "interrupt"],
            "connectionModes": ["cli"],
            "cliAvailable": True,
            "apiAvailable": False,
            "desktopAvailable": False,
        }

    def _workspace_for_profile(self, profile: str) -> str:
        if profile == "main":
            return self._main_workspace()
        agent_dir = os.path.join(self.workspace_root or "", profile)
        if os.path.isdir(agent_dir):
            return agent_dir
        external = self._external_agent_dir(profile)
        if external and os.path.isdir(external):
            return external
        return self._main_workspace()

    def _main_workspace(self) -> str:
        return os.path.expanduser(self.main_workspace or self.workspace_root or os.getcwd())

    def _office_agent_dirs(self) -> list[str]:
        dirs: list[str] = []
        seen: set[str] = set()
        if self.workspace_root and os.path.isdir(self.workspace_root):
            for name in sorted(os.listdir(self.workspace_root)):
                agent_dir = os.path.join(self.workspace_root, name)
                if os.path.isdir(agent_dir):
                    dirs.append(agent_dir)
                    seen.add(os.path.abspath(agent_dir))
        for _profile, agent_dir in sorted(self._load_external_agents().items()):
            if not agent_dir or not os.path.isdir(agent_dir):
                continue
            real = os.path.abspath(agent_dir)
            if real in seen:
                continue
            dirs.append(agent_dir)
            seen.add(real)
        return dirs

    def _native_agents_dir(self) -> str:
        return os.path.join(os.path.expanduser(self.home_path or "~/.config/opencode"), "agents")

    def _native_agent_file_path(self, profile: str) -> str:
        return os.path.join(self._native_agents_dir(), f"{self._safe_profile_name(profile)}.md")

    def _profile_exists(self, profile: str) -> bool:
        if profile == "main":
            return True
        if os.path.exists(os.path.join(self.workspace_root or "", profile, "opencode-agent.json")):
            return True
        if self._external_agent_dir(profile):
            return True
        native = self._native_agent_file_path(profile)
        return bool(native and os.path.exists(native))

    def _registry_path(self) -> str:
        root = self.workspace_root or os.environ.get("VO_STATUS_DIR", "/data")
        return os.path.join(os.path.expanduser(root), "office-opencode-agent-registry.json")

    def _load_external_agents(self) -> dict[str, str]:
        try:
            with open(self._registry_path(), "r", encoding="utf-8") as f:
                data = json.load(f)
            agents = data.get("agents", {}) if isinstance(data, dict) else {}
            return {
                self._safe_profile_name(k): os.path.abspath(os.path.expanduser(str(v)))
                for k, v in agents.items()
                if k and v
            }
        except Exception:
            return {}

    def _save_external_agent(self, profile: str, agent_dir: str) -> None:
        data = {"schema": "my-virtual-office.opencode-agent-registry.v1", "agents": self._load_external_agents()}
        data["agents"][self._safe_profile_name(profile)] = os.path.abspath(agent_dir)
        self._write_json(self._registry_path(), data)

    def _remove_external_agent(self, profile: str) -> None:
        path = self._registry_path()
        data = {"schema": "my-virtual-office.opencode-agent-registry.v1", "agents": self._load_external_agents()}
        data["agents"].pop(self._safe_profile_name(profile), None)
        self._write_json(path, data)

    def _external_agent_dir(self, profile: str) -> str:
        return self._load_external_agents().get(self._safe_profile_name(profile), "")

    def _resolve_custom_parent(self, value: str | None) -> str:
        path = os.path.expanduser(str(value or "").strip())
        if not path:
            return ""
        os.makedirs(path, exist_ok=True)
        return os.path.abspath(path)

    def _is_native_agent_path(self, path: str) -> bool:
        agents_dir = self._native_agents_dir()
        return bool(path and agents_dir and self._path_is_inside(path, agents_dir))

    def _is_managed_agent_dir(self, path: str, profile: str) -> bool:
        if not path or not os.path.isdir(path) or os.path.islink(path):
            return False
        meta = self._load_meta(path)
        return (
            meta.get("providerKind") == self.provider_kind
            and self._safe_profile_name(meta.get("profile")) == self._safe_profile_name(profile)
        )

    def _load_meta(self, agent_dir: str) -> dict[str, Any]:
        try:
            with open(os.path.join(agent_dir, "opencode-agent.json"), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _load_agent_md(self, path: str) -> dict[str, str]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read(16000)
        except OSError:
            return {}
        meta: dict[str, str] = {}
        body = content
        if content.startswith("---"):
            end = content.find("\n---", 3)
            if end > 0:
                frontmatter = content[3:end].strip()
                body = content[end + 4 :]
                for line in frontmatter.splitlines():
                    if ":" not in line:
                        continue
                    key, value = line.split(":", 1)
                    meta[key.strip()] = value.strip().strip('"\'')
        title = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        profile = self._safe_profile_name(meta.get("name") or os.path.splitext(os.path.basename(path))[0])
        meta.setdefault("name", profile)
        if title:
            meta.setdefault("displayName", title.group(1).strip())
        return meta

    @staticmethod
    def _parse_session_list(output: str) -> list[dict[str, str]]:
        raw = output.strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
            rows = parsed.get("sessions") if isinstance(parsed, dict) else parsed
            if isinstance(rows, list):
                return [
                    {
                        "id": str(row.get("id") or row.get("sessionId") or ""),
                        "title": str(row.get("title") or row.get("name") or row.get("summary") or ""),
                        "preview": str(row.get("preview") or ""),
                        "updatedAt": row.get("updatedAt") or row.get("lastActive") or None,
                    }
                    for row in rows
                    if isinstance(row, dict) and (row.get("id") or row.get("sessionId"))
                ]
        except json.JSONDecodeError:
            pass
        sessions = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.lower().startswith("id") or line.startswith("-"):
                continue
            parts = line.split(None, 1)
            if parts:
                sessions.append({"id": parts[0], "title": parts[1] if len(parts) > 1 else ""})
        return sessions

    @staticmethod
    def _json_event(line: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None

    @classmethod
    def _consume_run_event(
        cls,
        event: dict[str, Any],
        reply_lines: list[str],
        tools_by_id: dict[str, dict[str, Any]],
        profile: str,
        session_id: str,
    ) -> dict[str, Any]:
        state: dict[str, Any] = {"status": "streaming", "sessionId": cls._event_session_id(event) or session_id}
        text = cls._event_text(event)
        if text:
            reply_lines.append(text)
        tool = cls._tool_from_event(event)
        if tool:
            key = str(tool.get("id") or tool.get("name") or len(tools_by_id))
            prior = tools_by_id.get(key, {})
            tools_by_id[key] = {**prior, **tool}
        approval = cls._approval_from_event(event, profile)
        if approval:
            state["approval"] = approval
            state["status"] = "approval"
        elif tool:
            state["status"] = str(tool.get("status") or "tool")
        elif text:
            state["status"] = "streaming"
        else:
            event_type = str(event.get("type") or event.get("event") or event.get("kind") or "").lower()
            state["status"] = event_type or "streaming"
        return state

    @staticmethod
    def _event_session_id(event: dict[str, Any]) -> str:
        for key in ("sessionID", "sessionId", "session_id", "threadId", "conversationId"):
            if event.get(key):
                return str(event.get(key) or "")
        nested = event.get("session") if isinstance(event.get("session"), dict) else {}
        return str(nested.get("id") or nested.get("sessionId") or "")

    @classmethod
    def _event_text(cls, event: dict[str, Any]) -> str:
        event_type = str(event.get("type") or event.get("event") or event.get("kind") or "").lower()
        if any(token in event_type for token in ("tool", "permission", "approval", "step")):
            return ""
        for key in ("delta", "text", "content", "message", "output", "response"):
            value = event.get(key)
            text = cls._coerce_text(value)
            if text:
                return text
        return ""

    @classmethod
    def _coerce_text(cls, value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            if value.get("role") and value.get("role") not in {"assistant", "agent"}:
                return ""
            for key in ("text", "content", "message", "output"):
                text = cls._coerce_text(value.get(key))
                if text:
                    return text
        if isinstance(value, list):
            parts = []
            for item in value:
                if isinstance(item, dict) and item.get("type") not in {None, "text", "output_text"}:
                    continue
                text = cls._coerce_text(item)
                if text:
                    parts.append(text)
            return "".join(parts)
        return ""

    @staticmethod
    def _tool_from_event(event: dict[str, Any]) -> dict[str, Any] | None:
        event_type = str(event.get("type") or event.get("event") or event.get("kind") or "").lower()
        if "tool" not in event_type and not any(k in event for k in ("tool", "toolCall", "tool_call")):
            return None
        raw_tool = event.get("toolCall") or event.get("tool_call") or event.get("tool")
        if isinstance(raw_tool, dict):
            source = {**raw_tool, **{k: v for k, v in event.items() if k not in {"toolCall", "tool_call", "tool"}}}
        else:
            source = event
        name = str(source.get("name") or source.get("tool") or source.get("title") or source.get("command") or "OpenCode tool")
        tool_id = str(source.get("id") or source.get("toolCallId") or source.get("callId") or hashlib.sha1(json.dumps(source, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16])
        status = str(source.get("status") or source.get("state") or "").lower()
        if not status:
            status = "done" if any(token in event_type for token in ("result", "finish", "complete", "end")) else "running"
        if status in {"completed", "complete", "success", "succeeded"}:
            status = "done"
        if status in {"failed", "failure"}:
            status = "error"
        args = source.get("arguments") or source.get("args") or source.get("input") or {}
        result = source.get("result") or source.get("output") or source.get("content") or ""
        error = source.get("error") or ""
        return {"id": tool_id, "name": name, "status": status, "arguments": args, "result": result, "error": error}

    @classmethod
    def _approval_from_event(cls, event: dict[str, Any], profile: str) -> dict[str, Any] | None:
        event_type = str(event.get("type") or event.get("event") or event.get("kind") or "").lower()
        text = json.dumps(event, sort_keys=True, default=str).lower()
        if not ("approval" in event_type or "permission" in event_type or "permission" in text or "approve" in text):
            return None
        approval_id = str(event.get("id") or event.get("approval_id") or event.get("approvalId") or hashlib.sha1(json.dumps(event, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16])
        command = str(event.get("command") or event.get("pattern") or event.get("tool") or event.get("name") or event.get("description") or "OpenCode permission request")
        return {
            "id": approval_id,
            "approval_id": approval_id,
            "provider": "opencode-cli",
            "profile": profile,
            "title": "OpenCode approval required",
            "description": str(event.get("description") or event.get("message") or "OpenCode needs permission before it can continue. Approving reruns this turn once with OpenCode --auto."),
            "command": command,
            "status": "pending",
            "raw": event,
        }

    @staticmethod
    def _approval_from_text(text: str, profile: str) -> dict[str, Any] | None:
        lowered = str(text or "").lower()
        if not any(token in lowered for token in ("approval", "permission", "authorize", "allow")):
            return None
        approval_id = "opencode-approval-" + hashlib.sha1(f"{profile}:{text}".encode("utf-8")).hexdigest()[:16]
        return {
            "id": approval_id,
            "approval_id": approval_id,
            "provider": "opencode-cli",
            "profile": profile,
            "title": "OpenCode approval required",
            "description": "OpenCode exited while waiting for permission. Approving reruns this turn once with OpenCode --auto.",
            "command": str(text or "OpenCode permission request")[:500],
            "status": "pending",
        }

    def _identity_md(self, name: str, role: str, emoji: str) -> str:
        return f"# {name}\n\n- Emoji: {emoji or '⚡'}\n- Role: {role or 'OpenCode Agent'}\n- Platform: OpenCode\n"

    def _agents_md(self, name: str, role: str, instructions: str) -> str:
        return f"# {name}\n\nRole: {role or 'OpenCode Agent'}\n\n{instructions}\n"

    def _agent_md(self, profile: str, role: str, instructions: str, model: str = "") -> str:
        desc = (role or "OpenCode Agent").replace("\n", " ").strip()
        lines = ["---", f"description: {desc}", "mode: primary"]
        if model:
            lines.append(f"model: {model}")
        lines.extend(["---", "", instructions.strip() or desc, ""])
        return "\n".join(lines)

    @staticmethod
    def _write_text(path: str, content: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    @classmethod
    def _write_json(cls, path: str, data: dict[str, Any]) -> None:
        cls._write_text(path, json.dumps(data, indent=2) + "\n")

    @staticmethod
    def _resolve_binary(value: str | None) -> str:
        return resolve_executable(value, "VO_OPENCODE_BIN", "opencode")

    @staticmethod
    def _path_is_inside(path: str, parent: str) -> bool:
        try:
            return os.path.commonpath([os.path.abspath(path), os.path.abspath(parent)]) == os.path.abspath(parent)
        except (ValueError, OSError):
            return False

    @staticmethod
    def _safe_profile_name(value: str | None) -> str:
        raw = str(value or "").strip().lower()
        raw = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
        raw = re.sub(r"-{2,}", "-", raw)
        return raw[:64] or "opencode-agent"

    @staticmethod
    def _safe_suffix(value: str | None) -> str:
        return re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value or "opencode-agent")).strip("-")[:80] or "opencode-agent"

    @staticmethod
    def _display_name(profile: str) -> str:
        if profile == "main":
            return "Main"
        return str(profile or "opencode").replace("-", " ").replace("_", " ").title()

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
