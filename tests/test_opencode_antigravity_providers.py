#!/usr/bin/env python3
"""Focused tests for OpenCode/Antigravity provider safety and CLI wiring."""

import json
import os
import stat
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from providers.antigravity import AntigravityProvider  # noqa: E402
from providers.opencode import OpenCodeProvider  # noqa: E402
from providers.process_env import sanitized_env  # noqa: E402


CHECKS = []


def check(name, condition, detail=""):
    CHECKS.append((name, bool(condition), detail))
    marker = "PASS" if condition else "FAIL"
    print(f"[{marker}] {name}" + (f" -- {detail}" if detail and not condition else ""))
    return bool(condition)


def write_cli(path: Path, label: str) -> None:
    path.write_text(
        """#!__PYTHON__
import json
import os
import sys

if "--version" in sys.argv:
    print("__LABEL__ 1.0.0")
    sys.exit(0)

interesting = [
    "OPENCODE_CONFIG_DIR",
    "VO_GATEWAY_TOKEN",
    "OPENAI_API_KEY",
    "HTTP_PROXY",
    "ALLOWED_TEST_KEY",
]
print(json.dumps({
    "argv": sys.argv[1:],
    "cwd": os.getcwd(),
    "env": {k: os.environ[k] for k in interesting if k in os.environ},
}))
""".replace("__PYTHON__", sys.executable).replace("__LABEL__", label),
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def with_clean_env(updates):
    old_env = dict(os.environ)
    os.environ.clear()
    os.environ.update(old_env)
    os.environ.update(updates)
    return old_env


def restore_env(old_env):
    os.environ.clear()
    os.environ.update(old_env)


def main():
    with tempfile.TemporaryDirectory(prefix="vo-providers-") as raw:
        root = Path(raw)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        opencode_bin = bin_dir / "opencode"
        agy_bin = bin_dir / "agy"
        write_cli(opencode_bin, "opencode")
        write_cli(agy_bin, "agy")

        config_dir = root / "opencode-config"
        workspace_root = root / "opencode-workspaces"
        main_workspace = root / "opencode-main"
        ag_workspace = root / "antigravity-workspace"
        for path in (config_dir / "agents", workspace_root, main_workspace, ag_workspace):
            path.mkdir(parents=True, exist_ok=True)

        old_env = with_clean_env({
            "PATH": str(bin_dir),
            "HOME": str(root / "home"),
            "VO_GATEWAY_TOKEN": "gateway-secret",
            "OPENAI_API_KEY": "openai-secret",
            "HTTP_PROXY": "proxy.local:8080",
            "ALLOWED_TEST_KEY": "allowed",
            "VO_OPENCODE_BIN": "opencode",
            "VO_OPENCODE_ENV_ALLOWLIST": "ALLOWED_TEST_KEY",
            "VO_ANTIGRAVITY_BIN": "agy",
            "VO_ANTIGRAVITY_ENV_ALLOWLIST": "ALLOWED_TEST_KEY",
        })
        try:
            env = sanitized_env("VO_OPENCODE_ENV_ALLOWLIST")
            check("Sanitized env keeps PATH", env.get("PATH") == str(bin_dir), str(env))
            check("Sanitized env allows explicit extra key", env.get("ALLOWED_TEST_KEY") == "allowed", str(env))
            check("Sanitized env drops gateway token", "VO_GATEWAY_TOKEN" not in env, str(env))
            check("Sanitized env drops model API key", "OPENAI_API_KEY" not in env, str(env))
            check("Sanitized env drops proxy credentials by default", "HTTP_PROXY" not in env, str(env))

            opencode = OpenCodeProvider(
                home_path=str(config_dir),
                workspace_root=str(workspace_root),
                main_workspace=str(main_workspace),
                enabled=True,
                model="test-model",
            )
            check("OpenCode resolves PATH binary", opencode.binary == str(opencode_bin), opencode.binary)
            result = opencode.send_chat_message("reviewer", "hello", session_id="session-123", timeout_sec=5)
            payload = json.loads(result.get("reply") or "{}")
            check("OpenCode run succeeds with fake CLI", result.get("ok"), str(result))
            check("OpenCode command uses run", payload.get("argv", [])[:2] == ["run", "--agent"], str(payload))
            check("OpenCode command passes agent", "reviewer" in payload.get("argv", []), str(payload))
            check("OpenCode command passes session", "--session" in payload.get("argv", []) and "session-123" in payload.get("argv", []), str(payload))
            check("OpenCode command passes model", "--model" in payload.get("argv", []) and "test-model" in payload.get("argv", []), str(payload))
            check("OpenCode subprocess receives config dir", payload.get("env", {}).get("OPENCODE_CONFIG_DIR") == str(config_dir), str(payload))
            check("OpenCode subprocess does not receive gateway token", "VO_GATEWAY_TOKEN" not in payload.get("env", {}), str(payload))
            check("OpenCode subprocess does not receive API key", "OPENAI_API_KEY" not in payload.get("env", {}), str(payload))
            check("OpenCode subprocess does not receive proxy", "HTTP_PROXY" not in payload.get("env", {}), str(payload))
            check("OpenCode subprocess receives allowlisted env", payload.get("env", {}).get("ALLOWED_TEST_KEY") == "allowed", str(payload))

            rejected = opencode.create_agent(
                name="Nested",
                profile="nested",
                creation_mode="custom",
                custom_directory=str(config_dir / "agents" / "custom-parent"),
            )
            check("OpenCode rejects custom workspace inside native agents dir", not rejected.get("ok"), str(rejected))

            outside = root / "outside-delete-target"
            outside.mkdir()
            registry = workspace_root / "office-opencode-agent-registry.json"
            registry.write_text(json.dumps({"agents": {"bad": str(outside)}}), encoding="utf-8")
            delete_result = opencode.delete_agent("bad")
            check("OpenCode delete leaves unmarked external dir alone", outside.exists() and not delete_result.get("deleted"), str(delete_result))

            managed_parent = root / "custom-parent"
            created = opencode.create_agent(
                name="Managed",
                profile="managed",
                creation_mode="custom",
                custom_directory=str(managed_parent),
            )
            managed_dir = Path(created.get("workspace") or "")
            check("OpenCode creates custom managed agent", created.get("ok") and managed_dir.exists(), str(created))
            deleted = opencode.delete_agent("managed")
            check("OpenCode deletes matching managed custom agent", deleted.get("ok") and deleted.get("deleted") and not managed_dir.exists(), str(deleted))

            agy = AntigravityProvider(
                workspace_root=str(ag_workspace),
                enabled=True,
                model="gemini-test",
                sandbox="read-only",
                print_timeout="30s",
            )
            check("Antigravity resolves PATH binary", agy.binary == str(agy_bin), agy.binary)
            ag_result = agy.send_chat_message("main", "inspect this", timeout_sec=5)
            ag_payload = json.loads(ag_result.get("reply") or "{}")
            check("Antigravity run succeeds with fake CLI", ag_result.get("ok"), str(ag_result))
            check("Antigravity command uses print mode", "--print" in ag_payload.get("argv", []), str(ag_payload))
            check("Antigravity command passes model", "--model" in ag_payload.get("argv", []) and "gemini-test" in ag_payload.get("argv", []), str(ag_payload))
            check("Antigravity command passes sandbox", "--sandbox" in ag_payload.get("argv", []) and "read-only" in ag_payload.get("argv", []), str(ag_payload))
            check("Antigravity command passes print timeout", "--print-timeout" in ag_payload.get("argv", []) and "30s" in ag_payload.get("argv", []), str(ag_payload))
            check("Antigravity subprocess does not receive gateway token", "VO_GATEWAY_TOKEN" not in ag_payload.get("env", {}), str(ag_payload))
            check("Antigravity subprocess does not receive API key", "OPENAI_API_KEY" not in ag_payload.get("env", {}), str(ag_payload))
            check("Antigravity subprocess does not receive proxy", "HTTP_PROXY" not in ag_payload.get("env", {}), str(ag_payload))
        finally:
            restore_env(old_env)

    failures = [name for name, ok, _detail in CHECKS if not ok]
    if failures:
        print(f"FAILED: {len(failures)} provider checks failed: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)
    print(f"provider-safety: OK ({len(CHECKS)} checks)")


if __name__ == "__main__":
    main()
