# My Virtual Office v0.7.3: Hermes Reload Restoration

## Highlights

- Keeps the selected Hermes connection and full native session key across a browser reload, then rehydrates that exact transcript through the authenticated Sessions API before rendering history.
- Preserves the session through a Hermes runtime restart because the browser selection and Virtual Office active-session record both use the persistent native session ID.
- Canonicalizes a local Hermes profile and an explicitly mounted API connection that point at the same profile directory. Demo-mode provider balancing now exposes the functional API-backed identity instead of a duplicate CLI-only alias.
- Retains local-profile aliases during migration without hardcoding a connection name, profile name, host path, or API endpoint.
- Keeps mounted-profile metadata and API keys intact when the compact main Settings connection test saves, and refreshes provider discovery from the newly saved configuration immediately.

## QA and publishing corrections

- Updates the stale chat asset cache assertions and makes the standalone review-parser and live workflow scripts safe during normal pytest collection.
- Publishes Docker images from semver tags, including `ghcr.io/eliautobot/my-virtual-office:0.7.3`, while retaining `latest`, commit-SHA, date, and Git tag forms where applicable.
- Keeps Hermes API keys redacted in responses and preserves configured keys when a blank secret field is saved.

## Security and compatibility

Session restoration validates the requested session through the configured Hermes transport. A failed or unavailable transcript restore returns an error instead of silently displaying or continuing a different session. The mapping logic is path- and profile-based and supports default, named, API-only, CLI-only, and explicitly mounted combinations.

Cross-container file/image attachment handoff remains intentionally out of scope.

## Rollback

Pin the published v0.7.2 commit image `ghcr.io/eliautobot/my-virtual-office:7ca17b3` (or check out tag `v0.7.2`) and recreate only the Virtual Office service. Preserve the `vo-data` and Hermes data volumes.
