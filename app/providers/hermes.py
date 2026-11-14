"""Hermes provider adapter for My Virtual Office.

The supported Virtual Office integration is the authenticated Hermes API
Server. Hermes itself owns profiles, processes, sessions, tools, and terminal
execution in its native environment; Virtual Office is only an external API
client. The local CLI profile helpers (HermesProvider) stay for the native
runtime; the Hermes Desktop backend client and its discovery were removed
(``hermes serve`` connections are found by POST /api/agent-providers/detect).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from urllib.parse import quote, urljoin
from typing import Any

from .file_safety import backup_files
from .cli_runner import argv_message, safe_session_id
from .process_env import agent_env
import data_owner   # (folders and files made as root keep the data folder's owner)


@dataclass
class HermesProvider:
    """Provider adapter for local Hermes Agent profiles."""

    home_path: str | None = None
    binary: str | None = None
    enabled: bool = True
    timeout_sec: int = 600

    provider_kind: str = "hermes"
    provider_type: str = "runtime"

    def __post_init__(self) -> None:
        self.binary = os.path.expanduser(
            self.binary
            or os.environ.get("VO_HERMES_BIN")
            or shutil.which("hermes")
            or "~/.local/bin/hermes"
        )
        if self.binary and not os.path.isabs(self.binary):
            self.binary = shutil.which(self.binary) or self.binary
        self.home_path = os.path.expanduser(
            self.home_path
            or os.environ.get("VO_HERMES_HOME")
            or "~/.hermes"
        )

    def _binary_problem(self) -> str:
        if not self.binary:
            return "Hermes CLI is not configured"
        if not os.path.exists(self.binary):
            return f"Hermes CLI not found at {self.binary}"
        if not os.path.isfile(self.binary):
            return f"Hermes CLI path is not a file: {self.binary}"
        if not os.access(self.binary, os.X_OK):
            return f"Hermes CLI is not executable inside the Linux container: {self.binary}"
        if str(self.binary).lower().endswith((".exe", ".cmd", ".bat", ".ps1")):
            return "A Windows Hermes launcher cannot run inside the Linux container; use the authenticated Hermes API"
        try:
            with open(self.binary, "rb") as handle:
                if handle.read(2) == b"MZ":
                    return "A Windows Hermes executable cannot run inside the Linux container; use the authenticated Hermes API"
        except OSError as exc:
            return f"Hermes CLI cannot be read: {exc}"
        return ""

    def is_available(self) -> bool:
        return bool(self.enabled and not self._binary_problem() and self.home_path and os.path.isdir(self.home_path))

    @classmethod
    def inspect_mounted_profile(
        cls,
        profile: str,
        *,
        data_root: str | None = None,
        profile_path: str | None = None,
        access: str = "read-write",
    ) -> dict[str, Any]:
        """Inspect an explicitly mounted Hermes profile independently of the CLI."""
        requested_access = str(access or "read-write").strip().lower()
        if requested_access not in {"disabled", "read-only", "read-write"}:
            requested_access = "read-write"
        result: dict[str, Any] = {
            "available": False,
            "readable": False,
            "writable": False,
            "path": "",
            "access": requested_access,
            "requestedAccess": requested_access,
            "source": "explicit-profile" if str(profile_path or "").strip() else "data-root",
            "reason": "",
        }
        if requested_access == "disabled":
            result["reason"] = "Mounted Hermes profile resources are disabled for this connection."
            return result

        raw_profile = str(profile or "default").strip() or "default"
        raw_path = str(profile_path or "").strip()
        raw_root = str(data_root or "").strip()
        configured = raw_path or raw_root
        if not configured:
            result["reason"] = "No Hermes profile data directory is configured."
            return result
        if re.match(r"^[A-Za-z]:[\\/]", configured) or configured.startswith("\\\\"):
            result["reason"] = "The Hermes profile path must be visible inside the Linux server or container."
            return result
        configured = os.path.expanduser(configured)
        if not os.path.isabs(configured):
            result["reason"] = "The Hermes profile path must be an absolute server/container path."
            return result

        if raw_path:
            candidate = os.path.abspath(configured)
        else:
            root = os.path.abspath(configured)
            if raw_profile == "default":
                candidate = root
            else:
                if (
                    raw_profile in {".", ".."}
                    or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", raw_profile)
                    or cls._safe_suffix(raw_profile) != raw_profile
                ):
                    result["reason"] = "The Hermes profile id cannot be mapped safely below the data root."
                    return result
                candidate = os.path.abspath(os.path.join(root, "profiles", raw_profile))
                try:
                    if os.path.commonpath([root, candidate]) != root:
                        result["reason"] = "The Hermes profile path escapes the configured data root."
                        return result
                    if os.path.exists(candidate) and os.path.commonpath([
                        os.path.realpath(root), os.path.realpath(candidate)
                    ]) != os.path.realpath(root):
                        result["reason"] = "The Hermes profile directory resolves outside the configured data root."
                        return result
                except ValueError:
                    result["reason"] = "The Hermes profile path is incompatible with the configured data root."
                    return result

        result["path"] = candidate
        if not os.path.isdir(candidate):
            result["reason"] = "The mounted Hermes profile directory was not found inside Virtual Office."
            return result
        if not os.access(candidate, os.R_OK | os.X_OK):
            result["reason"] = "The mounted Hermes profile directory is not readable by Virtual Office."
            return result

        result["available"] = True
        result["readable"] = True
        try:
            volume_read_only = bool(os.statvfs(candidate).f_flag & getattr(os, "ST_RDONLY", 1))
        except OSError:
            volume_read_only = True
        result["writable"] = bool(
            requested_access == "read-write"
            and not volume_read_only
            and os.access(candidate, os.W_OK | os.X_OK)
        )
        if not result["writable"]:
            result["access"] = "read-only"
        if requested_access == "read-only":
            result["reason"] = "The mounted Hermes profile is configured for read-only access."
        elif volume_read_only:
            result["reason"] = "The mounted Hermes profile filesystem is read-only."
        elif not result["writable"]:
            result["reason"] = "The mounted Hermes profile is readable but not writable by Virtual Office."
        return result

    @staticmethod
    def _atomic_owned_text(path: str, content: str, profile_home: str) -> None:
        data_owner.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            reference = os.stat(path)
        except OSError:
            reference = os.stat(profile_home)
        tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                try:
                    os.fchmod(handle.fileno(), reference.st_mode & 0o777)
                    os.fchown(handle.fileno(), reference.st_uid, reference.st_gid)
                except OSError:
                    pass
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        finally:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass

    def _subprocess_env(self) -> dict[str, str]:
        """Environment for Hermes CLI calls.

        Containers commonly run as root, where `~` would resolve to /root and
        Hermes would accidentally inspect/create /root/.hermes. When the user
        configured a Hermes home path, derive HOME from it so Hermes resolves
        its own profile paths consistently with the configured installation.
        """
        env = agent_env()
        if self.home_path:
            env["VO_HERMES_HOME"] = self.home_path
            if os.path.basename(self.home_path.rstrip(os.sep)) == ".hermes":
                env["HOME"] = os.path.dirname(self.home_path.rstrip(os.sep)) or env.get("HOME", "")
        return env

    def discover_agents(self) -> list[dict[str, Any]]:
        """Return Hermes profiles as normalized OfficeAgent-like dictionaries."""
        if not self.is_available():
            return []

        profiles = self._list_profiles() or [{"profile": "default", "model": "", "gateway": ""}]
        agents: list[dict[str, Any]] = []
        for item in profiles:
            profile = item.get("profile") or "default"
            details = self._show_profile(profile)
            model = details.get("model") or item.get("model") or ""
            provider = details.get("provider") or ""
            gateway = details.get("gateway") or item.get("gateway") or ""
            profile_home = details.get("path") or (
                self.home_path if profile == "default" else os.path.join(self.home_path or "", "profiles", profile)
            )
            scan_home = profile_home if os.path.isdir(profile_home) else (self.home_path or "")
            identity = self._read_identity(profile_home)
            suffix = self._safe_suffix(profile)
            agents.append({
                "id": f"hermes-{suffix}",
                "statusKey": f"hermes-{suffix}",
                "providerKind": self.provider_kind,
                "providerType": self.provider_type,
                "providerAgentId": profile,
                "profile": profile,
                "name": identity.get("name") or self._display_name(profile),
                "emoji": identity.get("emoji") or os.environ.get("VO_HERMES_AGENT_EMOJI", "⚕️"),
                "role": identity.get("role") or "Hermes Agent",
                "model": model,
                "provider": provider,
                "gateway": gateway,
                "workspace": profile_home,
                "home": profile_home,
                "binary": self.binary,
                "lastActiveAt": self._last_active(scan_home),
                "capabilities": ["chat", "status", "sessions"],
                "connectionModes": ["cli"],
                "cliAvailable": True,
                "apiAvailable": False,
            })
        return agents

    def test(self) -> dict[str, Any]:
        """Check whether Hermes is reachable and return discovered profiles."""
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}", "agents": []}
        if not self.home_path or not os.path.isdir(self.home_path):
            return {"ok": False, "error": f"Hermes home not found at {self.home_path}", "agents": []}
        try:
            return {"ok": True, "binary": self.binary, "homePath": self.home_path, "agents": self.discover_agents()}
        except Exception as exc:  # defensive: test endpoint should not crash server
            return {"ok": False, "error": str(exc), "agents": []}

    def send_message(self, profile: str, message: str, timeout_sec: int | None = None) -> dict[str, Any]:
        """Send a one-shot message to Hermes and return stdout as the reply."""
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}", "exitCode": None, "reply": ""}
        if not message.strip():
            return {"ok": False, "error": "message is required", "exitCode": None, "reply": ""}

        try:
            prompt = argv_message(message)
        except ValueError as exc:
            return {"ok": False, "error": str(exc), "exitCode": None, "reply": ""}
        cmd = [self.binary]
        if profile and profile != "default":
            cmd.extend(["--profile", profile])
        cmd.extend(["-z", prompt])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=int(timeout_sec or self.timeout_sec) + 30,
                env=self._subprocess_env(),
            )
            reply = (result.stdout or "").strip()
            stderr = (result.stderr or "").strip()
            if result.returncode != 0 and not reply:
                reply = f"[Hermes error] {stderr[:1000]}"
            return {
                "ok": result.returncode == 0,
                "reply": reply,
                "stderr": stderr[:2000],
                "exitCode": result.returncode,
                "profile": profile or "default",
            }
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Hermes call timed out", "exitCode": None, "reply": ""}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "exitCode": None, "reply": ""}

    def send_chat_message(
        self,
        profile: str,
        message: str,
        session_id: str | None = None,
        timeout_sec: int | None = None,
        yolo_once: bool = False,
        on_progress: Any = None,
        files: list[str] | None = None,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        """Send a message through Hermes chat, optionally resuming a session.

        Unlike ``send_message``/``hermes -z``, this uses the public
        ``hermes chat -Q -q`` surface so Virtual Office can keep real Hermes
        session continuity by storing the returned ``session_id`` and passing it
        back with ``--resume`` on later turns.
        """
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}", "exitCode": None, "reply": "", "sessionId": session_id or ""}
        if not message.strip():
            return {"ok": False, "error": "message is required", "exitCode": None, "reply": "", "sessionId": session_id or ""}

        try:
            session_id = safe_session_id(session_id)
            prompt = argv_message(message)
        except ValueError as exc:
            return {"ok": False, "error": str(exc), "exitCode": None, "reply": ""}
        cmd = [self.binary]
        if profile and profile != "default":
            cmd.extend(["--profile", profile])
        cmd.extend(["chat", "-Q"])
        if session_id:
            cmd.extend(["--resume", session_id])
        if yolo_once:
            cmd.append("--yolo")
        cmd.extend(["-q", prompt])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=int(timeout_sec or self.timeout_sec) + 30,
                env=self._subprocess_env(),
            )
            stdout = (result.stdout or "").strip()
            stderr = (result.stderr or "").strip()
            found_session_id = session_id or ""
            reply_lines: list[str] = []
            for line in stdout.splitlines():
                m = re.match(r"^\s*session_id:\s*(\S+)\s*$", line)
                if m:
                    found_session_id = m.group(1).strip()
                elif "tirith security scanner enabled but not available" in line.lower():
                    continue
                else:
                    reply_lines.append(line)
            for line in stderr.splitlines():
                m = re.match(r"^\s*session_id:\s*(\S+)\s*$", line)
                if m:
                    found_session_id = m.group(1).strip()
            reply = "\n".join(reply_lines).strip()
            if result.returncode != 0 and not reply:
                reply = f"[Hermes error] {stderr[:1000]}"
            outcome = {
                "ok": result.returncode == 0,
                "reply": reply,
                "stderr": stderr[:2000],
                "exitCode": result.returncode,
                "profile": profile or "default",
                "sessionId": found_session_id,
            }
            # The legacy Hermes CLI is buffered, but it still participates in
            # the universal SDK event contract. API-connected Hermes agents
            # provide true token/tool progress through HermesOfficeProvider.
            if callable(on_progress):
                on_progress(outcome)
            return outcome
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Hermes call timed out", "exitCode": None, "reply": "", "sessionId": session_id or ""}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "exitCode": None, "reply": "", "sessionId": session_id or ""}

    def list_sessions(self, profile: str, limit: int = 40, timeout_sec: int = 30) -> dict[str, Any]:
        """List recent Hermes sessions through the public sessions CLI."""
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}", "sessions": []}
        cmd = [self.binary]
        if profile and profile != "default":
            cmd.extend(["--profile", profile])
        cmd.extend(["sessions", "list", "--limit", str(max(1, int(limit)))])
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=int(timeout_sec), env=self._subprocess_env())
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Hermes sessions list timed out", "sessions": []}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "sessions": []}
        if result.returncode != 0:
            return {"ok": False, "error": (result.stderr or result.stdout or "Hermes sessions list failed").strip()[:1000], "sessions": []}

        sessions: list[dict[str, Any]] = []
        past_header = False
        for line in (result.stdout or "").splitlines():
            stripped = line.rstrip()
            if not stripped:
                continue
            if set(stripped.strip()) <= {"\u2500", "-", "="}:
                past_header = True
                continue
            if not past_header:
                continue
            parts = stripped.split()
            if not parts:
                continue
            session_id = parts[-1]
            if not re.match(r"^[A-Za-z0-9_.:-]+$", session_id):
                continue
            columns = re.split(r"\s{2,}", stripped)
            title = columns[0].strip() if columns else ""
            preview = columns[1].strip() if len(columns) > 2 else ""
            last_active = columns[-2].strip() if len(columns) >= 3 else ""
            sessions.append({
                "id": session_id,
                "title": title[:200],
                "preview": preview[:300],
                "lastActive": last_active[:60],
            })
        return {"ok": True, "sessions": sessions, "profile": profile or "default"}

    def export_session(self, profile: str, session_id: str, timeout_sec: int = 30) -> dict[str, Any]:
        """Export one Hermes session through the public CLI JSONL surface."""
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}", "session": None}
        if not session_id:
            return {"ok": False, "error": "session_id is required", "session": None}

        cmd = [self.binary]
        if profile and profile != "default":
            cmd.extend(["--profile", profile])
        cmd.extend(["sessions", "export", "--session-id", session_id, "-"])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=int(timeout_sec),
                env=self._subprocess_env(),
            )
            if result.returncode != 0:
                return {"ok": False, "error": (result.stderr or result.stdout or "Hermes session export failed").strip()[:2000], "session": None}
            sessions: list[dict[str, Any]] = []
            for raw in (result.stdout or "").splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    item = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict):
                    sessions.append(item)
            session = next((s for s in sessions if str(s.get("id") or "") == str(session_id)), sessions[0] if sessions else None)
            return {"ok": bool(session), "session": session, "error": "" if session else "session not found in export"}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Hermes session export timed out", "session": None}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "session": None}

    def create_agent(self, name: str, role: str = "Hermes Agent", model: str | None = None, emoji: str = "⚕️", profile: str | None = None) -> dict[str, Any]:
        """Create a Hermes profile that Virtual Office treats as an agent.

        Hermes' public abstraction for isolated agents is a profile. We create
        profiles through the CLI, then write only non-secret bootstrap files
        into the profile directory for display and behavior guidance.
        """
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}"}
        if not self.home_path or not os.path.isdir(self.home_path):
            return {"ok": False, "error": f"Hermes home not found at {self.home_path}"}

        safe_profile = self._safe_profile_name(profile or name)
        if safe_profile == "default":
            return {"ok": False, "error": "Cannot create or overwrite the default Hermes profile"}
        if any(a.get("profile") == safe_profile for a in self.discover_agents()):
            return {"ok": False, "error": f"Hermes profile '{safe_profile}' already exists"}

        description = (role or "Hermes Agent").strip()[:500]
        cmd = [
            self.binary,
            "profile",
            "create",
            safe_profile,
            "--clone",
            "--clone-from",
            "default",
            "--no-alias",
            "--description",
            description,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=self._subprocess_env())
        if result.returncode != 0:
            # Some Hermes installs may not support clone flags. Fall back to the
            # basic public create command instead of guessing internal files.
            fallback = subprocess.run(
                [self.binary, "profile", "create", safe_profile, "--no-alias", "--description", description],
                capture_output=True,
                text=True,
                timeout=60,
                env=self._subprocess_env(),
            )
            if fallback.returncode != 0:
                return {
                    "ok": False,
                    "error": (fallback.stderr or fallback.stdout or result.stderr or result.stdout or "Hermes profile create failed").strip()[:2000],
                    "exitCode": fallback.returncode,
                }

        if model and str(model).strip():
            # Best-effort: installed Hermes versions may use different model
            # config keys. Creation should still succeed even if this fails.
            subprocess.run(
                [self.binary, "--profile", safe_profile, "config", "set", "model.default", str(model).strip()],
                capture_output=True,
                text=True,
                timeout=30,
                env=self._subprocess_env(),
            )

        profile_home = os.path.join(self.home_path, "profiles", safe_profile)
        data_owner.makedirs(profile_home, exist_ok=True)
        data_owner.makedirs(os.path.join(profile_home, "skills"), exist_ok=True)
        self._write_profile_bootstrap(profile_home, name=name, role=role, emoji=emoji, profile=safe_profile)
        self._chown_like_home(profile_home)

        return {
            "ok": True,
            "profile": safe_profile,
            "agentId": f"hermes-{safe_profile}",
            "name": name,
            "workspace": profile_home,
            "message": f"Hermes profile '{safe_profile}' created successfully",
        }

    def update_profile_at_home(self, profile_home: str, profile: str, patch: dict[str, Any]) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        if not os.path.isdir(profile_home):
            return {"ok": False, "error": f"Hermes profile '{safe_profile}' was not found"}
        identity_path = os.path.join(profile_home, "IDENTITY.md")
        agents_path = os.path.join(profile_home, "AGENTS.md")
        backup_id, backups = backup_files(profile_home, [identity_path, agents_path])
        current = {"name": safe_profile.replace("-", " ").title(), "role": "Hermes Agent", "emoji": "⚕️"}
        try:
            text = open(identity_path, "r", encoding="utf-8", errors="replace").read()
            for key, label in (("name", "Name"), ("role", "Creature"), ("emoji", "Emoji")):
                match = re.search(rf"(?im)^\s*-\s*\*\*{label}:\*\*\s*(.+)$", text)
                if match:
                    current[key] = match.group(1).split(" — Hermes profile", 1)[0].strip()
        except OSError:
            pass
        for key in current:
            if key in patch:
                current[key] = re.sub(r"[\r\n]+", " ", str(patch.get(key) or "")).strip()
        self._atomic_owned_text(
            identity_path,
            "# IDENTITY.md\n\n"
            f"- **Name:** {current['name']}\n"
            f"- **Creature:** {current['role']} — Hermes profile\n"
            "- **Vibe:** Helpful, direct, ready to work\n"
            f"- **Emoji:** {current['emoji']}\n",
            profile_home,
        )
        changed = ["IDENTITY.md"]
        if "instructions" in patch:
            self._atomic_owned_text(agents_path, str(patch.get("instructions") or ""), profile_home)
            changed.append("AGENTS.md")
        if "role" in patch and safe_profile != "default" and not self._binary_problem():
            subprocess.run(
                [self.binary, "profile", "describe", safe_profile, "--text", str(current["role"])[:500]],
                capture_output=True,
                text=True,
                timeout=30,
                env=self._subprocess_env(),
            )
        return {"ok": True, "profile": safe_profile, "changed": changed, "backupId": backup_id, "backups": backups}

    def update_profile(self, profile: str, patch: dict[str, Any]) -> dict[str, Any]:
        safe_profile = self._safe_profile_name(profile)
        profile_home = self.home_path if safe_profile == "default" else os.path.join(self.home_path or "", "profiles", safe_profile)
        return self.update_profile_at_home(profile_home or "", safe_profile, patch)

    def delete_agent(self, profile: str) -> dict[str, Any]:
        """Delete a Hermes profile through the public CLI."""
        safe_profile = self._safe_profile_name(profile)
        if safe_profile == "default":
            return {"ok": False, "error": "Cannot delete the default Hermes profile"}
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}"}

        result = subprocess.run(
            [self.binary, "profile", "delete", safe_profile, "--yes"],
            capture_output=True,
            text=True,
            timeout=60,
            env=self._subprocess_env(),
        )
        return {
            "ok": result.returncode == 0,
            "deleted": result.returncode == 0,
            "profile": safe_profile,
            "agentId": f"hermes-{safe_profile}",
            "stdout": (result.stdout or "").strip()[:1000],
            "stderr": (result.stderr or "").strip()[:1000],
            "error": "" if result.returncode == 0 else ((result.stderr or result.stdout or "Hermes profile delete failed").strip()[:1000]),
            "exitCode": result.returncode,
        }

    def delete_session(self, profile: str, session_id: str) -> dict[str, Any]:
        """Delete a Hermes session through the public sessions CLI."""
        if not session_id:
            return {"ok": True, "deleted": False}
        if not self.binary or not os.path.exists(self.binary):
            return {"ok": False, "error": f"Hermes CLI not found at {self.binary}"}
        cmd = [self.binary]
        if profile and profile != "default":
            cmd.extend(["--profile", profile])
        cmd.extend(["sessions", "delete", session_id, "--yes"])
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=self._subprocess_env())
            return {
                "ok": result.returncode == 0,
                "deleted": result.returncode == 0,
                "stdout": (result.stdout or "").strip()[:1000],
                "stderr": (result.stderr or "").strip()[:1000],
                "exitCode": result.returncode,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _list_profiles(self) -> list[dict[str, str]]:
        profiles: list[dict[str, str]] = []
        try:
            result = subprocess.run([self.binary or "hermes", "profile", "list"], capture_output=True, text=True, timeout=15, env=self._subprocess_env())
            if result.returncode != 0:
                return profiles
            for line in (result.stdout or "").splitlines():
                clean = line.strip()
                if not clean or clean.startswith("Profile") or clean.startswith("─"):
                    continue
                clean = clean.replace("◆", " ").strip()
                parts = clean.split()
                if not parts:
                    continue
                profile = parts[0].strip()
                if not profile or profile in {"—", "-"}:
                    continue
                profiles.append({
                    "profile": profile,
                    "model": parts[1].strip() if len(parts) > 1 else "",
                    "gateway": parts[2].strip() if len(parts) > 2 else "",
                })
        except Exception:
            pass
        return profiles

    def _show_profile(self, profile: str) -> dict[str, str]:
        details: dict[str, str] = {}
        try:
            cmd = [self.binary or "hermes"]
            if profile != "default":
                cmd.extend(["--profile", profile])
            cmd.extend(["profile", "show", profile])
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15, env=self._subprocess_env())
            text = (result.stdout or "") + "\n" + (result.stderr or "")
            for line in text.splitlines():
                clean = line.strip(" │\t")
                if clean.startswith("Path:"):
                    details["path"] = clean.split(":", 1)[1].strip()
                elif clean.startswith("Model:"):
                    value = clean.split(":", 1)[1].strip()
                    m = re.match(r"(.+?)\s*\((.+?)\)\s*$", value)
                    if m:
                        details["model"] = m.group(1).strip()
                        details["provider"] = m.group(2).strip()
                    else:
                        details["model"] = value
                elif clean.startswith("Gateway:"):
                    details["gateway"] = clean.split(":", 1)[1].strip()
        except Exception:
            pass
        return details

    @staticmethod
    def _safe_suffix(profile: str) -> str:
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "-", profile or "default").strip("-.")
        return safe or "default"

    @staticmethod
    def _safe_profile_name(value: str) -> str:
        safe = re.sub(r"[^a-z0-9_-]+", "-", (value or "").lower().strip()).strip("-_")
        safe = re.sub(r"[-_]{2,}", "-", safe)
        return (safe or f"agent-{int(time.time())}")[:63]

    def _write_profile_bootstrap(self, profile_home: str, *, name: str, role: str, emoji: str, profile: str) -> None:
        files = {
            "IDENTITY.md": f"""# IDENTITY.md

- **Name:** {name}
- **Creature:** {role} — Hermes profile
- **Vibe:** Helpful, direct, ready to work
- **Emoji:** {emoji}
""",
            "SOUL.md": f"""# SOUL.md — {name}

You are **{name}** {emoji} — {role}.

## Style
- Be helpful and direct
- Keep work visible through Virtual Office when possible
- Use your Hermes profile `{profile}` for isolated context
""",
            "AGENTS.md": f"""# {name} {emoji} — {role}

## Role
{role}

## Core Rules
- Follow instructions carefully
- Keep replies concise and useful
- Do not expose secrets from your Hermes profile

## Memory
- Use Hermes profile memory and sessions normally.
""",
            "MEMORY.md": f"# MEMORY.md - {name}\n\n_No memories yet._\n",
            "TOOLS.md": f"# TOOLS.md — {name}\n\n_Add tool-specific notes here._\n",
        }
        for filename, content in files.items():
            with open(os.path.join(profile_home, filename), "w", encoding="utf-8") as f:
                f.write(content)

    def _chown_like_home(self, path: str) -> None:
        try:
            st = os.stat(self.home_path or path)
            for root, dirs, files in os.walk(path):
                os.chown(root, st.st_uid, st.st_gid)
                for name in dirs + files:
                    try:
                        os.chown(os.path.join(root, name), st.st_uid, st.st_gid)
                    except OSError:
                        pass
        except OSError:
            pass

    def _display_name(self, profile: str) -> str:
        env_key = f"VO_HERMES_PROFILE_NAME_{self._safe_suffix(profile).upper().replace('-', '_')}"
        override = os.environ.get(env_key)
        if override:
            return override
        if profile == "default":
            return "Hermes"
        return profile.replace("-", " ").replace("_", " ").title()

    @staticmethod
    def _read_identity(profile_home: str) -> dict[str, str]:
        identity: dict[str, str] = {}
        try:
            with open(os.path.join(profile_home, "IDENTITY.md"), "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    m = re.match(r'-\s*\*\*Name:\*\*\s*(.+)', line)
                    if m:
                        identity["name"] = m.group(1).strip()
                    m = re.match(r'-\s*\*\*Emoji:\*\*\s*(.+)', line)
                    if m:
                        identity["emoji"] = m.group(1).strip()
                    m = re.match(r'-\s*\*\*Creature:\*\*\s*(.+)', line)
                    if m:
                        identity["role"] = m.group(1).split("—")[0].strip().rstrip(" -")
        except (OSError, UnicodeError):
            pass
        return identity

    @staticmethod
    def _last_active(home_path: str) -> int:
        latest = 0
        for rel in ("state.db", os.path.join("logs", "agent.log"), os.path.join("logs", "errors.log")):
            path = os.path.join(home_path, rel)
            try:
                if os.path.exists(path):
                    latest = max(latest, int(os.path.getmtime(path)))
            except OSError:
                pass
        return latest


@dataclass
class HermesApiClient:
    """Small client for Hermes Agent's native API Server run/event surface."""

    base_url: str | None = None
    api_key: str | None = None
    timeout_sec: int = 30
    max_response_bytes: int = 0  # Optional bounded read for projection-only callers.
    task_only: bool = False  # Opt-in: unrelated provider transports stay unchanged.

    def __post_init__(self) -> None:
        self.base_url = (self.base_url or os.environ.get("VO_HERMES_API_URL") or "http://127.0.0.1:8642").rstrip("/")
        self.api_key = self.api_key if self.api_key is not None else os.environ.get("VO_HERMES_API_KEY", "")

    def _url(self, path: str) -> str:
        return urljoin(self.base_url + "/", path.lstrip("/"))

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if extra:
            headers.update({k: v for k, v in extra.items() if v is not None})
        return headers

    def _json_request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout_sec: int | None = None,
    ) -> dict[str, Any]:
        data = None
        req_headers = self._headers(headers)
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self._url(path), data=data, headers=req_headers, method=method.upper())
        open_request = urllib.request.urlopen
        if self.task_only:
            class NoTaskRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    return None
            open_request = urllib.request.build_opener(NoTaskRedirect()).open
        with open_request(req, timeout=int(timeout_sec or self.timeout_sec)) as resp:
            raw_bytes = resp.read(self.max_response_bytes + 1) if self.max_response_bytes > 0 else resp.read()
            if self.max_response_bytes > 0 and len(raw_bytes) > self.max_response_bytes:
                raise ValueError("Hermes response exceeds the bounded projection budget")
            raw = raw_bytes.decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw.strip() else {}
            if isinstance(parsed, dict):
                parsed["_status"] = getattr(resp, "status", 200)
                return parsed
            return {"data": parsed, "_status": getattr(resp, "status", 200)}

    def capabilities(self) -> dict[str, Any]:
        return self._json_request("GET", "/v1/capabilities")

    def health(self) -> dict[str, Any]:
        return self._json_request("GET", "/health", timeout_sec=min(self.timeout_sec, 5))

    def models(self) -> dict[str, Any]:
        return self._json_request("GET", "/v1/models")

    def skills(self) -> dict[str, Any]:
        return self._json_request("GET", "/v1/skills")

    @staticmethod
    def _session_path(session_id: str, suffix: str = "") -> str:
        value = str(session_id or "").strip()
        if not value:
            raise ValueError("session_id is required")
        return f"/api/sessions/{quote(value, safe='')}{suffix}"

    def is_available(self) -> bool:
        try:
            health = self.health()
            if health.get("status") not in {"ok", "healthy"}:
                return False
            caps = self.capabilities()
            features = caps.get("features") if isinstance(caps.get("features"), dict) else {}
            return bool(features.get("run_submission") and features.get("run_events_sse"))
        except Exception:
            return False

    def start_run(
        self,
        message: str,
        *,
        session_id: str | None = None,
        session_key: str | None = None,
        instructions: str | None = None,
        conversation_history: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"input": message}
        if session_id:
            body["session_id"] = session_id
        if instructions:
            body["instructions"] = instructions
        if conversation_history:
            body["conversation_history"] = conversation_history
        headers = {"X-Hermes-Session-Key": session_key} if session_key and self.api_key else None
        return self._json_request("POST", "/v1/runs", body, headers=headers)

    def get_session_messages(self, session_id: str) -> dict[str, Any]:
        """Fetch a persisted Hermes session transcript through the public API."""
        session_id = str(session_id or "").strip()
        if not session_id:
            return {"ok": False, "error": "session_id is required", "data": []}
        try:
            result = self._json_request("GET", f"/api/sessions/{quote(session_id, safe='')}/messages")
            result["ok"] = True
            return result
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            return {
                "ok": False,
                "status": exc.code,
                "notFound": exc.code == 404,
                "error": body[:1000] or str(exc),
                "data": [],
            }

    def session_messages(
        self,
        session_id: str,
        *,
        limit: int = 500,
        offset: int = 0,
        order: str = "oldest",
    ) -> dict[str, Any]:
        query = urllib.parse.urlencode({
            "limit": max(1, min(int(limit), 500)),
            "offset": max(0, int(offset)),
            "order": "latest" if str(order).lower() == "latest" else "oldest",
        })
        return self._json_request("GET", self._session_path(session_id, f"/messages?{query}"))

    def list_sessions(self, limit: int = 40, offset: int = 0) -> dict[str, Any]:
        """List sessions through Hermes' documented REST session surface."""
        query = urllib.parse.urlencode({
            "limit": max(1, min(int(limit or 40), 200)),
            "offset": max(0, int(offset or 0)),
        })
        return self._json_request("GET", f"/api/sessions?{query}")

    def get_session(self, session_id: str) -> dict[str, Any]:
        session_id = str(session_id or "").strip()
        if not session_id:
            raise ValueError("session_id is required")
        return self._json_request("GET", f"/api/sessions/{quote(session_id, safe='')}")

    def create_session(
        self,
        *,
        session_id: str | None = None,
        title: str | None = None,
        model: str | None = None,
        source: str = "api_server",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"source": str(source or "api_server")[:80]}
        if session_id:
            body["session_id"] = str(session_id)
        if title is not None:
            body["title"] = str(title)[:200]
        if model:
            body["model"] = str(model)[:300]
        return self._json_request("POST", "/api/sessions", body)

    def delete_session(self, session_id: str) -> dict[str, Any]:
        session_id = str(session_id or "").strip()
        if not session_id:
            raise ValueError("session_id is required")
        return self._json_request("DELETE", f"/api/sessions/{quote(session_id, safe='')}")

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self._json_request("GET", f"/v1/runs/{run_id}")

    def respond_approval(self, run_id: str, choice: str) -> dict[str, Any]:
        return self._json_request("POST", f"/v1/runs/{run_id}/approval", {"choice": choice})

    def stop_run(self, run_id: str) -> dict[str, Any]:
        return self._json_request("POST", f"/v1/runs/{run_id}/stop", {})

    def stream_run_events(self, run_id: str, timeout_sec: int | None = None):
        """Yield dict events from Hermes' SSE run stream."""
        req = urllib.request.Request(
            self._url(f"/v1/runs/{run_id}/events"),
            headers=self._headers({"Accept": "text/event-stream"}),
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=int(timeout_sec or self.timeout_sec)) as resp:
            data_lines: list[str] = []
            for raw in resp:
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    if data_lines:
                        payload = "\n".join(data_lines)
                        data_lines = []
                        try:
                            item = json.loads(payload)
                            if isinstance(item, dict):
                                yield item
                        except json.JSONDecodeError:
                            continue
                    continue
                if line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())


def discover_api_agents(
    api_url: str | None = None,
    api_key: str | None = None,
    *,
    enabled: bool = True,
    timeout_sec: int = 5,
    connection_id: str | None = None,
    name: str | None = None,
    emoji: str | None = None,
    role: str | None = None,
) -> list[dict[str, Any]]:
    """Return one API-backed agent for one native Hermes gateway connection."""
    if not enabled:
        return []

    client = HermesApiClient(base_url=api_url, api_key=api_key, timeout_sec=timeout_sec)
    try:
        health = client.health()
        if health.get("status") not in {"ok", "healthy"}:
            return []
        caps = client.capabilities()
        features = caps.get("features") if isinstance(caps.get("features"), dict) else {}
        endpoints = caps.get("endpoints") if isinstance(caps.get("endpoints"), dict) else {}
        if not (features.get("run_submission") and features.get("run_events_sse")):
            return []
        model = caps.get("model") or caps.get("model_name") or ""
        try:
            models = client.models()
            data = models.get("data") if isinstance(models.get("data"), list) else []
            if not model and data:
                first = data[0] if isinstance(data[0], dict) else {}
                model = first.get("id") or first.get("name") or ""
        except Exception:
            pass
    except Exception:
        return []

    model = model or "hermes-agent"
    raw_connection_id = str(connection_id or model or "default").strip()
    safe_connection_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", raw_connection_id).strip("-.") or "default"
    display_name = str(name or "").strip()
    if not display_name:
        display_name = "Hermes" if model == "hermes-agent" else model.replace("-", " ").replace("_", " ").title()
    sessions = bool(features.get("session_resources") or endpoints.get("sessions"))
    session_messages = bool(endpoints.get("session_messages"))
    return [{
        "id": f"hermes-{safe_connection_id}",
        "statusKey": f"hermes-{safe_connection_id}",
        "providerKind": "hermes",
        "providerType": "runtime",
        "providerAgentId": safe_connection_id,
        "profile": safe_connection_id,
        "connectionId": safe_connection_id,
        "nativeProfile": model,
        "name": display_name,
        "emoji": str(emoji or os.environ.get("VO_HERMES_AGENT_EMOJI", "⚕️")),
        "role": str(role or "Hermes Agent"),
        "model": model,
        "provider": "Hermes API",
        "gateway": "api",
        "workspace": "",
        "home": "",
        "binary": "",
        "apiUrl": client.base_url,
        "lastActiveAt": int(time.time()),
        "capabilities": ["chat", "status", "sessions", "api"],
        "connectionModes": ["api"],
        "cliAvailable": False,
        "apiAvailable": True,
        "capabilityOverrides": {
            "sessions": sessions,
            "sessionCreate": sessions and bool(endpoints.get("session_create")),
            "sessionDelete": sessions and bool(endpoints.get("session_delete")),
            "sessionSwitch": sessions and session_messages,
            "skills": bool(features.get("skills_api") or endpoints.get("skills")),
            "models": bool(endpoints.get("models", True)),
            "profileEdit": False,
            "resourcesRead": False,
            "resourcesWrite": False,
            "agentCreate": False,
            "agentDelete": False,
        },
    }]


def discover_api_connections(
    connections: list[dict[str, Any]] | None,
    *,
    enabled: bool = True,
    timeout_sec: int = 5,
) -> list[dict[str, Any]]:
    """Discover configured native Hermes gateways without local CLI access."""
    if not enabled:
        return []
    agents: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, connection in enumerate(connections or []):
        if not isinstance(connection, dict) or connection.get("enabled") is False:
            continue
        api_url = str(connection.get("apiUrl") or connection.get("url") or "").strip()
        if not api_url:
            continue
        connection_id = str(connection.get("id") or f"connection-{index + 1}").strip()
        discovered = discover_api_agents(
            api_url=api_url,
            api_key=connection.get("apiKey") or connection.get("key") or "",
            enabled=True,
            timeout_sec=timeout_sec,
            connection_id=connection_id,
            name=connection.get("name") or connection.get("label"),
            emoji=connection.get("emoji"),
            role=connection.get("role"),
        )
        for agent in discovered:
            agent_id = str(agent.get("id") or "")
            if not agent_id or agent_id in seen_ids:
                continue
            seen_ids.add(agent_id)
            agents.append(agent)
    return agents
