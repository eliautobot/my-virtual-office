"""Codex provider adapter for My Virtual Office.

The primary integration uses Codex's app-server JSON-RPC protocol over stdio.
`codex exec` is retained only as a compatibility fallback for installs that
explicitly disable the native path.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import tomllib
from dataclasses import dataclass
from typing import Any, Callable

from .file_safety import backup_files, directory_has_content, remove_agent_folder
from .cli_runner import safe_session_id
from .process_env import agent_env
import data_owner   # (folders and files made as root keep the data folder's owner)


ProgressCallback = Callable[[dict[str, Any]], None]

_ACTIVE_RUNS: dict[str, "CodexAppServerClient"] = {}
_ACTIVE_RUNS_LOCK = threading.Lock()

def _flag(value, env_key, default=True):
    """An on/off setting: the value given (the office's settings), else the environment's, else default."""
    if value is None:
        value = os.environ.get(env_key, default)
    return str(value).lower() not in ("0", "false", "no", "off")



@dataclass
class CodexProvider:
    """Provider adapter for local Codex-backed Office agents."""

    home_path: str | None = None
    binary: str | None = None
    workspace_root: str | None = None
    enabled: bool = True
    timeout_sec: int = 900
    model: str = ""
    effort: str = ""                  # thinking level of the next turn ("" = the model's own); see list_models()
    sandbox: str = "workspace-write"
    approval_policy: str = "untrusted"
    prefer_app_server: bool | None = None
    main_workspace: str | None = None
    include_main: bool | None = None
    include_native_agents: bool | None = None
    register_native_agents: bool | None = None

    provider_kind: str = "codex"
    provider_type: str = "harness"

    def __post_init__(self) -> None:
        self._last_auth_error = ""
        self.home_path = os.path.expanduser(
            self.home_path
            or os.environ.get("VO_CODEX_HOME")
            or os.environ.get("CODEX_HOME")
            or "~/.codex"
        )
        self.binary = self._resolve_binary(self.binary)
        self.workspace_root = os.path.expanduser(
            self.workspace_root
            or os.environ.get("VO_CODEX_WORKSPACE_ROOT")
            or os.path.join(os.environ.get("VO_STATUS_DIR", "/data"), "codex-agents")
        )
        self.main_workspace = os.path.expanduser(
            self.main_workspace
            or os.environ.get("VO_CODEX_MAIN_WORKSPACE")
            or self.workspace_root
        )
        self.sandbox = str(self.sandbox or "workspace-write")
        self.approval_policy = str(self.approval_policy or "untrusted")
        self.model = str(self.model or "")
        self.prefer_app_server = _flag(self.prefer_app_server, "VO_CODEX_PREFER_APP_SERVER")
        self.include_main = _flag(self.include_main, "VO_CODEX_INCLUDE_MAIN")
        self.include_native_agents = _flag(self.include_native_agents, "VO_CODEX_INCLUDE_NATIVE_AGENTS")
        self.register_native_agents = _flag(self.register_native_agents, "VO_CODEX_REGISTER_NATIVE_AGENTS")
        self._auth_state_path = os.path.join(
            os.environ.get("VO_STATUS_DIR", "/data"),
            "provider-health-codex.json",
        )
        self._observed_auth_mtime = self._auth_file_mtime()
        self._sync_auth_error_state()

    def list_models(self, timeout_sec: int = 25) -> dict[str, Any]:
        """The models this Codex can use and each one's thinking levels (app-server ``model/list``), as the native
        app's model picker shows them. Hidden models are left out."""
        if not self.is_available():
            return {"ok": False, "error": f"Codex CLI is not available at {self.binary}", "models": []}
        cwd = next((p for p in (self.main_workspace, self.workspace_root, self.home_path) if p and os.path.isdir(p)), "/")
        client = None
        try:
            client = CodexAppServerClient(self, cwd=cwd, timeout_sec=timeout_sec)
            client.initialize()
            models: list[dict[str, Any]] = []
            cursor = None
            for _ in range(10):
                response = client.request("model/list", {"cursor": cursor} if cursor else {}, timeout_sec=timeout_sec)
                result = (response.get("result") or {}) if isinstance(response, dict) else {}
                for row in result.get("data") or []:
                    if not isinstance(row, dict) or row.get("hidden"):
                        continue
                    model_id = str(row.get("model") or row.get("id") or "").strip()
                    if not model_id:
                        continue
                    efforts = []
                    for opt in row.get("supportedReasoningEfforts") or []:
                        level = str((opt or {}).get("reasoningEffort") or "").strip() if isinstance(opt, dict) else str(opt or "")
                        if level:
                            efforts.append({"id": level, "description": str((opt or {}).get("description") or "") if isinstance(opt, dict) else ""})
                    models.append({
                        "id": model_id,
                        "label": str(row.get("displayName") or model_id),
                        "description": str(row.get("description") or ""),
                        "isDefault": bool(row.get("isDefault")),
                        "effort": efforts,
                        "effortDefault": str(row.get("defaultReasoningEffort") or ""),
                    })
                cursor = result.get("nextCursor")
                if not cursor:
                    break
            return {"ok": True, "models": models}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "models": []}
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    def is_available(self) -> bool:
        return bool(
            self.enabled
            and self.binary
            and os.path.isfile(self.binary)
            and os.access(self.binary, os.X_OK)
        )

    def test(self) -> dict[str, Any]:
        self._sync_auth_error_state()
        if not self.binary or not os.path.isfile(self.binary):
            where = f" at {self.binary}" if self.binary and os.path.basename(self.binary) != self.binary else ""
            return {"ok": False, "error": f"Codex CLI not found{where}. Set its Executable in More tools > Providers > Codex (or VO_CODEX_BIN), or install codex on PATH.", "agents": []}
        if not os.access(self.binary, os.X_OK):
            return {"ok": False, "error": f"Codex CLI is not executable at {self.binary}", "agents": []}

        if self.prefer_app_server:
            try:
                self._ensure_paths()
                client = CodexAppServerClient(self, cwd=self.workspace_root or os.getcwd(), timeout_sec=20)
                try:
                    init = client.initialize()
                    account = client.request("account/read", {"refreshToken": False}, timeout_sec=12)
                finally:
                    client.close()
                account_result = account.get("result") if isinstance(account, dict) else {}
                account_info = account_result.get("account") if isinstance(account_result, dict) else None
                auth_ok = bool(account_info) or (isinstance(account_result, dict) and account_result.get("requiresOpenaiAuth") is False)
                access_token_expired = self._access_token_expired()
                if access_token_expired is True:
                    auth_ok = False
                if self._last_auth_error:
                    auth_ok = False
                return {
                    "ok": auth_ok,
                    "protocol": "app-server",
                    "binary": self.binary,
                    "homePath": self.home_path,
                    "workspaceRoot": self.workspace_root,
                    "mainWorkspace": self._main_workspace(),
                    "authOk": auth_ok,
                    "authStatus": self._account_status_text(account_result),
                    "codexHome": (init.get("result") or {}).get("codexHome") if isinstance(init, dict) else self.home_path,
                    "error": "" if auth_ok else (
                        self._last_auth_error
                        or (
                            "Codex access token is expired. Run a Codex turn to verify refresh, or sign in again."
                            if access_token_expired is True
                            else "Codex is installed but not authenticated. Run codex login or configure CODEX_API_KEY/CODEX_HOME for this environment."
                        )
                    ),
                    "agents": self.discover_agents() if auth_ok else [],
                }
            except Exception as exc:
                return {"ok": False, "protocol": "app-server", "error": str(exc), "agents": []}

        try:
            status = self._run([self.binary, "login", "status"], timeout_sec=15)
            auth_ok = status.returncode == 0
            auth_text = ((status.stdout or status.stderr or "").strip())[:500]
            return {
                "ok": auth_ok,
                "protocol": "exec",
                "binary": self.binary,
                "homePath": self.home_path,
                "workspaceRoot": self.workspace_root,
                "mainWorkspace": self._main_workspace(),
                "authOk": auth_ok,
                "authStatus": auth_text,
                "error": "" if auth_ok else (auth_text or "Codex is not logged in"),
                "agents": self.discover_agents() if auth_ok else [],
            }
        except Exception as exc:
            return {"ok": False, "protocol": "exec", "error": str(exc), "agents": []}

    def discover_agents(self) -> list[dict[str, Any]]:
        if not self.is_available():
            return []

        agents: list[dict[str, Any]] = []
        seen_profiles: set[str] = set()
        if self.include_main:
            agents.append(self._agent_entry(
                profile="main",
                name="Main",
                emoji="🤖",
                role="Default Codex agent",
                model=self.model or "",
                workspace=self._main_workspace(),
                source="native-main",
                last_active=self._last_active(self._main_workspace()),
            ))
            seen_profiles.add("main")

        if not self.workspace_root or not os.path.isdir(self.workspace_root):
            return agents + self._discover_native_agents(seen_profiles)

        for agent_dir in self._office_agent_dirs():
            try:
                with open(os.path.join(agent_dir, "office-agent.json"), "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                continue
            profile = self._safe_profile_name(meta.get("profile") or os.path.basename(agent_dir))
            if profile in seen_profiles:
                continue
            seen_profiles.add(profile)
            agents.append(self._agent_entry(
                profile=profile,
                name=meta.get("name") or self._display_name(profile),
                emoji=meta.get("emoji") or "🤖",
                role=meta.get("role") or "Codex Agent",
                model=meta.get("model") or self.model or "",
                workspace=agent_dir,
                source=meta.get("creationMode") or "virtual-office",
                last_active=self._last_active(agent_dir),
                native_agent_path=meta.get("nativeAgentPath") or "",
            ))
        agents.extend(self._discover_native_agents(seen_profiles))
        return agents

    def create_agent(
        self,
        name: str,
        role: str = "Codex Agent",
        model: str | None = None,
        emoji: str = "🤖",
        profile: str | None = None,
        prompt: str | None = None,
        creation_mode: str = "standard",
        custom_directory: str | None = None,
    ) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": f"Codex CLI is not available. Set its Executable in More tools > Providers > Codex (or VO_CODEX_BIN), or install codex on PATH."}

        safe_profile = self._safe_profile_name(profile or name)
        if not safe_profile:
            return {"ok": False, "error": "Invalid Codex profile name"}
        if self._profile_exists(safe_profile):
            return {"ok": False, "error": f"Codex agent '{safe_profile}' already exists"}

        mode = str(creation_mode or "standard").strip().lower()
        if mode not in {"standard", "custom"}:
            mode = "standard"
        if mode == "custom":
            parent_dir = self._resolve_custom_parent(custom_directory)
            if not parent_dir:
                return {"ok": False, "error": "A custom parent directory is required for custom Codex agent creation"}
            native_agents_dir = self._native_agents_dir()
            if native_agents_dir and self._path_is_inside(parent_dir, native_agents_dir):
                return {"ok": False, "error": "Custom workspace directory cannot be inside the Codex agents TOML directory. Use the standard Codex directory option instead."}
            agent_dir = os.path.join(parent_dir, safe_profile)
        else:
            agent_dir = os.path.join(self.workspace_root or "", safe_profile)
        meta_path = os.path.join(agent_dir, "office-agent.json")
        if os.path.exists(meta_path):
            return {"ok": False, "error": f"Codex agent '{safe_profile}' already exists"}
        if directory_has_content(agent_dir):
            # Never adopt (and later delete) an existing folder such as a real project (BE-06).
            return {"ok": False, "error": f"The folder {agent_dir} already exists and is not empty. Choose another agent ID or parent folder."}

        native_agent_path = self._native_agent_file_path(safe_profile) if mode == "standard" else ""
        should_register_native = mode == "standard" and self.register_native_agents and native_agent_path
        if should_register_native and os.path.exists(native_agent_path):
            return {"ok": False, "error": f"Native Codex agent '{safe_profile}' already exists in {native_agent_path}"}

        data_owner.makedirs(os.path.join(agent_dir, ".codex", "agents"), exist_ok=True)
        data_owner.makedirs(os.path.join(agent_dir, ".agents", "skills"), exist_ok=True)
        model_value = (model or self.model or "").strip()
        instructions = (prompt or role or "Codex Agent").strip()
        meta = {
            "profile": safe_profile,
            "name": name,
            "emoji": emoji or "🤖",
            "role": role or "Codex Agent",
            "prompt": instructions,
            "model": model_value,
            "providerKind": self.provider_kind,
            "providerType": self.provider_type,
            "creationMode": mode,
            "customParentDirectory": os.path.dirname(agent_dir) if mode == "custom" else "",
            "createdAt": int(time.time()),
            "writtenFiles": self._written_files(safe_profile),
        }
        if should_register_native:
            meta["nativeAgentPath"] = native_agent_path
        self._write_json(meta_path, meta)
        self._write_text(os.path.join(agent_dir, "IDENTITY.md"), self._identity_md(name, role, emoji))
        self._write_text(os.path.join(agent_dir, "AGENTS.md"), self._agents_md(name, role, instructions))
        self._write_text(os.path.join(agent_dir, ".codex", "config.toml"), self._config_toml(model_value))
        self._write_text(os.path.join(agent_dir, ".codex", "agents", f"{safe_profile}.toml"), self._agent_toml(safe_profile, role, instructions, model_value))
        if should_register_native:
            self._write_text(native_agent_path, self._agent_toml(safe_profile, role, instructions, model_value))
        if mode == "custom":
            self._save_external_agent(safe_profile, agent_dir)

        return {
            "ok": True,
            "profile": safe_profile,
            "agentId": f"codex-{safe_profile}",
            "name": name,
            "workspace": agent_dir,
            "creationMode": mode,
            "nativeAgentPath": native_agent_path if should_register_native else "",
            "message": f"Codex agent '{name}' created successfully",
        }

    def delete_agent(self, profile: str) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        if not safe_profile:
            return {"ok": False, "error": "profile is required"}
        if safe_profile == "main":
            return {"ok": False, "error": "The built-in Codex Main agent cannot be deleted"}
        agent_dir = os.path.join(self.workspace_root or "", safe_profile)
        meta = self._load_meta(agent_dir)
        if not os.path.isdir(agent_dir):
            native_path = self._native_agent_file_path(safe_profile)
            if native_path and os.path.isfile(native_path):
                os.remove(native_path)
                return {"ok": True, "deleted": True, "profile": safe_profile, "agentId": f"codex-{safe_profile}", "nativeAgentPath": native_path}
            external_dir = self._external_agent_dir(safe_profile)
            if external_dir and os.path.isdir(external_dir):
                external_meta = self._load_meta(external_dir)
                # Custom parent folders may be a real project: remove only what the office wrote.
                remove_agent_folder(external_dir, external_meta.get("writtenFiles") or self._written_files(safe_profile),
                                    marker="office-agent.json")
                self._remove_external_agent(safe_profile)
                return {"ok": True, "deleted": True, "profile": safe_profile, "agentId": f"codex-{safe_profile}"}
            return {"ok": True, "deleted": False, "profile": safe_profile, "agentId": f"codex-{safe_profile}"}
        remove_agent_folder(agent_dir, meta.get("writtenFiles") or self._written_files(safe_profile),
                            managed_root=self.workspace_root or "", marker="office-agent.json")
        self._remove_external_agent(safe_profile)
        native_path = str(meta.get("nativeAgentPath") or "")
        if native_path and os.path.isfile(native_path) and self._is_native_agent_path(native_path):
            try:
                os.remove(native_path)
            except OSError:
                pass
        return {"ok": True, "deleted": True, "profile": safe_profile, "agentId": f"codex-{safe_profile}"}

    def update_profile(self, profile: str, patch: dict[str, Any]) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        agent_dir = self._runtime_workspace(safe_profile)
        meta_path = os.path.join(agent_dir, "office-agent.json")
        meta = self._load_meta(agent_dir)
        if not meta or meta.get("profile") != safe_profile:
            return {"ok": False, "error": f"Managed Codex agent '{safe_profile}' was not found"}
        for key in ("name", "role", "emoji", "model"):
            if key in patch:
                meta[key] = str(patch.get(key) or "")
        if "instructions" in patch:
            meta["prompt"] = str(patch.get("instructions") or "")
        name = str(meta.get("name") or self._display_name(safe_profile))
        role = str(meta.get("role") or "Codex Agent")
        emoji = str(meta.get("emoji") or "🤖")
        model = str(meta.get("model") or self.model or "")
        instructions = str(meta.get("prompt") or role)
        native_path = str(meta.get("nativeAgentPath") or "")
        project_path = os.path.join(agent_dir, ".codex", "agents", f"{safe_profile}.toml")
        config_path = os.path.join(agent_dir, ".codex", "config.toml")
        paths = [meta_path, os.path.join(agent_dir, "IDENTITY.md"), os.path.join(agent_dir, "AGENTS.md"), project_path, config_path, native_path]
        backup_id, backups = backup_files(agent_dir, paths)
        self._write_json(meta_path, meta)
        self._write_text(os.path.join(agent_dir, "IDENTITY.md"), self._identity_md(name, role, emoji))
        self._write_text(os.path.join(agent_dir, "AGENTS.md"), self._agents_md(name, role, instructions))
        self._write_text(project_path, self._agent_toml(safe_profile, role, instructions, model))
        self._write_text(config_path, self._config_toml(model))
        if native_path:
            self._write_text(native_path, self._agent_toml(safe_profile, role, instructions, model))
        return {"ok": True, "profile": safe_profile, "backupId": backup_id, "backups": backups}

    def send_chat_message(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        if self.prefer_app_server:
            result = self._send_app_server_message(profile, message, session_id=session_id, timeout_sec=timeout_sec, on_progress=on_progress)
        else:
            result = self._send_exec_message(profile, message, session_id=session_id, timeout_sec=timeout_sec)
        error_text = str(result.get("error") or result.get("stderr") or "")
        if any(marker in error_text.lower() for marker in ("not authenticated", "token_expired", "refresh token", "log out and sign in")):
            self._record_auth_error("Codex authentication expired. Sign in to Codex again before running agents.")
            result["error"] = self._last_auth_error
        elif result.get("ok"):
            self._clear_auth_error()
        return result

    def start_chat_stream(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
    ) -> "CodexAppStreamRun":
        """Start a Codex app-server turn and return a live event reader."""
        if not self.prefer_app_server:
            raise RuntimeError("Codex streaming requires the app-server protocol")
        if not self.is_available():
            raise RuntimeError(f"Codex CLI is not available at {self.binary}")
        if not message.strip():
            raise ValueError("message is required")

        self._ensure_paths()
        safe_profile = self._safe_profile_name(profile)
        agent_dir = self._runtime_workspace(safe_profile)
        if not os.path.isdir(agent_dir):
            raise FileNotFoundError(f"Codex agent workspace not found: {agent_dir}")

        timeout = int(timeout_sec or self.timeout_sec)
        client = CodexAppServerClient(self, cwd=agent_dir, timeout_sec=timeout + 30)
        state = CodexAppRunState()
        buffered_events: list[dict[str, Any]] = []

        def capture_initial(msg: dict[str, Any]) -> None:
            state.handle_message(msg)
            event = state.event_from_message(msg)
            if event:
                buffered_events.append(event)

        client.profile = safe_profile
        client.approval_callback = state.set_approval

        try:
            client.initialize()
            thread_params = {
                "cwd": agent_dir,
                "approvalPolicy": self.approval_policy,
                "sandbox": self.sandbox,
                "threadSource": "user",
            }
            developer_instructions = self._thread_instructions(agent_dir, safe_profile)
            if developer_instructions:
                thread_params["developerInstructions"] = developer_instructions
            if self.model:
                thread_params["model"] = self.model
            if session_id:
                thread_params["threadId"] = session_id
                thread_response = client.request("thread/resume", thread_params, event_handler=capture_initial)
            else:
                thread_response = client.request("thread/start", thread_params, event_handler=capture_initial)
            thread = ((thread_response.get("result") or {}).get("thread") or {}) if isinstance(thread_response, dict) else {}
            state.thread_id = str(thread.get("id") or thread.get("sessionId") or session_id or "")
            if not state.thread_id:
                raise RuntimeError("Codex app-server did not return a thread id")

            turn_response = client.request(
                "turn/start",
                {
                    "threadId": state.thread_id,
                    "input": [{"type": "text", "text": message, "text_elements": []}],
                    "cwd": agent_dir,
                    "approvalPolicy": self.approval_policy,
                    "model": self.model or None,
                    "effort": self.effort or None,
                },
                event_handler=capture_initial,
            )
            turn = ((turn_response.get("result") or {}).get("turn") or {}) if isinstance(turn_response, dict) else {}
            state.turn_id = str(turn.get("id") or state.turn_id or "")
            client.thread_id = state.thread_id
            client.turn_id = state.turn_id
            with _ACTIVE_RUNS_LOCK:
                _ACTIVE_RUNS[safe_profile] = client
            return CodexAppStreamRun(
                provider=self,
                profile=safe_profile,
                client=client,
                state=state,
                timeout_sec=timeout,
                buffered_events=buffered_events,
            )
        except Exception:
            with _ACTIVE_RUNS_LOCK:
                if _ACTIVE_RUNS.get(safe_profile) is client:
                    _ACTIVE_RUNS.pop(safe_profile, None)
            client.close()
            raise

    def _auth_file_mtime(self) -> float:
        try:
            return os.path.getmtime(os.path.join(self.home_path or "", "auth.json"))
        except OSError:
            return 0.0

    def _access_token_expired(self) -> bool | None:
        try:
            with open(os.path.join(self.home_path or "", "auth.json"), "r", encoding="utf-8") as f:
                auth = json.load(f)
            token = str(((auth.get("tokens") or {}).get("access_token")) or "")
            payload_part = token.split(".")[1]
            payload_part += "=" * (-len(payload_part) % 4)
            payload = json.loads(base64.urlsafe_b64decode(payload_part.encode("ascii")))
            expires_at = int(payload.get("exp") or 0)
            return bool(expires_at and time.time() >= expires_at - 30)
        except (FileNotFoundError, OSError, ValueError, IndexError, TypeError, json.JSONDecodeError, binascii.Error):
            return None

    def _sync_auth_error_state(self) -> None:
        current_auth_mtime = self._auth_file_mtime()
        if current_auth_mtime > 0 and current_auth_mtime != self._observed_auth_mtime:
            self._observed_auth_mtime = current_auth_mtime
            self._clear_auth_error()
        try:
            with open(self._auth_state_path, "r", encoding="utf-8") as f:
                state = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
            return
        recorded_auth_mtime = float(state.get("authFileMtime") or 0)
        if current_auth_mtime > recorded_auth_mtime:
            self._clear_auth_error()
            return
        self._last_auth_error = str(state.get("error") or "")

    def _record_auth_error(self, message: str) -> None:
        self._last_auth_error = str(message or "")
        state = {
            "error": self._last_auth_error,
            "recordedAt": time.time(),
            "authFileMtime": self._auth_file_mtime(),
        }
        try:
            data_owner.makedirs(os.path.dirname(self._auth_state_path), exist_ok=True)
            tmp_path = f"{self._auth_state_path}.tmp-{os.getpid()}"
            with data_owner.open_new(tmp_path, "w", encoding="utf-8") as f:
                json.dump(state, f)
            os.replace(tmp_path, self._auth_state_path)
        except OSError:
            pass

    def _clear_auth_error(self) -> None:
        self._last_auth_error = ""
        try:
            os.remove(self._auth_state_path)
        except FileNotFoundError:
            pass
        except OSError:
            pass

    def interrupt(self, profile: str) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        with _ACTIVE_RUNS_LOCK:
            client = _ACTIVE_RUNS.get(safe_profile)
        if not client:
            return {"ok": False, "error": "No active Codex turn is running for this agent."}
        return client.interrupt()

    def respond_approval(self, profile: str, approval_id: str, choice: str = "cancel") -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        with _ACTIVE_RUNS_LOCK:
            client = _ACTIVE_RUNS.get(safe_profile)
        if not client:
            return {"ok": False, "error": "No active Codex turn is running for this agent."}
        return client.respond_approval(approval_id, choice)

    def pending_approval(self, profile: str) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        with _ACTIVE_RUNS_LOCK:
            client = _ACTIVE_RUNS.get(safe_profile)
        if not client:
            return {"ok": True, "pending": None, "pending_count": 0}
        return client.pending_approval()

    def _app_server_simple_request(self, profile: str, method: str, params: dict[str, Any] | None = None, timeout_sec: int = 30) -> dict[str, Any]:
        """Run a short Codex app-server JSON-RPC request and close the client."""
        if not self.is_available():
            return {"ok": False, "error": f"Codex CLI is not available at {self.binary}"}
        self._ensure_paths()
        safe_profile = self._safe_profile_name(profile)
        agent_dir = self._runtime_workspace(safe_profile)
        if not os.path.isdir(agent_dir):
            return {"ok": False, "error": f"Codex agent workspace not found: {agent_dir}"}
        client = CodexAppServerClient(self, cwd=agent_dir, timeout_sec=timeout_sec + 15)
        try:
            client.initialize()
            response = client.request(method, params or {}, timeout_sec=timeout_sec)
            if isinstance(response, dict) and response.get("error"):
                err = response["error"]
                return {"ok": False, "error": str(err.get("message") or err)[:1000]}
            result = (response or {}).get("result") if isinstance(response, dict) else None
            return {"ok": True, "result": result if isinstance(result, (dict, list)) else {}, "profile": safe_profile, "cwd": agent_dir}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:1000]}
        finally:
            client.close()

    def list_threads(self, profile: str, limit: int = 40, timeout_sec: int = 30) -> dict[str, Any]:
        """List saved Codex threads for this agent workspace via thread/list."""
        safe_profile = self._safe_profile_name(profile)
        agent_dir = self._runtime_workspace(safe_profile)
        outcome = self._app_server_simple_request(profile, "thread/list", {
            "cwd": agent_dir,
            "limit": max(1, int(limit)),
            # Codex defaults an omitted sourceKinds filter to interactive CLI
            # and VS Code threads only. Virtual Office must also follow turns
            # started through `codex exec` or another app-server client.
            "sourceKinds": ["cli", "vscode", "exec", "appServer", "unknown"],
            # Active-session following is based on latest activity, including
            # a resumed older thread, rather than original creation order.
            "sortKey": "updated_at",
            "sortDirection": "desc",
        }, timeout_sec=timeout_sec)
        if not outcome.get("ok"):
            return {"ok": False, "error": outcome.get("error"), "sessions": []}
        rows = (outcome.get("result") or {}).get("data")
        sessions: list[dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            preview = str(row.get("preview") or "")
            sessions.append({
                "id": str(row.get("id") or ""),
                "title": str(row.get("name") or "").strip() or preview[:80] or str(row.get("id") or "")[:24],
                "preview": preview[:300],
                "updatedAt": row.get("updatedAt"),
                "createdAt": row.get("createdAt"),
                "archived": bool(row.get("archived")),
            })
        return {"ok": True, "sessions": sessions, "profile": safe_profile}

    def read_thread(self, profile: str, thread_id: str, timeout_sec: int = 30) -> dict[str, Any]:
        """Read one thread's turns/items via thread/read."""
        if not thread_id:
            return {"ok": False, "error": "thread_id is required"}
        outcome = self._app_server_simple_request(profile, "thread/read", {
            "threadId": str(thread_id),
            "includeTurns": True,
        }, timeout_sec=timeout_sec)
        if not outcome.get("ok"):
            return {"ok": False, "error": outcome.get("error"), "thread": None}
        result = outcome.get("result") or {}
        thread = result.get("thread") if isinstance(result, dict) else None
        return {"ok": True, "thread": thread if isinstance(thread, dict) else result}

    def delete_thread(self, profile: str, thread_id: str, timeout_sec: int = 30) -> dict[str, Any]:
        """Delete a saved Codex thread through the app-server."""
        if not thread_id:
            return {"ok": False, "error": "thread_id is required"}
        outcome = self._app_server_simple_request(profile, "thread/delete", {"threadId": str(thread_id)}, timeout_sec=timeout_sec)
        return {"ok": bool(outcome.get("ok")), "error": outcome.get("error", ""), "deleted": bool(outcome.get("ok"))}

    def _send_app_server_message(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": f"Codex CLI is not available at {self.binary}", "reply": "", "sessionId": session_id or ""}
        if not message.strip():
            return {"ok": False, "error": "message is required", "reply": "", "sessionId": session_id or ""}

        self._ensure_paths()
        safe_profile = self._safe_profile_name(profile)
        agent_dir = self._runtime_workspace(safe_profile)
        if not os.path.isdir(agent_dir):
            return {"ok": False, "error": f"Codex agent workspace not found: {agent_dir}", "reply": "", "sessionId": session_id or ""}

        timeout = int(timeout_sec or self.timeout_sec)
        client = CodexAppServerClient(self, cwd=agent_dir, timeout_sec=timeout + 30)
        state = CodexAppRunState()
        started = time.time()
        last_progress = 0.0

        def emit_progress(force: bool = False) -> None:
            nonlocal last_progress
            if not on_progress:
                return
            now = time.time()
            if force or now - last_progress >= 0.25:
                on_progress(state.snapshot())
                last_progress = now

        def emit_approval(approval: dict[str, Any]) -> None:
            state.set_approval(approval)
            emit_progress(force=True)

        client.profile = safe_profile
        client.approval_callback = emit_approval

        try:
            client.initialize()
            thread_params = {
                "cwd": agent_dir,
                "approvalPolicy": self.approval_policy,
                "sandbox": self.sandbox,
                "threadSource": "user",
            }
            developer_instructions = self._thread_instructions(agent_dir, safe_profile)
            if developer_instructions:
                thread_params["developerInstructions"] = developer_instructions
            if self.model:
                thread_params["model"] = self.model
            if session_id:
                thread_params["threadId"] = session_id
                thread_response = client.request("thread/resume", thread_params, event_handler=state.handle_message)
            else:
                thread_response = client.request("thread/start", thread_params, event_handler=state.handle_message)
            thread = ((thread_response.get("result") or {}).get("thread") or {}) if isinstance(thread_response, dict) else {}
            state.thread_id = str(thread.get("id") or thread.get("sessionId") or session_id or "")
            if not state.thread_id:
                return {"ok": False, "error": "Codex app-server did not return a thread id", "reply": "", "sessionId": session_id or ""}
            client.thread_id = state.thread_id
            with _ACTIVE_RUNS_LOCK:
                _ACTIVE_RUNS[safe_profile] = client

            def handle_turn_event(msg: dict[str, Any]) -> None:
                state.handle_message(msg)
                emit_progress(force=str(msg.get("method") or "") == "thread/tokenUsage/updated")

            turn_response = client.request(
                "turn/start",
                {
                    "threadId": state.thread_id,
                    "input": [{"type": "text", "text": message, "text_elements": []}],
                    "cwd": agent_dir,
                    "approvalPolicy": self.approval_policy,
                    "model": self.model or None,
                    "effort": self.effort or None,
                },
                event_handler=handle_turn_event,
            )
            turn = ((turn_response.get("result") or {}).get("turn") or {}) if isinstance(turn_response, dict) else {}
            state.turn_id = str(turn.get("id") or state.turn_id or "")
            client.thread_id = state.thread_id
            client.turn_id = state.turn_id
            emit_progress(force=True)

            deadline = started + timeout
            while not state.completed:
                if time.time() > deadline:
                    client.interrupt()
                    return {"ok": False, "error": "Codex app-server call timed out", "reply": state.reply_text(), "sessionId": state.thread_id, "runId": state.turn_id, "providerPath": "app-server", "tools": state.tools(), "thinking": state.thinking(), "approval": state.approval(), "tokenUsage": state.token_usage()}
                msg = client.next_message(timeout=0.5)
                if msg is None:
                    if client.poll() is not None:
                        break
                    continue
                client._handle_or_forward(msg, handle_turn_event)

            # Codex can emit thread/tokenUsage/updated immediately after
            # turn/completed. Drain briefly so the client records official usage.
            usage_deadline = time.time() + 1.0
            while time.time() < usage_deadline:
                msg = client.next_message(timeout=0.2)
                if msg is None:
                    if client.poll() is not None:
                        break
                    continue
                client._handle_or_forward(msg, handle_turn_event)

            emit_progress(force=True)
            reply = state.reply_text()
            error_text = state.error_text()
            ok = state.status in {"completed", "interrupted"} and not (state.status == "completed" and error_text)
            return {
                "ok": ok,
                "reply": reply.strip(),
                "stderr": client.stderr_text(),
                "exitCode": 0 if ok else 1,
                "profile": safe_profile,
                "sessionId": state.thread_id,
                "runId": state.turn_id,
                "tools": state.tools(),
                "thinking": state.thinking(),
                "approval": state.approval(),
                "tokenUsage": state.token_usage(),
                "error": "" if ok else (error_text or f"Codex turn {state.status or 'failed'}"),
                "providerPath": "app-server",
                "interrupted": state.status == "interrupted",
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc), "reply": state.reply_text(), "sessionId": state.thread_id or session_id or "", "runId": state.turn_id, "providerPath": "app-server", "tools": state.tools(), "thinking": state.thinking(), "approval": state.approval(), "tokenUsage": state.token_usage()}
        finally:
            with _ACTIVE_RUNS_LOCK:
                if _ACTIVE_RUNS.get(safe_profile) is client:
                    _ACTIVE_RUNS.pop(safe_profile, None)
            client.close()

    def _send_exec_message(self, profile: str, message: str, session_id: str | None = None, timeout_sec: int | None = None) -> dict[str, Any]:
        if not self.is_available():
            return {"ok": False, "error": f"Codex CLI is not available at {self.binary}", "reply": "", "sessionId": session_id or ""}
        if not message.strip():
            return {"ok": False, "error": "message is required", "reply": "", "sessionId": session_id or ""}

        safe_profile = self._safe_profile_name(profile)
        agent_dir = self._runtime_workspace(safe_profile)
        if not os.path.isdir(agent_dir):
            return {"ok": False, "error": f"Codex agent workspace not found: {agent_dir}", "reply": "", "sessionId": session_id or ""}

        try:
            session_id = safe_session_id(session_id)
        except ValueError as exc:
            return {"ok": False, "error": str(exc), "reply": "", "sessionId": ""}
        prompt = self._delivery_prompt(agent_dir, message, safe_profile)
        cmd = [self.binary, "exec"]
        if session_id:
            cmd.extend(["resume", "--json", "--skip-git-repo-check"])
            if self.model:
                cmd.extend(["-m", self.model])
            if self.effort:
                cmd.extend(["-c", f"model_reasoning_effort={json.dumps(self.effort)}"])
            cmd.extend([session_id, "-"])
        else:
            cmd.extend(["--json", "--skip-git-repo-check", "-C", agent_dir, "--sandbox", self.sandbox])
            if self.model:
                cmd.extend(["-m", self.model])
            if self.effort:
                cmd.extend(["-c", f"model_reasoning_effort={json.dumps(self.effort)}"])
            cmd.append("-")

        try:
            result = self._run(cmd, cwd=agent_dir, stdin=prompt, timeout_sec=int(timeout_sec or self.timeout_sec) + 30)
            parsed = self._parse_exec_json(result.stdout or "")
            stderr = (result.stderr or "").strip()
            reply = parsed.get("reply") or self._fallback_reply(result.stdout or "")
            if result.returncode != 0 and not reply:
                reply = f"[Codex error] {stderr[:1000] or 'Codex request failed'}"
            return {
                "ok": result.returncode == 0,
                "reply": reply.strip(),
                "stderr": stderr[:4000],
                "exitCode": result.returncode,
                "profile": safe_profile,
                "sessionId": parsed.get("sessionId") or session_id or "",
                "tools": parsed.get("tools") or [],
                "thinking": parsed.get("thinking") or "",
                "error": "" if result.returncode == 0 else (stderr[:2000] or "Codex request failed"),
                "providerPath": "exec",
            }
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Codex call timed out", "reply": "", "sessionId": session_id or "", "exitCode": None}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "reply": "", "sessionId": session_id or "", "exitCode": None}

    def _subprocess_env(self) -> dict[str, str]:
        env = agent_env()
        if self.home_path:
            env["CODEX_HOME"] = self.home_path
        return env

    def _run(self, args: list[str], *, cwd: str | None = None, stdin: str | None = None, timeout_sec: int | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args,
            input=stdin,
            capture_output=True,
            text=True,
            timeout=int(timeout_sec or self.timeout_sec),
            env=self._subprocess_env(),
            cwd=cwd or None,
        )

    def _ensure_paths(self) -> None:
        if self.home_path:
            data_owner.makedirs(self.home_path, exist_ok=True)
        if self.workspace_root:
            data_owner.makedirs(self.workspace_root, exist_ok=True)
        if self.main_workspace:
            data_owner.makedirs(self.main_workspace, exist_ok=True)

    def _thread_instructions(self, agent_dir: str, profile: str | None = None) -> str:
        meta = self._load_meta(agent_dir)
        if not meta and profile:
            meta = self._load_native_agent_meta(profile)
        if str((meta or {}).get("source") or "") == "native-main":
            return ""
        name = meta.get("name") or "Codex"
        role = meta.get("role") or "Codex Agent"
        instructions = meta.get("prompt") or meta.get("developer_instructions") or role
        return (
            f"You are {name}, a Virtual Office Codex agent.\n"
            f"Role: {role}\n\n"
            f"Standing instructions:\n{instructions}\n\n"
            "Respond from that persona. When changing files, keep work scoped to this workspace unless explicitly asked otherwise."
        )

    def _delivery_prompt(self, agent_dir: str, message: str, profile: str | None = None) -> str:
        instructions = self._thread_instructions(agent_dir, profile)
        if not instructions:
            return f"User message:\n{message}"
        return f"{instructions}\n\nUser message:\n{message}"

    def _parse_exec_json(self, stdout: str) -> dict[str, Any]:
        session_id = ""
        replies: list[str] = []
        tools: list[dict[str, Any]] = []
        reasoning: list[str] = []
        for raw in stdout.splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            etype = str(event.get("type") or "")
            if etype == "thread.started":
                session_id = str(event.get("thread_id") or event.get("threadId") or session_id)
            item = event.get("item") if isinstance(event.get("item"), dict) else {}
            if not item:
                continue
            itype = str(item.get("type") or "")
            if itype in {"agent_message", "message"}:
                text = item.get("text")
                if text is None and isinstance(item.get("content"), list):
                    text = "\n".join(str(p.get("text") or "") for p in item["content"] if isinstance(p, dict))
                if text:
                    replies.append(str(text))
            elif itype in {"reasoning", "agent_reasoning"}:
                text = item.get("text") or item.get("summary") or ""
                if text:
                    reasoning.append(str(text))
            elif itype in {"command_execution", "tool_call", "mcp_tool_call", "web_search"}:
                tool = self._tool_from_exec_item(item)
                if tool:
                    tools.append(tool)
        return {
            "sessionId": session_id,
            "reply": replies[-1] if replies else "",
            "tools": tools,
            "thinking": "\n".join(reasoning[-4:]),
        }

    def _tool_from_exec_item(self, item: dict[str, Any]) -> dict[str, Any]:
        tool_id = str(item.get("id") or f"codex-tool-{len(str(item))}")
        command = item.get("command") or item.get("name") or item.get("query") or item.get("type") or "tool"
        output = item.get("output") or item.get("result") or item.get("text") or ""
        error = item.get("error") or ""
        status = item.get("status") or ("error" if error else "done")
        return {
            "id": tool_id,
            "name": "codex",
            "status": status,
            "arguments": {"command": command},
            "result": self._limit_text(output),
            "error": self._limit_text(error),
            "source": "codex",
        }

    @staticmethod
    def _fallback_reply(stdout: str) -> str:
        non_json = []
        for raw in stdout.splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                json.loads(raw)
            except json.JSONDecodeError:
                non_json.append(raw)
        return "\n".join(non_json[-20:])

    @staticmethod
    def _limit_text(value: Any, limit: int = 2400) -> str:
        if value is None:
            return ""
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        value = str(value)
        return value if len(value) <= limit else value[:limit] + f"\n\n... [truncated - {len(value)} chars total] ..."

    def _load_meta(self, agent_dir: str) -> dict[str, Any]:
        try:
            with open(os.path.join(agent_dir, "office-agent.json"), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

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
            "id": f"codex-{suffix}",
            "statusKey": f"codex-{suffix}",
            "providerKind": self.provider_kind,
            "providerType": self.provider_type,
            "providerAgentId": profile,
            "profile": profile,
            "name": name or self._display_name(profile),
            "emoji": emoji or "🤖",
            "role": role or "Codex Agent",
            "model": model or self.model or "",
            "provider": "Codex App Server" if self.prefer_app_server else "Codex CLI",
            "workspace": workspace,
            "home": workspace,
            "binary": self.binary,
            "lastActiveAt": last_active,
            "codexSource": source,
            "nativeAgentPath": native_agent_path,
            "capabilities": ["chat", "status", "sessions", "files", "streaming", "interrupt"],
        }

    def _office_agent_dirs(self) -> list[str]:
        dirs: list[str] = []
        seen: set[str] = set()
        if self.workspace_root and os.path.isdir(self.workspace_root):
            for name in sorted(os.listdir(self.workspace_root)):
                agent_dir = os.path.join(self.workspace_root, name)
                if os.path.isdir(agent_dir):
                    real = os.path.abspath(agent_dir)
                    dirs.append(agent_dir)
                    seen.add(real)
        for _profile, agent_dir in sorted(self._load_external_agents().items()):
            if not agent_dir or not os.path.isdir(agent_dir):
                continue
            real = os.path.abspath(agent_dir)
            if real in seen:
                continue
            dirs.append(agent_dir)
            seen.add(real)
        return dirs

    def _discover_native_agents(self, seen_profiles: set[str]) -> list[dict[str, Any]]:
        if not self.include_native_agents:
            return []
        agents_dir = self._native_agents_dir()
        if not agents_dir or not os.path.isdir(agents_dir):
            return []
        agents: list[dict[str, Any]] = []
        for filename in sorted(os.listdir(agents_dir)):
            if not filename.endswith(".toml"):
                continue
            path = os.path.join(agents_dir, filename)
            meta = self._load_native_agent_file(path)
            if not meta:
                continue
            profile = self._safe_profile_name(meta.get("profile") or meta.get("name") or os.path.splitext(filename)[0])
            if not profile or profile in seen_profiles:
                continue
            seen_profiles.add(profile)
            agents.append(self._agent_entry(
                profile=profile,
                name=str(meta.get("name") or self._display_name(profile)),
                emoji=str(meta.get("emoji") or "🤖"),
                role=str(meta.get("description") or meta.get("role") or "Codex Agent"),
                model=str(meta.get("model") or self.model or ""),
                workspace=self._main_workspace(),
                source="native-agent",
                last_active=self._last_active(path),
                native_agent_path=path,
            ))
        return agents

    def _runtime_workspace(self, profile: str) -> str:
        safe_profile = self._safe_profile_name(profile)
        vo_dir = os.path.join(self.workspace_root or "", safe_profile)
        if os.path.isfile(os.path.join(vo_dir, "office-agent.json")):
            return vo_dir
        external_dir = self._external_agent_dir(safe_profile)
        if external_dir and os.path.isfile(os.path.join(external_dir, "office-agent.json")):
            return external_dir
        return self._main_workspace()

    def _profile_exists(self, profile: str) -> bool:
        safe_profile = self._safe_profile_name(profile)
        if safe_profile == "main":
            return True
        for agent_dir in self._office_agent_dirs():
            meta = self._load_meta(agent_dir)
            if self._safe_profile_name(meta.get("profile") or os.path.basename(agent_dir)) == safe_profile:
                return True
        native_path = self._native_agent_file_path(safe_profile)
        if native_path and os.path.isfile(native_path):
            return True
        return False

    def _main_workspace(self) -> str:
        return os.path.expanduser(self.main_workspace or self.workspace_root or os.getcwd())

    def _native_agents_dir(self) -> str:
        if not self.home_path:
            return ""
        return os.path.join(os.path.expanduser(self.home_path), "agents")

    def _native_agent_file_path(self, profile: str) -> str:
        agents_dir = self._native_agents_dir()
        if not agents_dir:
            return ""
        return os.path.join(agents_dir, f"{self._safe_profile_name(profile)}.toml")

    def _is_native_agent_path(self, path: str) -> bool:
        agents_dir = self._native_agents_dir()
        if not agents_dir:
            return False
        return self._path_is_inside(path, agents_dir)

    @staticmethod
    def _path_is_inside(path: str, parent: str) -> bool:
        try:
            return os.path.commonpath([os.path.abspath(parent), os.path.abspath(path)]) == os.path.abspath(parent)
        except ValueError:
            return False

    @staticmethod
    def _resolve_custom_parent(value: str | None) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        return os.path.abspath(os.path.expanduser(raw))

    def _registry_path(self) -> str:
        root = self.workspace_root or self.home_path or os.getcwd()
        return os.path.join(os.path.expanduser(root), "office-codex-agent-registry.json")

    def _load_external_agents(self) -> dict[str, str]:
        path = self._registry_path()
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        agents = data.get("agents") if isinstance(data, dict) else {}
        if not isinstance(agents, dict):
            return {}
        result: dict[str, str] = {}
        for profile, agent_dir in agents.items():
            safe_profile = self._safe_profile_name(profile)
            if safe_profile and isinstance(agent_dir, str) and agent_dir.strip():
                result[safe_profile] = os.path.abspath(os.path.expanduser(agent_dir.strip()))
        return result

    def _save_external_agents(self, agents: dict[str, str]) -> None:
        path = self._registry_path()
        data_owner.makedirs(os.path.dirname(path), exist_ok=True)
        data = {
            "schema": "my-virtual-office.codex-agent-registry.v1",
            "updatedAt": int(time.time()),
            "agents": {self._safe_profile_name(k): os.path.abspath(os.path.expanduser(v)) for k, v in sorted(agents.items()) if k and v},
        }
        self._write_json(path, data)

    @staticmethod
    def _written_files(profile: str) -> list[str]:
        """Files and folders the office creates inside a Codex agent folder."""
        return [
            "IDENTITY.md", "AGENTS.md", ".codex/config.toml", f".codex/agents/{profile}.toml",
            ".codex/agents", ".codex", ".agents/skills", ".agents",
        ]

    def _save_external_agent(self, profile: str, agent_dir: str) -> None:
        agents = self._load_external_agents()
        agents[self._safe_profile_name(profile)] = os.path.abspath(os.path.expanduser(agent_dir))
        self._save_external_agents(agents)

    def _remove_external_agent(self, profile: str) -> None:
        agents = self._load_external_agents()
        safe_profile = self._safe_profile_name(profile)
        if safe_profile not in agents:
            return
        agents.pop(safe_profile, None)
        self._save_external_agents(agents)

    def _external_agent_dir(self, profile: str) -> str:
        return self._load_external_agents().get(self._safe_profile_name(profile), "")

    def _load_native_agent_meta(self, profile: str) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        if safe_profile == "main":
            return {
                "profile": "main",
                "name": "Main",
                "role": "Default Codex agent",
                "description": "Default Codex agent",
                "prompt": "",
                "source": "native-main",
            }
        agents_dir = self._native_agents_dir()
        if not agents_dir or not os.path.isdir(agents_dir):
            return {}
        direct = self._native_agent_file_path(safe_profile)
        candidates = [direct] if direct else []
        candidates.extend(
            os.path.join(agents_dir, name)
            for name in sorted(os.listdir(agents_dir))
            if name.endswith(".toml") and os.path.join(agents_dir, name) != direct
        )
        for path in candidates:
            meta = self._load_native_agent_file(path)
            if not meta:
                continue
            meta_profile = self._safe_profile_name(meta.get("profile") or meta.get("name") or os.path.splitext(os.path.basename(path))[0])
            if meta_profile == safe_profile:
                meta["profile"] = safe_profile
                meta["nativeAgentPath"] = path
                meta["role"] = meta.get("description") or meta.get("role") or "Codex Agent"
                meta["prompt"] = meta.get("developer_instructions") or meta.get("prompt") or ""
                meta["source"] = "native-agent"
                return meta
        return {}

    @staticmethod
    def _load_native_agent_file(path: str) -> dict[str, Any]:
        try:
            with open(path, "rb") as f:
                data = tomllib.load(f)
        except (FileNotFoundError, OSError, tomllib.TOMLDecodeError):
            return {}
        if not isinstance(data, dict):
            return {}
        name = str(data.get("name") or "").strip()
        description = str(data.get("description") or "").strip()
        instructions = str(data.get("developer_instructions") or "").strip()
        if not (name and description and instructions):
            return {}
        return data

    @staticmethod
    def _resolve_binary(value: str | None) -> str:
        # A path that names a folder (set in Settings, the setup wizard or VO_CODEX_BIN) is that file and only that
        # one: a missing one is reported as missing, by its path, never swapped for another codex found on PATH or
        # through the environment (Docker's compose always sets VO_CODEX_BIN=codex). A bare name is looked up.
        chosen = os.path.expanduser(str(value or "").strip())
        if chosen and os.path.basename(chosen) != chosen:
            return chosen
        candidates = [
            value,
            os.environ.get("VO_CODEX_BIN"),
            shutil.which("codex"),
            os.path.expanduser("~/.local/bin/codex"),
        ]
        home = os.environ.get("VO_CODEX_HOME") or os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
        if home:
            candidates.append(os.path.join(os.path.expanduser(home), "packages", "standalone", "current", "bin", "codex"))
        for candidate in candidates:
            if not candidate:
                continue
            expanded = os.path.expanduser(str(candidate))
            resolved = shutil.which(expanded) if os.path.basename(expanded) == expanded else expanded
            if resolved and os.path.isfile(resolved):
                return resolved
        return os.path.expanduser(str(value or os.environ.get("VO_CODEX_BIN") or "codex"))

    @staticmethod
    def _account_status_text(account_result: Any) -> str:
        if not isinstance(account_result, dict):
            return ""
        account = account_result.get("account")
        if isinstance(account, dict):
            account_type = account.get("type") or "authenticated"
            email = account.get("email")
            plan = account.get("planType")
            suffix = " ".join(str(x) for x in [email, plan] if x)
            return f"{account_type} {suffix}".strip()
        if account_result.get("requiresOpenaiAuth") is False:
            return "No OpenAI auth required for configured provider"
        return "Not authenticated"

    @staticmethod
    def _safe_profile_name(value: str | None) -> str:
        raw = str(value or "").strip().lower()
        raw = re.sub(r"[^a-z0-9_.-]+", "-", raw).strip("-._")
        return raw[:64] or "codex-agent"

    @staticmethod
    def _safe_suffix(value: str | None) -> str:
        return re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value or "codex-agent")).strip("-")[:80] or "codex-agent"

    @staticmethod
    def _display_name(profile: str) -> str:
        return str(profile or "codex").replace("-", " ").replace("_", " ").title()

    @staticmethod
    def _last_active(agent_dir: str) -> int:
        if os.path.isfile(agent_dir):
            try:
                return int(os.path.getmtime(agent_dir))
            except OSError:
                return 0
        latest = 0
        try:
            for root, dirs, files in os.walk(agent_dir):
                dirs[:] = [d for d in dirs if d not in {"node_modules", ".git"}]
                for fname in files:
                    latest = max(latest, int(os.path.getmtime(os.path.join(root, fname))))
        except OSError:
            pass
        return latest

    @staticmethod
    def _write_text(path: str, content: str) -> None:
        data_owner.makedirs(os.path.dirname(path), exist_ok=True)
        with data_owner.open_new(path, "w", encoding="utf-8") as f:
            f.write(content)

    @staticmethod
    def _write_json(path: str, data: dict[str, Any]) -> None:
        data_owner.makedirs(os.path.dirname(path), exist_ok=True)
        with data_owner.open_new(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    @staticmethod
    def _toml_string(value: str) -> str:
        return json.dumps(str(value or ""), ensure_ascii=False)

    def _identity_md(self, name: str, role: str, emoji: str) -> str:
        return (
            "# IDENTITY.md\n\n"
            f"- **Name:** {name}\n"
            f"- **Creature:** {role or 'Codex Agent'}\n"
            f"- **Emoji:** {emoji or '🤖'}\n"
        )

    def _agents_md(self, name: str, role: str, instructions: str) -> str:
        return (
            f"# {name}\n\n"
            f"Role: {role or 'Codex Agent'}\n\n"
            "## Standing Instructions\n\n"
            f"{instructions.strip()}\n"
        )

    def _config_toml(self, model: str) -> str:
        lines = []
        if model:
            lines.append(f"model = {self._toml_string(model)}")
        lines.append(f"sandbox_mode = {self._toml_string(self.sandbox)}")
        lines.append(f"approval_policy = {self._toml_string(self.approval_policy)}")
        lines.append("")
        lines.append("[features]")
        lines.append("multi_agent = true")
        return "\n".join(lines) + "\n"

    def _agent_toml(self, profile: str, role: str, instructions: str, model: str) -> str:
        lines = [
            f"name = {self._toml_string(profile)}",
            f"description = {self._toml_string(role or 'Virtual Office Codex agent')}",
            f"developer_instructions = {self._toml_string(instructions)}",
        ]
        if model:
            lines.append(f"model = {self._toml_string(model)}")
        lines.append(f"sandbox_mode = {self._toml_string(self.sandbox)}")
        return "\n".join(lines) + "\n"


class CodexAppServerClient:
    """Small JSON-RPC client for `codex app-server --stdio`."""

    def __init__(self, provider: CodexProvider, cwd: str, timeout_sec: int = 930) -> None:
        self.provider = provider
        self.cwd = cwd
        self.timeout_sec = int(timeout_sec)
        self.thread_id = ""
        self.turn_id = ""
        self.profile = ""
        self.approval_callback: Callable[[dict[str, Any]], None] | None = None
        self._next_id = 1
        self._send_lock = threading.Lock()
        self._approval_lock = threading.Condition()
        self._pending_approvals: dict[str, dict[str, Any]] = {}
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._stderr: list[str] = []
        self._closed = False
        self.proc = subprocess.Popen(
            [provider.binary or "codex", "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=cwd,
            env=provider._subprocess_env(),
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def initialize(self) -> dict[str, Any]:
        response = self.request(
            "initialize",
            {
                "clientInfo": {"name": "my-virtual-office", "version": "1"},
                "capabilities": {"experimentalApi": True},
            },
            timeout_sec=15,
        )
        self.notify("initialized")
        return response

    def request(self, method: str, params: Any | None = None, *, timeout_sec: int | None = None, event_handler: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        request_id = self._allocate_id()
        payload: dict[str, Any] = {"id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)
        deadline = time.time() + int(timeout_sec or self.timeout_sec)
        while time.time() < deadline:
            msg = self.next_message(timeout=0.5)
            if msg is None:
                if self.poll() is not None:
                    raise RuntimeError(self.stderr_text() or "Codex app-server exited")
                continue
            if msg.get("id") == request_id:
                if "error" in msg:
                    raise RuntimeError(self._rpc_error_text(msg.get("error")))
                return msg
            self._handle_or_forward(msg, event_handler)
        raise TimeoutError(f"Timed out waiting for Codex app-server response to {method}")

    def notify(self, method: str, params: Any | None = None) -> None:
        payload: dict[str, Any] = {"method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)

    def next_message(self, timeout: float = 0.5) -> dict[str, Any] | None:
        try:
            msg = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None
        return msg

    def interrupt(self) -> dict[str, Any]:
        if not self.thread_id or not self.turn_id:
            return {"ok": False, "error": "Codex turn id is not known yet."}
        try:
            request_id = self._allocate_id()
            self._send({"id": request_id, "method": "turn/interrupt", "params": {"threadId": self.thread_id, "turnId": self.turn_id}})
            return {"ok": True, "threadId": self.thread_id, "turnId": self.turn_id, "requestId": request_id}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "threadId": self.thread_id, "turnId": self.turn_id}

    def pending_approval(self) -> dict[str, Any]:
        with self._approval_lock:
            pending = [
                item.get("approval")
                for item in self._pending_approvals.values()
                if isinstance(item.get("approval"), dict) and item["approval"].get("status") == "pending"
            ]
        return {"ok": True, "pending": pending[0] if pending else None, "pending_count": len(pending)}

    def respond_approval(self, approval_id: str, choice: str = "cancel") -> dict[str, Any]:
        approval_id = str(approval_id or "").strip()
        normalized_choice = self._normalize_approval_choice(choice)
        if not approval_id:
            return {"ok": False, "error": "approval_id is required"}
        with self._approval_lock:
            entry = self._pending_approvals.get(approval_id)
            if not entry:
                for candidate in self._pending_approvals.values():
                    approval = candidate.get("approval") if isinstance(candidate.get("approval"), dict) else {}
                    if approval_id in {
                        str(approval.get("requestId") or ""),
                        str(approval.get("itemId") or ""),
                        str(approval.get("callbackId") or ""),
                    }:
                        entry = candidate
                        break
            if not entry:
                return {"ok": False, "error": "Codex approval request is no longer pending"}
            response = self._approval_response(entry.get("method") or "", entry.get("params") or {}, normalized_choice)
            resolved = {
                **entry.get("approval", {}),
                "status": "approved" if normalized_choice == "approve" else "cancelled",
                "resolvedAt": int(time.time() * 1000),
                "choice": normalized_choice,
            }
            entry["response"] = response
            entry["choice"] = normalized_choice
            entry["approval"] = resolved
            self._approval_lock.notify_all()
        self._emit_approval(resolved)
        return {"ok": True, "approval": resolved, "choice": normalized_choice, "response": response}

    def poll(self) -> int | None:
        return self.proc.poll()

    def stderr_text(self) -> str:
        return "\n".join(self._stderr[-80:])[:4000]

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with self._approval_lock:
            self._approval_lock.notify_all()
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=3)
        except Exception:
            pass
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                if stream is not None and not stream.closed:
                    stream.close()
            except Exception:
                pass

    def _handle_or_forward(self, msg: dict[str, Any], event_handler: Callable[[dict[str, Any]], None] | None = None) -> None:
        if self.handle_server_request(msg):
            return
        if event_handler:
            event_handler(msg)

    def handle_server_request(self, msg: dict[str, Any]) -> bool:
        if "id" not in msg or not msg.get("method"):
            return False
        method = str(msg.get("method") or "")
        if self._is_approval_request(method):
            # Keep the stream reader free to publish the approval while the
            # JSON-RPC response waits for the browser's decision.
            threading.Thread(
                target=self._answer_server_request,
                args=(msg,),
                daemon=True,
                name=f"codex-approval-{msg.get('id')}",
            ).start()
        else:
            self._answer_server_request(msg)
        return True

    def _answer_server_request(self, msg: dict[str, Any]) -> None:
        request_id = msg.get("id")
        method = str(msg.get("method") or "")
        if request_id is None:
            return
        if self._is_approval_request(method):
            approval = self._approval_from_request(msg)
            result = self._wait_for_approval_response(approval, method, msg.get("params") or {})
            self._send({"id": request_id, "result": result})
        elif method == "item/permissions/requestApproval":
            approval = self._approval_from_request(msg)
            result = self._wait_for_approval_response(approval, method, msg.get("params") or {})
            self._send({"id": request_id, "result": result})
        elif method in {"item/tool/requestUserInput", "mcpServer/elicitation/request"}:
            self._send({"id": request_id, "result": {"answers": {}}})
        else:
            self._send({"id": request_id, "error": {"code": -32601, "message": f"Unsupported Codex server request: {method}"}})

    @staticmethod
    def _is_approval_request(method: str) -> bool:
        return method in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "execCommandApproval",
            "applyPatchApproval",
        }

    def _wait_for_approval_response(self, approval: dict[str, Any], method: str, params: dict[str, Any]) -> dict[str, Any]:
        approval_id = str(approval.get("approval_id") or approval.get("id") or "")
        if not approval_id:
            return self._approval_response(method, params, "cancel")
        entry = {"approval": approval, "method": method, "params": params, "response": None, "choice": ""}
        with self._approval_lock:
            self._pending_approvals[approval_id] = entry
        self._emit_approval(approval)

        deadline = time.time() + max(5, int(self.timeout_sec or 900))
        response = None
        choice = "cancel"
        while time.time() < deadline and not self._closed:
            with self._approval_lock:
                current = self._pending_approvals.get(approval_id)
                if current and current.get("response") is not None:
                    response = current.get("response")
                    choice = str(current.get("choice") or choice)
                    self._pending_approvals.pop(approval_id, None)
                    break
                remaining = max(0.05, min(0.5, deadline - time.time()))
                self._approval_lock.wait(timeout=remaining)
            if self.poll() is not None:
                break

        if response is None:
            response = self._approval_response(method, params, "cancel")
            with self._approval_lock:
                self._pending_approvals.pop(approval_id, None)
            self._emit_approval({
                **approval,
                "status": "cancelled",
                "resolvedAt": int(time.time() * 1000),
                "choice": "cancel",
                "timedOut": True,
            })
        else:
            self._emit_approval({
                **approval,
                "status": "approved" if choice == "approve" else "cancelled",
                "resolvedAt": int(time.time() * 1000),
                "choice": choice,
            })
        return response if isinstance(response, dict) else self._approval_response(method, params, "cancel")

    def _emit_approval(self, approval: dict[str, Any]) -> None:
        if self.approval_callback and isinstance(approval, dict):
            try:
                self.approval_callback(dict(approval))
            except Exception:
                pass

    def approval_from_request(self, msg: dict[str, Any]) -> dict[str, Any]:
        return self._approval_from_request(msg)

    def _approval_from_request(self, msg: dict[str, Any]) -> dict[str, Any]:
        method = str(msg.get("method") or "")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        request_id = msg.get("id")
        thread_id = str(params.get("threadId") or params.get("conversationId") or self.thread_id or "")
        turn_id = str(params.get("turnId") or self.turn_id or "")
        item_id = str(params.get("itemId") or params.get("callId") or "")
        callback_id = str(params.get("approvalId") or "")
        seed = json.dumps(
            {
                "profile": self.profile,
                "method": method,
                "requestId": request_id,
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "callbackId": callback_id,
            },
            sort_keys=True,
        )
        approval_id = "codex-approval-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
        command = self._approval_command_preview(method, params)
        reason = str(params.get("reason") or "").strip()
        kind = "command"
        title = "Codex approval required"
        description = reason or "Codex needs approval before it can continue."
        if method in {"item/commandExecution/requestApproval", "execCommandApproval"}:
            kind = "command"
            title = "Codex command approval required"
            description = reason or "Codex wants to run a command that needs approval."
        elif method in {"item/fileChange/requestApproval", "applyPatchApproval"}:
            kind = "file_change"
            title = "Codex file-change approval required"
            description = reason or "Codex wants to apply file changes that need approval."
        elif method == "item/permissions/requestApproval":
            kind = "permissions"
            title = "Codex permissions approval required"
            description = reason or "Codex is requesting additional permissions for this turn."
        return {
            "id": approval_id,
            "approval_id": approval_id,
            "provider": "codex-app-server",
            "kind": kind,
            "title": title,
            "description": description,
            "command": command,
            "agentId": f"codex-{self.profile}" if self.profile else "codex-default",
            "profile": self.profile,
            "threadId": thread_id,
            "session_id": thread_id,
            "turnId": turn_id,
            "runId": turn_id,
            "itemId": item_id,
            "callbackId": callback_id,
            "requestId": str(request_id),
            "method": method,
            "status": "pending",
            "choices": ["approve", "cancel"],
            "createdAt": int(time.time() * 1000),
        }

    @staticmethod
    def _approval_command_preview(method: str, params: dict[str, Any]) -> str:
        if method in {"item/commandExecution/requestApproval", "execCommandApproval"}:
            command = params.get("command")
            if isinstance(command, list):
                return " ".join(str(x) for x in command)
            if command:
                return str(command)
            actions = params.get("commandActions") or params.get("parsedCmd") or []
            if isinstance(actions, list) and actions:
                return "\n".join(CodexProvider._limit_text(json.dumps(a, ensure_ascii=False)) for a in actions[:5])
            return "Codex command"
        if method in {"item/fileChange/requestApproval", "applyPatchApproval"}:
            if isinstance(params.get("fileChanges"), dict):
                files = list(params["fileChanges"].keys())
                return "\n".join(str(f) for f in files[:40]) or "File changes"
            grant_root = params.get("grantRoot")
            return f"Grant write access under: {grant_root}" if grant_root else "File changes"
        if method == "item/permissions/requestApproval":
            return CodexProvider._limit_text(json.dumps(params.get("permissions") or {}, indent=2, ensure_ascii=False))
        return "Codex approval request"

    @staticmethod
    def _normalize_approval_choice(choice: str) -> str:
        raw = str(choice or "").strip().lower()
        if raw in {"approve", "approved", "accept", "allow", "allow_once", "approve_once", "yes"}:
            return "approve"
        return "cancel"

    @classmethod
    def _approval_response(cls, method: str, params: dict[str, Any], choice: str) -> dict[str, Any]:
        approved = cls._normalize_approval_choice(choice) == "approve"
        if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
            return {"decision": "accept" if approved else "cancel"}
        if method == "item/permissions/requestApproval":
            if approved:
                requested = params.get("permissions") if isinstance(params.get("permissions"), dict) else {}
                granted = {}
                if requested.get("fileSystem") is not None:
                    granted["fileSystem"] = requested.get("fileSystem")
                if requested.get("network") is not None:
                    granted["network"] = requested.get("network")
                return {"permissions": granted, "scope": "turn"}
            return {"permissions": {"fileSystem": None, "network": None}, "scope": "turn"}
        if method in {"execCommandApproval", "applyPatchApproval"}:
            return {"decision": "approved" if approved else "abort"}
        return {"decision": "cancel"}

    def _send(self, payload: dict[str, Any]) -> None:
        if not self.proc.stdin:
            raise RuntimeError("Codex app-server stdin is closed")
        with self._send_lock:
            self.proc.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
            self.proc.stdin.flush()

    def _allocate_id(self) -> int:
        with self._send_lock:
            request_id = self._next_id
            self._next_id += 1
            return request_id

    def _read_stdout(self) -> None:
        if not self.proc.stdout:
            return
        for line in self.proc.stdout:
            raw = line.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
                if isinstance(msg, dict):
                    self._queue.put(msg)
            except json.JSONDecodeError:
                self._stderr.append(raw)

    def _read_stderr(self) -> None:
        if not self.proc.stderr:
            return
        for line in self.proc.stderr:
            text = line.rstrip("\n")
            if text:
                self._stderr.append(text)

    @staticmethod
    def _rpc_error_text(error: Any) -> str:
        if isinstance(error, dict):
            return str(error.get("message") or error)
        return str(error or "Codex app-server request failed")


class CodexAppRunState:
    """Collects Codex app-server notifications into Office chat artifacts."""

    def __init__(self) -> None:
        self.thread_id = ""
        self.turn_id = ""
        self.status = "inProgress"
        self.completed = False
        self._reply_delta = ""
        self._reply_final = ""
        self._reasoning_parts: list[str] = []
        # (one entry per reasoning item, in order: its streamed summary deltas, replaced by the completed item's own
        # summary/content when it comes: the protocol sends both, and appending both showed the thinking twice)
        self._reasoning_items: dict[str, dict[str, Any]] = {}
        self._plan = ""
        self._errors: list[str] = []
        self._tools: dict[str, dict[str, Any]] = {}
        self._tool_order: list[str] = []
        self._approval: dict[str, Any] | None = None
        self._token_usage: dict[str, Any] = {}

    def handle_message(self, msg: dict[str, Any]) -> None:
        method = str(msg.get("method") or "")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if params.get("threadId"):
            self.thread_id = str(params.get("threadId") or self.thread_id)
        if params.get("turnId"):
            self.turn_id = str(params.get("turnId") or self.turn_id)

        if method == "turn/started":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
            self.turn_id = str(turn.get("id") or self.turn_id)
            self.status = str(turn.get("status") or self.status)
        elif method == "item/agentMessage/delta":
            self._reply_delta += str(params.get("delta") or "")
        elif method in {"item/reasoning/summaryTextDelta", "item/reasoning/textDelta"}:
            delta = str(params.get("delta") or "")
            if delta:
                self._reasoning_delta(str(params.get("itemId") or ""), delta,
                                      params.get("summaryIndex", params.get("contentIndex")))
        elif method == "turn/plan/updated":
            plan = params.get("plan") if isinstance(params.get("plan"), list) else []
            lines = []
            for step in plan:
                if isinstance(step, dict):
                    status = str(step.get("status") or "").replace("inProgress", "in progress")
                    lines.append(f"- {step.get('step') or ''} ({status})".strip())
            explanation = params.get("explanation")
            self._plan = "\n".join([str(explanation or "").strip(), *lines]).strip()
        elif method == "thread/tokenUsage/updated":
            token_usage = params.get("tokenUsage") if isinstance(params.get("tokenUsage"), dict) else {}
            if token_usage:
                self._token_usage = token_usage
        elif method in {"item/started", "item/completed"}:
            item = params.get("item") if isinstance(params.get("item"), dict) else {}
            self._handle_item(item, completed=(method == "item/completed"))
        elif method == "item/commandExecution/outputDelta":
            item_id = str(params.get("itemId") or "")
            delta = str(params.get("delta") or "")
            if item_id and delta:
                tool = self._tools.get(item_id)
                if tool:
                    tool["result"] = CodexProvider._limit_text(str(tool.get("result") or "") + delta)
        elif method == "error":
            error = params.get("error") if isinstance(params.get("error"), dict) else {}
            text = error.get("message") or params.get("message") or "Codex turn failed"
            self._errors.append(str(text))
        elif method == "turn/completed":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
            self.turn_id = str(turn.get("id") or self.turn_id)
            self.status = str(turn.get("status") or self.status or "completed")
            if isinstance(turn.get("error"), dict):
                err = turn["error"].get("message")
                if err:
                    self._errors.append(str(err))
            for item in turn.get("items") or []:
                if isinstance(item, dict):
                    self._handle_item(item, completed=True)
            self.completed = True

    def event_from_message(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        method = str(msg.get("method") or "")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        base = {
            "threadId": self.thread_id,
            "sessionId": self.thread_id,
            "turnId": self.turn_id,
            "runId": self.turn_id,
            "reply": self.reply_text(),
            "tools": self.tools(),
            "thinking": self.thinking(),
            "status": self.status,
            "error": self.error_text(),
            "approval": self.approval(),
            "tokenUsage": self.token_usage(),
        }
        if method == "turn/started":
            return {"event": "run.started", **base}
        if method == "item/agentMessage/delta":
            return {"event": "message.delta", **base, "delta": str(params.get("delta") or "")}
        if method in {"item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "turn/plan/updated"}:
            return {"event": "reasoning.available", **base}
        if method == "thread/tokenUsage/updated":
            return {"event": "usage.updated", **base}
        if method in {"item/started", "item/completed"}:
            item = params.get("item") if isinstance(params.get("item"), dict) else {}
            tool = self._tool_from_app_item(item, completed=(method == "item/completed"))
            if tool:
                status = str(tool.get("status") or "")
                event_name = "tool.completed" if status == "done" else "tool.failed" if status == "error" else "tool.started"
                return {
                    "event": event_name,
                    **base,
                    "toolCard": tool,
                    "toolCallId": tool.get("id") or "",
                    "tool": tool.get("name") or "tool",
                    "name": tool.get("name") or "tool",
                    "preview": tool.get("arguments") or {},
                    "output": tool.get("result") or "",
                }
        if method == "item/commandExecution/outputDelta":
            item_id = str(params.get("itemId") or "")
            tool = dict(self._tools.get(item_id) or {})
            if tool:
                return {
                    "event": "tool.updated",
                    **base,
                    "toolCard": tool,
                    "toolCallId": tool.get("id") or item_id,
                    "tool": tool.get("name") or "shell",
                    "name": tool.get("name") or "shell",
                    "delta": str(params.get("delta") or ""),
                    "output": tool.get("result") or "",
                }
        if method == "error":
            return {"event": "run.failed", **base, "error": self.error_text() or "Codex turn failed"}
        if method == "turn/completed":
            ok = self.status in {"completed", "interrupted"} and not (self.status == "completed" and self.error_text())
            event_name = "run.cancelled" if self.status == "interrupted" else "run.completed" if ok else "run.failed"
            return {"event": event_name, **base, "ok": ok}
        return None

    def snapshot(self) -> dict[str, Any]:
        return {
            "threadId": self.thread_id,
            "turnId": self.turn_id,
            "runId": self.turn_id,
            "reply": self.reply_text(),
            "tools": self.tools(),
            "thinking": self.thinking(),
            "status": self.status,
            "error": self.error_text(),
            "approval": self.approval(),
            "tokenUsage": self.token_usage(),
        }

    def reply_text(self) -> str:
        return self._reply_final or self._reply_delta

    def _reasoning_delta(self, item_id: str, delta: str, index: Any = None) -> None:
        entry = self._reasoning_items.get(item_id) if item_id else None
        if entry is None:
            self._reasoning_parts.append(delta)
            if item_id:
                self._reasoning_items[item_id] = {"at": len(self._reasoning_parts) - 1, "index": index}
            return
        sep = "\n\n" if index is not None and entry["index"] is not None and index != entry["index"] else ""
        entry["index"] = index if index is not None else entry["index"]
        self._reasoning_parts[entry["at"]] += sep + delta

    def thinking(self) -> str:
        parts = []
        if self._plan:
            parts.append(self._plan)
        reasoning = "".join(self._reasoning_parts).strip()
        if reasoning:
            parts.append(reasoning)
        return "\n\n".join(parts)[:12000]

    def tools(self) -> list[dict[str, Any]]:
        return [self._tools[k] for k in self._tool_order if k in self._tools][-60:]

    def approval(self) -> dict[str, Any] | None:
        return dict(self._approval) if isinstance(self._approval, dict) else None

    def set_approval(self, approval: dict[str, Any] | None) -> None:
        self._approval = dict(approval) if isinstance(approval, dict) else None

    def token_usage(self) -> dict[str, Any]:
        return dict(self._token_usage) if isinstance(self._token_usage, dict) else {}

    def error_text(self) -> str:
        return "\n".join(dict.fromkeys([e for e in self._errors if e]))[:2000]

    def _handle_item(self, item: dict[str, Any], completed: bool = False) -> None:
        item_type = str(item.get("type") or "")
        if item_type == "agentMessage":
            text = str(item.get("text") or "")
            if text:
                self._reply_final = text
            return
        if item_type == "reasoning":
            parts = [p for p in (item.get("summary") or []) + (item.get("content") or []) if isinstance(p, str) and p.strip()]
            if not parts:
                return
            text = "\n\n".join(parts)
            entry = self._reasoning_items.get(str(item.get("id") or ""))
            if entry is not None:
                self._reasoning_parts[entry["at"]] = text
            else:
                self._reasoning_parts.append(text)
                if item.get("id"):
                    self._reasoning_items[str(item["id"])] = {"at": len(self._reasoning_parts) - 1, "index": None}
            return

        tool = self._tool_from_app_item(item, completed=completed)
        if not tool:
            return
        tool_id = tool["id"]
        if tool_id not in self._tools:
            self._tool_order.append(tool_id)
        existing = self._tools.get(tool_id, {})
        existing.update({k: v for k, v in tool.items() if v not in (None, "") or k not in existing})
        self._tools[tool_id] = existing

    def _tool_from_app_item(self, item: dict[str, Any], completed: bool = False) -> dict[str, Any] | None:
        item_type = str(item.get("type") or "")
        item_id = str(item.get("id") or f"codex-{len(self._tools) + 1}")
        status = self._normalize_status(item.get("status"), completed)
        if item_type == "commandExecution":
            return {
                "id": item_id,
                "name": "shell",
                "status": status,
                "arguments": {"command": item.get("command") or "", "cwd": item.get("cwd") or ""},
                "result": CodexProvider._limit_text(item.get("aggregatedOutput") or ""),
                "error": "" if status != "error" else CodexProvider._limit_text(item.get("aggregatedOutput") or ""),
                "source": "codex",
            }
        if item_type == "fileChange":
            changes = item.get("changes") if isinstance(item.get("changes"), list) else []
            paths = []
            for change in changes:
                if isinstance(change, dict):
                    paths.append(str(change.get("path") or change.get("file") or change.get("uri") or "file"))
            return {
                "id": item_id,
                "name": "file changes",
                "status": status,
                "arguments": {"files": paths[:20], "count": len(changes)},
                "result": f"{len(changes)} file change(s)" if changes else "",
                "error": "",
                "source": "codex",
            }
        if item_type == "mcpToolCall":
            error = item.get("error")
            return {
                "id": item_id,
                "name": ".".join(x for x in [str(item.get("server") or ""), str(item.get("tool") or "mcp")] if x),
                "status": "error" if error else status,
                "arguments": item.get("arguments") or {},
                "result": CodexProvider._limit_text(item.get("result") or ""),
                "error": CodexProvider._limit_text(error or ""),
                "source": "codex",
            }
        if item_type == "dynamicToolCall":
            return {
                "id": item_id,
                "name": item.get("tool") or "tool",
                "status": status,
                "arguments": item.get("arguments") or {},
                "result": CodexProvider._limit_text(item.get("contentItems") or ""),
                "error": "" if item.get("success") is not False else "Tool call failed",
                "source": "codex",
            }
        if item_type == "webSearch":
            return {
                "id": item_id,
                "name": "web search",
                "status": status,
                "arguments": {"query": item.get("query") or ""},
                "result": CodexProvider._limit_text(item.get("action") or ""),
                "error": "",
                "source": "codex",
            }
        return None

    @staticmethod
    def _normalize_status(value: Any, completed: bool) -> str:
        raw = str(value or "").lower()
        if raw in {"completed", "done", "success", "succeeded"}:
            return "done"
        if raw in {"failed", "error", "declined"}:
            return "error"
        if completed:
            return "done"
        return "running"


class CodexAppStreamRun:
    """Reads one live Codex app-server turn as normalized stream events."""

    def __init__(
        self,
        *,
        provider: CodexProvider,
        profile: str,
        client: CodexAppServerClient,
        state: CodexAppRunState,
        timeout_sec: int,
        buffered_events: list[dict[str, Any]] | None = None,
    ) -> None:
        self.provider = provider
        self.profile = profile
        self.client = client
        self.state = state
        self.timeout_sec = int(timeout_sec)
        self.started_at = time.time()
        self._buffered_events = list(buffered_events or [])
        self._closed = False
        self._timeout_emitted = False

    @property
    def thread_id(self) -> str:
        return self.state.thread_id

    @property
    def turn_id(self) -> str:
        return self.state.turn_id

    def next_event(self, timeout: float = 0.5) -> dict[str, Any] | None:
        if self._buffered_events:
            return self._buffered_events.pop(0)
        if self.state.completed:
            return None
        if time.time() > self.started_at + self.timeout_sec:
            if not self._timeout_emitted:
                self._timeout_emitted = True
                self.client.interrupt()
                self.state.status = "failed"
                self.state.completed = True
                self.state._errors.append("Codex app-server call timed out")
                return {"event": "run.failed", **self.state.snapshot(), "ok": False}
            return None

        msg = self.client.next_message(timeout=timeout)
        if msg is None:
            if self.client.poll() is not None:
                stderr = self.client.stderr_text()
                self.state.status = "failed"
                self.state.completed = True
                if stderr:
                    self.state._errors.append(stderr)
                return {"event": "run.failed", **self.state.snapshot(), "ok": False}
            return None
        if self.client.handle_server_request(msg):
            return self._event_from_server_request(msg)
        self.state.handle_message(msg)
        return self.state.event_from_message(msg)

    def snapshot(self) -> dict[str, Any]:
        return self.state.snapshot()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with _ACTIVE_RUNS_LOCK:
            if _ACTIVE_RUNS.get(self.profile) is self.client:
                _ACTIVE_RUNS.pop(self.profile, None)
        self.client.close()

    def _event_from_server_request(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        method = str(msg.get("method") or "")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        if self.client._is_approval_request(method):
            approval = self.client.approval_from_request(msg)
            self.state.set_approval(approval)
            return {"event": "approval.request", **self.state.snapshot(), "approval": approval}
        if method in {"item/tool/requestUserInput", "mcpServer/elicitation/request"}:
            return {
                "event": "approval.request",
                "approval": {
                    "id": str(msg.get("id") or ""),
                    "kind": method,
                    "title": item.get("title") or params.get("title") or "Codex input requested",
                    "description": item.get("description") or params.get("message") or "",
                    "status": "auto-answered",
                },
            }
        return None
