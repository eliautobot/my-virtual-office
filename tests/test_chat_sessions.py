#!/usr/bin/env python3
"""Verify unified chat-session APIs without touching real provider stores."""

import importlib.util
import json
import os
import sys
import tempfile
import time
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "app" / "server.py"
CHECKS = []


def install_websockets_stub():
    ws_mod = types.ModuleType("websockets")
    async_mod = types.ModuleType("websockets.asyncio")
    client_mod = types.ModuleType("websockets.asyncio.client")
    exceptions_mod = types.SimpleNamespace(ConnectionClosed=RuntimeError)

    def _connect(*_args, **_kwargs):
        raise RuntimeError("websockets stub should not be used in chat-session tests")

    client_mod.connect = _connect
    async_mod.client = client_mod
    ws_mod.asyncio = async_mod
    ws_mod.exceptions = exceptions_mod
    sys.modules.setdefault("websockets", ws_mod)
    sys.modules.setdefault("websockets.asyncio", async_mod)
    sys.modules.setdefault("websockets.asyncio.client", client_mod)


def check(name, condition, detail=""):
    CHECKS.append((name, bool(condition), detail))
    marker = "PASS" if condition else "FAIL"
    print(f"[{marker}] {name}" + (f" -- {detail}" if detail and not condition else ""))
    return bool(condition)


def load_server(tmpdir):
    data_dir = tmpdir / "data"
    openclaw_dir = tmpdir / "openclaw"
    claude_home = tmpdir / "claude"
    for path in (data_dir, openclaw_dir, claude_home / "projects" / "test-project"):
        path.mkdir(parents=True, exist_ok=True)
    os.environ["VO_STATUS_DIR"] = str(data_dir)
    os.environ["VO_CONFIG"] = str(data_dir / "vo-config.json")
    os.environ["VO_OPENCLAW_PATH"] = str(openclaw_dir)
    os.environ["VO_CLAUDE_CODE_HOME"] = str(claude_home)
    os.environ["CLAUDE_CONFIG_DIR"] = str(claude_home)
    os.environ["VO_CODEX_INCLUDE_NATIVE_AGENTS"] = "0"
    os.environ["VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS"] = "0"
    os.environ["_VO_INT"] = "1"

    install_websockets_stub()
    spec = importlib.util.spec_from_file_location("vo_server_chat_sessions_test", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(ROOT / "app"))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    module._discovered_roster = [
        {"id": "adam", "statusKey": "adam", "name": "Adam", "providerKind": "openclaw", "providerAgentId": "adam", "profile": "adam", "emoji": "A", "workspace": str(openclaw_dir / "agents" / "adam")},
        {"id": "hermes-default", "statusKey": "hermes-default", "name": "Hermes", "providerKind": "hermes", "providerAgentId": "default", "profile": "default", "emoji": "H"},
        {"id": "codex-main", "statusKey": "codex-main", "name": "Codex", "providerKind": "codex", "providerAgentId": "main", "profile": "main", "emoji": "C"},
        {"id": "claude-main", "statusKey": "claude-main", "name": "Claude", "providerKind": "claude-code", "providerAgentId": "main", "profile": "main", "emoji": "L"},
        {"id": "opencode-main", "statusKey": "opencode-main", "name": "OpenCode", "providerKind": "opencode", "providerAgentId": "main", "profile": "main", "emoji": "O"},
        {"id": "antigravity-main", "statusKey": "antigravity-main", "name": "Antigravity", "providerKind": "antigravity", "providerAgentId": "main", "profile": "main", "emoji": "A"},
    ]
    module._discovered_at = time.time()
    module.refresh_agent_maps()
    return module, data_dir, openclaw_dir, claude_home


class FakeHermesProvider:
    def __init__(self):
        self.deleted = []

    def list_sessions(self, profile, limit=40):
        return {"ok": True, "sessions": [
            {"id": "hermes-session-1", "title": "Hermes Current", "preview": "latest", "lastActive": "2026-07-07 10:30"},
            {"id": "hermes-session-0", "title": "Hermes Older", "preview": "older", "lastActive": "2026-07-06 09:00"},
        ][:limit], "profile": profile}

    def export_session(self, profile, session_id):
        return {"ok": True, "session": {"id": session_id, "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi from hermes"},
            {"role": "tool", "content": "hidden"},
        ]}}

    def delete_session(self, profile, session_id):
        self.deleted.append((profile, session_id))
        return {"ok": True, "deleted": True}


class FakeCodexProvider:
    def __init__(self):
        self.deleted = []

    def list_threads(self, profile, limit=40):
        return {"ok": True, "sessions": [
            {"id": "codex-thread-1", "title": "Codex Current", "preview": "latest", "updatedAt": "2026-07-07T14:00:00Z", "archived": False},
            {"id": "codex-thread-archived", "title": "Archived", "preview": "old", "updatedAt": "2026-07-01T14:00:00Z", "archived": True},
        ][:limit], "profile": profile}

    def read_thread(self, profile, thread_id):
        return {"ok": True, "thread": {"id": thread_id, "turns": [{"items": [
            {"type": "userMessage", "content": [{"text": "build it"}]},
            {"type": "agentMessage", "text": "built it"},
        ]}]}}

    def delete_thread(self, profile, thread_id):
        self.deleted.append((profile, thread_id))
        return {"ok": True, "deleted": True}


class FakeOpenCodeProvider:
    def __init__(self):
        self.deleted = []

    def list_sessions(self, profile, limit=40):
        return {"ok": True, "sessions": [
            {"id": "opencode-session-1", "title": "OpenCode Current", "preview": "latest", "updatedAt": "2026-07-07T15:00:00Z"},
            {"id": "opencode-session-0", "title": "OpenCode Older", "preview": "older", "updatedAt": "2026-07-06T15:00:00Z"},
        ][:limit], "profile": profile}

    def delete_session(self, profile, session_id):
        self.deleted.append((profile, session_id))
        return {"ok": True, "deleted": True, "sessionId": session_id}


def main():
    with tempfile.TemporaryDirectory(prefix="vo-chat-sessions-") as raw_tmp:
        server, _data_dir, openclaw_dir, claude_home = load_server(Path(raw_tmp))
        gateway_calls = []

        def fake_gateway(method, params=None, timeout=20):
            gateway_calls.append((method, params or {}))
            if method == "sessions.list":
                return {"ok": True, "sessions": [
                    {"key": "agent:adam:main", "label": "Main chat", "preview": "main preview", "updatedAt": "2026-07-07T13:00:00Z"},
                    {"key": "agent:adam:vw-live-mode-planner", "label": "", "preview": "live", "updatedAt": "2026-07-07T13:05:00Z"},
                ]}
            if method in {"sessions.reset", "sessions.delete"}:
                return {"ok": True, "payload": {}}
            return {"ok": False, "error": f"unexpected gateway method {method}"}

        fake_hermes = FakeHermesProvider()
        fake_codex = FakeCodexProvider()
        fake_opencode = FakeOpenCodeProvider()
        server._gateway_rpc_call = fake_gateway
        server._hermes_provider = lambda agent=None: fake_hermes
        server._codex_provider = lambda: fake_codex
        server._opencode_provider = lambda: fake_opencode

        server._save_hermes_state("default", {"messages": [], "sessionId": "hermes-session-1"})
        server._save_codex_state("main", {"messages": [], "sessionId": "codex-thread-1"})
        server._save_opencode_state("main", {"messages": [{"role": "assistant", "text": "hi from opencode"}], "sessionId": "opencode-session-1"})
        server._save_antigravity_state("main", {"messages": [{"role": "assistant", "text": "hi from agy"}]})

        adam_sessions_dir = openclaw_dir / "agents" / "adam" / "sessions"
        adam_sessions_dir.mkdir(parents=True, exist_ok=True)
        (adam_sessions_dir / "sessions.json").write_text(json.dumps({
            "agent:adam:file-only": {
                "sessionId": "file-only-session",
                "label": "File-only session",
                "preview": "loaded from configured OpenClaw home",
                "updatedAt": "2026-07-07T13:10:00Z",
            }
        }), encoding="utf-8")

        claude_session_id = "11111111-2222-3333-4444-555555555555"
        claude_file = claude_home / "projects" / "test-project" / f"{claude_session_id}.jsonl"
        claude_file.write_text("\n".join([
            json.dumps({"type": "user", "sessionId": claude_session_id, "timestamp": "2026-07-07T10:00:00Z", "message": {"role": "user", "content": "hello claude"}, "cwd": "/tmp/test-project"}),
            json.dumps({"type": "assistant", "sessionId": claude_session_id, "timestamp": "2026-07-07T10:01:00Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi from claude"}]}, "cwd": "/tmp/test-project"}),
            json.dumps({"type": "last-prompt", "sessionId": claude_session_id, "timestamp": "2026-07-07T10:02:00Z", "lastPrompt": "hello claude"}),
        ]) + "\n", encoding="utf-8")

        openclaw_payload, openclaw_status = server.handle_chat_sessions_list("adam")
        openclaw_sessions = openclaw_payload.get("sessions") or []
        check("OpenClaw sessions list succeeds", openclaw_status == 200 and openclaw_payload.get("ok"))
        check("OpenClaw main session is listed", any(s.get("id") == "agent:adam:main" for s in openclaw_sessions))
        check("OpenClaw file-backed session is listed", any(s.get("id") == "agent:adam:file-only" for s in openclaw_sessions))
        check("OpenClaw live mode row is titled", any(s.get("title") == "Live Agent Mode" and s.get("liveMode") for s in openclaw_sessions))
        created, status = server.handle_chat_session_create("adam", {"sessionKey": "agent:adam:main"})
        check("OpenClaw create/reset uses gateway sessions.reset", status == 200 and created.get("ok") and gateway_calls[-1][0] == "sessions.reset")
        rejected, status = server.handle_chat_session_create("adam", {"sessionKey": "agent:other:main"})
        check("OpenClaw create rejects cross-agent session key", status == 400 and not rejected.get("ok"))
        switched, status = server.handle_chat_session_switch("adam", "agent:adam:vw-live-mode-planner")
        check("OpenClaw switch returns requested session key", status == 200 and switched.get("sessionKey") == "agent:adam:vw-live-mode-planner")
        rejected, status = server.handle_chat_session_switch("adam", "agent:other:main")
        check("OpenClaw switch rejects cross-agent session key", status == 400 and not rejected.get("ok"))
        deleted, status = server.handle_chat_session_delete("adam", "agent:adam:old-session")
        check("OpenClaw delete uses gateway sessions.delete", status == 200 and deleted.get("deleted") and gateway_calls[-1][0] == "sessions.delete")
        rejected, status = server.handle_chat_session_delete("adam", "agent:other:old-session")
        check("OpenClaw delete rejects cross-agent session key", status == 400 and not rejected.get("ok"))

        sample_messages = [{"sessionTitle": "Main chat", "liveMode": False}]
        server._agent_chat_apply_session_meta(sample_messages, {"sessionKey": "agent:adam:vw-live-mode-planner", "sessionTitle": "Live Agent Mode", "liveMode": True})
        check("bubble metadata helper overrides stale message metadata", sample_messages[0].get("sessionTitle") == "Live Agent Mode" and sample_messages[0].get("liveMode") is True)

        hermes_payload, hermes_status = server.handle_chat_sessions_list("hermes-default")
        check("Hermes sessions list uses provider", hermes_status == 200 and hermes_payload.get("sessions", [{}])[0].get("active") is True)
        switched, status = server.handle_chat_session_switch("hermes-default", "hermes-session-1")
        check("Hermes switch exports messages", status == 200 and len(switched.get("messages") or []) == 2 and server._get_hermes_session_id("default") == "hermes-session-1")
        deleted, status = server.handle_chat_session_delete("hermes-default", "hermes-session-1")
        check("Hermes delete clears active session", status == 200 and deleted.get("deleted") and server._get_hermes_session_id("default") == "")

        codex_payload, codex_status = server.handle_chat_sessions_list("codex-main")
        codex_sessions = codex_payload.get("sessions") or []
        check("Codex list filters archived threads", codex_status == 200 and len(codex_sessions) == 1 and codex_sessions[0].get("id") == "codex-thread-1")
        switched, status = server.handle_chat_session_switch("codex-main", "codex-thread-1")
        check("Codex switch reads thread messages", status == 200 and len(switched.get("messages") or []) == 2 and server._get_codex_session_id("main") == "codex-thread-1")
        deleted, status = server.handle_chat_session_delete("codex-main", "codex-thread-1")
        check("Codex delete clears active thread", status == 200 and deleted.get("deleted") and server._get_codex_session_id("main") == "")

        opencode_payload, opencode_status = server.handle_chat_sessions_list("opencode-main")
        opencode_sessions = opencode_payload.get("sessions") or []
        check("OpenCode sessions list uses provider", opencode_status == 200 and opencode_sessions and opencode_sessions[0].get("active") is True)
        created, status = server.handle_chat_session_create("opencode-main")
        check("OpenCode create clears local active session", status == 200 and created.get("ok") and server._get_opencode_session_id("main") == "")
        switched, status = server.handle_chat_session_switch("opencode-main", "opencode-session-1")
        check("OpenCode switch stores active session", status == 200 and switched.get("sessionId") == "opencode-session-1" and server._get_opencode_session_id("main") == "opencode-session-1")
        deleted, status = server.handle_chat_session_delete("opencode-main", "opencode-session-1")
        check("OpenCode delete clears active session", status == 200 and deleted.get("deleted") and server._get_opencode_session_id("main") == "")

        antigravity_payload, antigravity_status = server.handle_chat_sessions_list("antigravity-main")
        check("Antigravity sessions list returns one-shot note", antigravity_status == 200 and antigravity_payload.get("ok") and antigravity_payload.get("sessions") == [])
        created, status = server.handle_chat_session_create("antigravity-main")
        check("Antigravity create clears local history", status == 200 and created.get("ok") and server._load_antigravity_history("main") == [])
        rejected, status = server.handle_chat_session_switch("antigravity-main", "agy-session")
        check("Antigravity switch is rejected", status == 400 and not rejected.get("ok"))
        rejected, status = server.handle_chat_session_delete("antigravity-main", "agy-session")
        check("Antigravity delete is rejected", status == 400 and not rejected.get("ok"))

        claude_payload, claude_status = server.handle_chat_sessions_list("claude-main")
        claude_sessions = claude_payload.get("sessions") or []
        check("Claude Code lists native JSONL sessions", claude_status == 200 and claude_sessions and claude_sessions[0].get("id") == claude_session_id)
        switched, status = server.handle_chat_session_switch("claude-main", claude_session_id)
        check("Claude Code switch reads JSONL messages", status == 200 and len(switched.get("messages") or []) == 2 and server._get_claude_code_session_id("main") == claude_session_id)
        deleted, status = server.handle_chat_session_delete("claude-main", claude_session_id)
        check("Claude Code delete renames native session file and clears active id", status == 200 and deleted.get("deleted") and server._get_claude_code_session_id("main") == "" and not claude_file.exists())

    failures = [name for name, ok, _detail in CHECKS if not ok]
    if failures:
        print(f"FAILED: {len(failures)} chat session checks failed: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)
    print(f"verify-chat-sessions: OK ({len(CHECKS)} checks)")


if __name__ == "__main__":
    main()
