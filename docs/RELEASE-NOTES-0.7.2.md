# My Virtual Office v0.7.2: Production Hermes Integration

## Highlights

- Separates authenticated Hermes runtime transport from narrowly mounted resource transport. Virtual Office no longer needs a duplicate Hermes CLI for SOUL/profile/workspace/skill access.
- Adds default, named-profile, and explicit per-connection resource mapping with inherited/read-write/read-only/disabled policies, real filesystem read-only diagnostics, and owner-preserving atomic writes.
- Supports full nested Hermes skills (`skills/<category>/<skill>/SKILL.md`) plus the older flat layout.
- Adds an optional pinned `nousresearch/hermes-agent:v2026.8.3` Compose sidecar. It is a separate service on an internal-only network, publishes no Hermes port, persists `/opt/data`, and is independent of Virtual Office rebuilds.
- Preserves existing native/API Hermes deployments, sessions, settings, data, and licenses. No Docker socket or `docker exec` integration is used.

## Conversation continuity fix

Hermes `/v1/runs` does not hydrate older turns from `session_id`. Virtual Office now reads the selected session through the authenticated Sessions API and supplies bounded `conversation_history` on every continuing run. It normalizes structured text, excludes tool/internal protocol rows, avoids duplicating the current prompt, and rejects an unhydratable selected session before run submission. The browser consistently sends the native Hermes session ID, including after session create/switch/refresh, and both native Hermes and universal Provider SDK paths share the fix. Explicitly selected, newly created, and SDK-run sessions are not displaced by timestamp-free newest-first discovery results.

## Configuration and migration

Existing gateway connections continue to work. For mounted resources, set `VO_HERMES_HOST_DATA`, `VO_HERMES_RESOURCE_ROOT`, and `VO_HERMES_RESOURCE_ACCESS`; add a connection `resourcePath` only when its ID does not match the native profile directory. Use Docker volume mode `ro` for host-enforced read-only operation.

To use the optional sidecar, set a strong `VO_HERMES_API_KEY`, point the connection at `http://hermes:8642`, set host UID/GID, and run `docker compose --profile hermes up -d`. Port 8642 is intentionally not public.

## Security

Resource access is allowlisted and confined against absolute paths, traversal, hidden wildcard files, secrets, unsupported extensions, symlink escapes, and undeclared files. API keys remain redacted. Writes use atomic owner-preserving replacement and revision checks. The release image pins `pip 26.2.1` and `websockets 17.0.1`; the final image audit reports no known Python-package vulnerabilities.

## Verification

The release was gated by real-model same-session multi-turn recall, session switching/no-leakage/return/refresh persistence, blocking and SSE chat, session CRUD, models, approvals/cancel capabilities, resource RW/RO and nested skills, security probes, concurrent requests, severe-log scanning, full tracked test suites, syntax checks, dependency audit, Compose validation with/without the sidecar, Docker build/boot, clean-clone boot, and live browser flow.

## Limitations

- Cross-container file/image attachment handoff is intentionally deferred and is not advertised as supported.
- Whole Hermes profile create/delete and some native model/auth changes still require an administrator inside the Hermes runtime because its HTTP API lacks complete profile-lifecycle endpoints.

## Rollback

Pin the actually published prior image `ghcr.io/eliautobot/my-virtual-office:c08c690` (or check out tag `v0.7.1`) and recreate only the Virtual Office service. Do not remove the persistent `vo-data` or Hermes data volume. The separate Hermes container can remain running.
