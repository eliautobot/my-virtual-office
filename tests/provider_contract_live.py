#!/usr/bin/env python3
"""Read-only live checks for the Virtual Office provider contract."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_PROVIDERS = (
    "openclaw",
    "hermes",
    "codex",
    "claude-code",
    "opencode",
    "antigravity",
)


def get_json(base_url: str, path: str) -> tuple[int, dict]:
    request = urllib.request.Request(base_url.rstrip("/") + path)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8088")
    parser.add_argument("--providers", nargs="*", default=list(DEFAULT_PROVIDERS))
    parser.add_argument("--require-test-agents", action="store_true")
    parser.add_argument("--test-prefix", default="vo8088-test")
    args = parser.parse_args()

    failures: list[str] = []
    results: list[dict] = []

    status, health = get_json(args.base_url, "/health")
    results.append({"check": "health", "http": status, "ok": health.get("ok")})
    if status != 200 or not health.get("ok"):
        failures.append("server health failed")

    status, conformance = get_json(args.base_url, "/api/office/providers/conformance")
    results.append({
        "check": "conformance",
        "http": status,
        "ok": conformance.get("ok"),
        "contractVersion": conformance.get("contractVersion"),
    })
    if status != 200 or not conformance.get("ok"):
        failures.append("provider conformance failed")

    conformance_rows = {
        row.get("providerId"): row
        for row in conformance.get("providers") or []
        if isinstance(row, dict)
    }
    for provider_id in args.providers:
        row = conformance_rows.get(provider_id)
        ok = bool(row and row.get("ok"))
        results.append({
            "check": "provider-contract",
            "provider": provider_id,
            "ok": ok,
            "errors": (row or {}).get("errors") or [],
        })
        if not ok:
            failures.append(f"{provider_id}: missing or nonconformant")

    status, platform_data = get_json(args.base_url, "/api/agent-platforms")
    platform_rows = {
        row.get("id"): row
        for row in platform_data.get("platforms") or []
        if isinstance(row, dict)
    }
    for provider_id in args.providers:
        row = platform_rows.get(provider_id)
        schema_fields = ((row or {}).get("creationSchema") or {}).get("fields")
        capabilities = (row or {}).get("capabilities")
        resource_schema = (row or {}).get("resourceSchema")
        skill_schema = (row or {}).get("skillSchema")
        ok = bool(
            row
            and isinstance(capabilities, dict)
            and isinstance(schema_fields, list)
            and isinstance(resource_schema, list)
            and (not capabilities.get("resourcesRead") or bool(resource_schema))
            and (not capabilities.get("skills") or bool(skill_schema))
        )
        results.append({
            "check": "manifest-ui-contract",
            "provider": provider_id,
            "ok": ok,
            "available": (row or {}).get("available"),
            "connected": (row or {}).get("connected"),
            "resourceGroups": len(resource_schema or []),
            "skillRoots": len(skill_schema or []),
        })
        if not ok:
            failures.append(f"{provider_id}: invalid manifest/UI contract")

    status, roster = get_json(args.base_url, "/api/agents")
    agents = roster.get("agents") or []
    provider_counts: dict[str, int] = {}
    for agent in agents:
        provider = str(agent.get("providerKind") or "openclaw")
        provider_counts[provider] = provider_counts.get(provider, 0) + 1
    for provider_id in args.providers:
        count = provider_counts.get(provider_id, 0)
        discovery_ok = count > 0 or not args.require_test_agents
        results.append({
            "check": "provider-discovery",
            "provider": provider_id,
            "ok": discovery_ok,
            "agentCount": count,
        })
        if not discovery_ok:
            failures.append(f"{provider_id}: no agents discovered")

    if args.require_test_agents:
        test_agents = [
            agent for agent in agents
            if args.test_prefix in str(agent.get("id") or "")
            or args.test_prefix.replace("-", "") in str(agent.get("id") or "")
        ]
        found_providers = {str(agent.get("providerKind") or "openclaw") for agent in test_agents}
        for provider_id in args.providers:
            ok = provider_id in found_providers
            results.append({
                "check": "real-test-agent",
                "provider": provider_id,
                "ok": ok,
            })
            if not ok:
                failures.append(f"{provider_id}: namespaced test agent not found")

        for agent in test_agents:
            key = urllib.parse.quote(
                str(agent.get("statusKey") or agent.get("id") or ""),
                safe="",
            )
            workspace_status, workspace = get_json(
                args.base_url,
                f"/api/agent-workspace/{key}",
            )
            capabilities = agent.get("capabilities") or {}
            workspace_ok = workspace_status == 200 and workspace.get("ok")
            if capabilities.get("resourcesRead"):
                workspace_ok = workspace_ok and isinstance(workspace.get("files"), list)
            results.append({
                "check": "agent-desk",
                "agent": agent.get("id"),
                "provider": agent.get("providerKind"),
                "ok": bool(workspace_ok),
            })
            if not workspace_ok:
                failures.append(f"{agent.get('id')}: Agent Desk contract failed")

    print(json.dumps({
        "ok": not failures,
        "baseUrl": args.base_url,
        "results": results,
        "failures": failures,
    }, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
