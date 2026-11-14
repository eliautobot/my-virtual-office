"""Provider registry and compatibility contract for My Virtual Office.

The registry is intentionally small.  A provider owns its native discovery and
operations; the office owns normalization, capability negotiation, and routing.
Future providers can be added as ``vo_provider_*.py`` extension modules without
editing the Virtual Office server.
"""

from __future__ import annotations

import importlib.util
import os
import re
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout, wait as futures_wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


CONTRACT_VERSION = "1.1"
CAPABILITY_NAMES = {
    "taskProgress",
    "discover",
    "health",
    "chat",
    "streaming",
    "sessions",
    "sessionCreate",
    "sessionDelete",
    "sessionSwitch",
    "interrupt",
    "approvals",
    "agentCreate",
    "agentDelete",
    "profileEdit",
    "resourcesRead",
    "resourcesWrite",
    "skills",
    "models",
    "projects",
    "meetings",
    "agentToAgent",
    "attachments",
    "tools",
    # Chat window features of the full Hermes and OpenClaw connections (hp port).
    "effort",
    "questions",
    "plan",
    "queue",
    "observe",
    "presence",
    "titles",
    "context",
    "commands",
    "media",
    "tasks",
    "browser",
    "screen",
    "computer",
    "progressCard",
    "accessLevel",
}


def safe_provider_id(value: Any) -> str:
    value = str(value or "").strip().lower()
    return re.sub(r"[^a-z0-9_.-]+", "-", value).strip("-.")[:80]


def capability_map(value: Any) -> dict[str, bool]:
    if isinstance(value, dict):
        return {name: bool(value.get(name, False)) for name in sorted(CAPABILITY_NAMES)}
    enabled = {str(item) for item in (value or [])}
    return {name: name in enabled for name in sorted(CAPABILITY_NAMES)}


@dataclass
class ProviderManifest:
    id: str
    name: str
    description: str = ""
    icon: str = "🤖"
    category: str = "agent-runtime"
    version: str = "1"
    provider_type: str = "runtime"
    enabled: bool = True
    capabilities: dict[str, bool] = field(default_factory=dict)
    connection_schema: dict[str, Any] = field(default_factory=dict)
    creation_schema: dict[str, Any] = field(default_factory=dict)
    settings_schema: dict[str, Any] = field(default_factory=dict)
    resource_schema: list[dict[str, Any]] = field(default_factory=list)
    skill_schema: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.id = safe_provider_id(self.id)
        if not self.id:
            raise ValueError("Provider manifest id is required")
        self.capabilities = capability_map(self.capabilities)

    def as_dict(self) -> dict[str, Any]:
        return {
            "contractVersion": CONTRACT_VERSION,
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "category": self.category,
            "version": self.version,
            "providerType": self.provider_type,
            "enabled": self.enabled,
            "capabilities": dict(self.capabilities),
            "connectionSchema": dict(self.connection_schema),
            "creationSchema": dict(self.creation_schema),
            "settingsSchema": dict(self.settings_schema),
            "resourceSchema": [dict(item) for item in self.resource_schema],
            "skillSchema": [dict(item) for item in self.skill_schema],
            "metadata": dict(self.metadata),
        }


# Provider probes spawn CLIs and open network connections; run them side by side
# with a deadline instead of one after another on a request thread (BE-08/BE-24).
_PROBE_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="provider-probe")
HEALTH_TIMEOUT_SEC = float(os.environ.get("VO_PROVIDER_HEALTH_TIMEOUT_SEC") or 12)
DISCOVERY_TIMEOUT_SEC = float(os.environ.get("VO_PROVIDER_DISCOVERY_TIMEOUT_SEC") or 25)


class ProviderRegistry:
    """Registry of provider objects implementing the Office provider contract."""

    def __init__(self, context: dict[str, Any] | None = None) -> None:
        self.context = context or {}
        self._providers: dict[str, Any] = {}
        self._load_errors: list[dict[str, str]] = []
        # Errors from discovery/health calls: latest per provider+operation, reset each discovery (BE-33).
        self._runtime_errors: dict[tuple[str, str], dict[str, str]] = {}
        self._health_cache: dict[str, tuple[float, Any]] = {}
        self._discovery_cache: dict[str, list] = {}
        self._cache_lock = threading.Lock()

    def register(self, provider: Any) -> None:
        manifest = self._manifest(provider)
        if manifest.id in self._providers:
            raise ValueError(f"Provider '{manifest.id}' is already registered")
        self._providers[manifest.id] = provider

    def ids(self) -> list[str]:
        return list(self._providers)

    def get(self, provider_id: str) -> Any | None:
        return self._providers.get(safe_provider_id(provider_id))

    def manifest(self, provider_id: str) -> ProviderManifest | None:
        provider = self.get(provider_id)
        return self._manifest(provider) if provider is not None else None

    def _parallel_calls(self, provider_ids: list[str], operation: str, default: Any, timeout: float) -> dict[str, tuple[bool, Any]]:
        """Run one operation on many providers at once. Returns {id: (finished, value)}."""
        if not provider_ids:
            return {}
        if len(provider_ids) == 1:
            pid = provider_ids[0]
            return {pid: (True, self._safe_call(pid, operation, default=default))}
        futures = {pid: _PROBE_POOL.submit(self._safe_call, pid, operation, default) for pid in provider_ids}
        futures_wait(list(futures.values()), timeout=max(0.1, timeout))
        results = {}
        for pid, future in futures.items():
            if future.done():
                try:
                    results[pid] = (True, future.result())
                except Exception as exc:  # _safe_call already catches; defensive
                    results[pid] = (True, default)
                    self._note_error(pid, operation, str(exc))
            else:
                results[pid] = (False, default)
                self._note_error(pid, operation, f"timed out after {timeout:.0f}s")
        return results

    def manifests(self, include_health: bool = False, max_age: float | None = None) -> list[dict[str, Any]]:
        """Provider manifests; with ``include_health`` each provider's ``test()`` runs in
        parallel with a deadline. ``max_age`` (seconds) reuses recent health results."""
        items = [(provider_id, self._manifest(provider).as_dict()) for provider_id, provider in self._providers.items()]
        if include_health:
            now = time.time()
            health: dict[str, Any] = {}
            stale: list[str] = []
            with self._cache_lock:
                for provider_id, _item in items:
                    cached = self._health_cache.get(provider_id)
                    if max_age is not None and cached and now - cached[0] <= max_age:
                        health[provider_id] = cached[1]
                    else:
                        stale.append(provider_id)
            fallback = {"ok": False, "error": "Health check unavailable"}
            for provider_id, (finished, value) in self._parallel_calls(stale, "test", fallback, HEALTH_TIMEOUT_SEC).items():
                if finished:
                    health[provider_id] = value
                    with self._cache_lock:
                        self._health_cache[provider_id] = (time.time(), value)
                else:
                    with self._cache_lock:
                        previous = self._health_cache.get(provider_id)
                    health[provider_id] = previous[1] if previous else {
                        "ok": False, "error": "Health check timed out", "connectionState": "timeout",
                    }
            for provider_id, item in items:
                item["health"] = health.get(provider_id, fallback)
        return [item for _provider_id, item in items]

    def discover_agents(self) -> list[dict[str, Any]]:
        agents: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()
        with self._cache_lock:
            self._runtime_errors = {}
        candidates = []
        for provider_id, provider in self._providers.items():
            manifest = self._manifest(provider)
            if not manifest.enabled or not manifest.capabilities.get("discover"):
                continue
            candidates.append((provider_id, manifest))
        results = self._parallel_calls([pid for pid, _m in candidates], "discover_agents", [], DISCOVERY_TIMEOUT_SEC)
        for provider_id, manifest in candidates:
            finished, rows = results.get(provider_id, (True, []))
            if finished and isinstance(rows, list):
                with self._cache_lock:
                    self._discovery_cache[provider_id] = rows
            elif not finished:
                # A slow provider keeps its last known agents instead of flickering offline.
                with self._cache_lock:
                    rows = list(self._discovery_cache.get(provider_id) or [])
            if not isinstance(rows, list):
                self._note_error(provider_id, "discover_agents", "discover_agents returned a non-list value")
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                normalized = self._normalize_agent(provider_id, manifest, row)
                stable_key = (
                    provider_id,
                    normalized["providerConnectionId"],
                    normalized["providerAgentId"],
                )
                if stable_key in seen:
                    continue
                seen.add(stable_key)
                agents.append(normalized)
        return agents

    def provider_for_agent(self, agent: dict[str, Any] | None) -> Any | None:
        if not isinstance(agent, dict):
            return None
        return self.get(agent.get("providerKind") or agent.get("providerId"))

    def invoke(self, provider_id: str, operation: str, *args: Any, **kwargs: Any) -> Any:
        provider = self.get(provider_id)
        if provider is None:
            return {"ok": False, "error": f"Unknown provider '{provider_id}'", "code": "provider_not_found"}
        method = getattr(provider, operation, None)
        if not callable(method):
            return {
                "ok": False,
                "error": f"{self._manifest(provider).name} does not support {operation}",
                "code": "not_supported",
            }
        try:
            return method(*args, **kwargs)
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc), "code": "provider_error"}

    def conformance(self) -> dict[str, Any]:
        reports = []
        ok = True
        method_by_capability = {
            "discover": "discover_agents",
            "health": "test",
            "chat": "send_chat_message",
            "sessions": "list_sessions",
            "interrupt": "interrupt",
            "agentCreate": "create_agent",
            "agentDelete": "delete_agent",
            "profileEdit": "update_profile",
        }
        for provider_id, provider in self._providers.items():
            manifest = self._manifest(provider)
            errors: list[str] = []
            for capability, method_name in method_by_capability.items():
                if manifest.capabilities.get(capability) and not callable(getattr(provider, method_name, None)):
                    errors.append(f"{capability} requires {method_name}()")
            if manifest.capabilities.get("approvals"):
                for method_name in ("pending_approval", "respond_approval"):
                    if not callable(getattr(provider, method_name, None)):
                        errors.append(f"approvals requires {method_name}()")
            if manifest.category != "agent-runtime":
                errors.append("provider category must be agent-runtime")
            transports = manifest.connection_schema.get("transports") if isinstance(manifest.connection_schema, dict) else None
            if isinstance(transports, list) and transports:
                transport_ids: set[str] = set()
                for transport in transports:
                    if not isinstance(transport, dict):
                        errors.append("connectionSchema transports must be objects")
                        continue
                    transport_id = safe_provider_id(transport.get("id"))
                    kind = str(transport.get("kind") or "")
                    if not transport_id or transport_id in transport_ids:
                        errors.append("connectionSchema transport ids must be unique and non-empty")
                    transport_ids.add(transport_id)
                    if kind == "network":
                        if not transport.get("modeKey") or not transport.get("urlKey"):
                            errors.append(f"network transport '{transport_id}' requires modeKey and urlKey")
                        schemes = transport.get("schemes")
                        if not isinstance(schemes, list) or not schemes:
                            errors.append(f"network transport '{transport_id}' requires schemes")
                        defaults = transport.get("defaultEndpoints")
                        if not isinstance(defaults, list) or not defaults:
                            errors.append(f"network transport '{transport_id}' requires defaultEndpoints")
                    elif kind == "process":
                        if not transport.get("executableKey"):
                            errors.append(f"process transport '{transport_id}' requires executableKey")
                    else:
                        errors.append(f"unsupported connection transport kind: {kind or '(empty)'}")
            if not manifest.settings_schema:
                errors.append("provider must declare settingsSchema for connection integration")
            if manifest.capabilities.get("agentCreate") and not (manifest.creation_schema.get("fields") or []):
                errors.append("agentCreate requires creationSchema.fields")
            if manifest.capabilities.get("resourcesRead") and not manifest.resource_schema:
                errors.append("resourcesRead requires resourceSchema")
            if manifest.capabilities.get("resourcesWrite") and not any(
                isinstance(resource, dict) and resource.get("writable")
                for resource in manifest.resource_schema
            ):
                errors.append("resourcesWrite requires at least one writable resource")
            for resource in manifest.resource_schema:
                if not isinstance(resource, dict):
                    errors.append("resourceSchema entries must be objects")
                    continue
                paths = resource.get("paths") or []
                if not resource.get("id") or not paths:
                    errors.append("resourceSchema entries require id and paths")
                for path in paths:
                    normalized = str(path or "").replace("\\", "/").strip()
                    if not normalized or normalized.startswith("/") or ".." in normalized.split("/"):
                        errors.append(f"unsafe resource path: {path}")
                    if normalized in {"*", "**", "**/*"}:
                        errors.append("blanket workspace resource globs are forbidden")
                if resource.get("sensitive") and resource.get("readable", True):
                    errors.append(f"sensitive resource '{resource.get('id')}' must be hidden")
            if manifest.capabilities.get("skills"):
                if not manifest.skill_schema:
                    errors.append("skills capability requires skillSchema")
                if not manifest.capabilities.get("resourcesRead"):
                    errors.append("skills capability requires resourcesRead")
            for root in manifest.skill_schema:
                if not isinstance(root, dict):
                    errors.append("skillSchema entries must be objects")
                    continue
                path = str(root.get("path") or "").replace("\\", "/").strip()
                if not root.get("id") or not path:
                    errors.append("skillSchema entries require id and path")
                if path.startswith("/") or ".." in path.split("/"):
                    errors.append(f"unsafe skill root: {path}")
                if root.get("format") != "agentskills":
                    errors.append(f"unsupported skill format for '{root.get('id')}'")
            reports.append({
                "providerId": provider_id,
                "ok": not errors,
                "errors": errors,
                "capabilities": manifest.capabilities,
            })
            ok = ok and not errors
        with self._cache_lock:
            runtime_errors = list(self._runtime_errors.values())
        load_errors = list(self._load_errors) + runtime_errors
        return {
            "ok": ok and not load_errors,
            "contractVersion": CONTRACT_VERSION,
            "providers": reports,
            "loadErrors": load_errors,
        }

    def load_extensions(self, directories: Iterable[str]) -> None:
        """Load ``vo_provider_*.py`` modules from explicitly scoped folders."""
        for raw_dir in directories:
            directory = os.path.abspath(os.path.expanduser(str(raw_dir or "").strip()))
            if not directory or not os.path.isdir(directory):
                continue
            extension_paths = {
                *Path(directory).glob("vo_provider_*.py"),
                *Path(directory).glob("vw_provider_*.py"),
            }
            for path in sorted(extension_paths):
                module_name = f"vo_provider_extension_{safe_provider_id(path.stem)}_{abs(hash(str(path)))}"
                try:
                    spec = importlib.util.spec_from_file_location(module_name, path)
                    if spec is None or spec.loader is None:
                        raise RuntimeError("Unable to create module loader")
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    factory = getattr(module, "build_provider", None)
                    if not callable(factory):
                        raise RuntimeError("Extension must export build_provider(context)")
                    providers = factory(dict(self.context))
                    if not isinstance(providers, (list, tuple)):
                        providers = [providers]
                    for provider in providers:
                        if provider is not None:
                            self.register(provider)
                except Exception as exc:
                    traceback.print_exc()
                    self._load_errors.append({"provider": str(path), "error": str(exc)})

    @staticmethod
    def _manifest(provider: Any) -> ProviderManifest:
        raw = getattr(provider, "manifest", None)
        if callable(raw):
            raw = raw()
        if isinstance(raw, ProviderManifest):
            return raw
        if isinstance(raw, dict):
            normalized = dict(raw)
            if "providerType" in normalized and "provider_type" not in normalized:
                normalized["provider_type"] = normalized.pop("providerType")
            if "creationSchema" in normalized and "creation_schema" not in normalized:
                normalized["creation_schema"] = normalized.pop("creationSchema")
            if "connectionSchema" in normalized and "connection_schema" not in normalized:
                normalized["connection_schema"] = normalized.pop("connectionSchema")
            if "settingsSchema" in normalized and "settings_schema" not in normalized:
                normalized["settings_schema"] = normalized.pop("settingsSchema")
            if "resourceSchema" in normalized and "resource_schema" not in normalized:
                normalized["resource_schema"] = normalized.pop("resourceSchema")
            if "skillSchema" in normalized and "skill_schema" not in normalized:
                normalized["skill_schema"] = normalized.pop("skillSchema")
            return ProviderManifest(**normalized)
        provider_id = getattr(provider, "provider_kind", "")
        return ProviderManifest(
            id=provider_id,
            name=str(provider_id or "Provider").replace("-", " ").title(),
            provider_type=getattr(provider, "provider_type", "runtime"),
            capabilities={"discover": callable(getattr(provider, "discover_agents", None))},
        )

    def _safe_call(self, provider_id: str, operation: str, default: Any) -> Any:
        provider = self.get(provider_id)
        method = getattr(provider, operation, None) if provider is not None else None
        if not callable(method):
            return default
        try:
            return method()
        except Exception as exc:
            traceback.print_exc()
            self._note_error(provider_id, operation, str(exc))
            return default

    def _note_error(self, provider_id: str, operation: str, message: str) -> None:
        with self._cache_lock:
            self._runtime_errors[(provider_id, operation)] = {"provider": provider_id, "error": f"{operation}: {message}"}

    @staticmethod
    def _normalize_agent(provider_id: str, manifest: ProviderManifest, row: dict[str, Any]) -> dict[str, Any]:
        native_id = str(
            row.get("providerAgentId")
            or row.get("profile")
            or row.get("nativeId")
            or row.get("id")
            or "main"
        )
        agent_id = str(row.get("id") or f"{provider_id}-{native_id}")
        status_key = str(row.get("statusKey") or agent_id)
        result = dict(row)
        native_capabilities = row.get("capabilities")
        capabilities = dict(manifest.capabilities)
        if isinstance(row.get("capabilityOverrides"), dict):
            capabilities.update({str(key): bool(value) for key, value in row["capabilityOverrides"].items()})
        result.update({
            "id": agent_id,
            "statusKey": status_key,
            "providerKind": provider_id,
            "providerId": provider_id,
            "providerType": row.get("providerType") or manifest.provider_type,
            "providerAgentId": native_id,
            "profile": row.get("profile") or native_id,
            "name": row.get("name") or native_id.replace("-", " ").title(),
            "emoji": row.get("emoji") or manifest.icon,
            "role": row.get("role") or manifest.name,
            "capabilities": capabilities,
            "nativeCapabilities": native_capabilities if native_capabilities is not None else [],
            "providerManifestVersion": manifest.version,
            "providerConnectionId": str(row.get("providerConnectionId") or row.get("connectionId") or "default"),
            "available": bool(row.get("available", True)),
            "connectionState": str(row.get("connectionState") or "connected"),
        })
        return result
