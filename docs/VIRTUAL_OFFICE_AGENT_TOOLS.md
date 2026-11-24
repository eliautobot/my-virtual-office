# Virtual Office Agent Tools

Status: canonical agent-facing tool index  
Scope: My Virtual Office Product

## Purpose

This document is the organized index for tools that agents can use through My Virtual Office. It avoids duplicate scattered instructions and points every platform toward the same office-owned surfaces.

The provider contract is documented in [Provider SDK](PROVIDER-SDK.md).

## Calling the office API

Agents on the office machine can call the API directly. When the office has a passcode
(Settings > Security), calls from other machines or from a Docker network must send the agent
API token as `Authorization: Bearer <token>` or `X-Virtual-Office-Token: <token>`. Read the
token from Settings > Security (shown once a passcode is set, or `GET /api/access/agent-token` from the office machine), or
set a fixed one with `VO_AGENT_API_TOKEN`. Browser pages from other sites can never change
office state (cross-site protection is always on).

With a passcode set, the token cannot change the office's settings: provider and setup settings,
the gateway, model providers and keys (`/api/native-models/*`, `/set-model`), the licence, the SMS
takeover switches, and adding or deleting agents answer `403` with "Agents cannot do this through
the office API token" (even from the office machine when the token is sent). A person signed in to
the office makes those changes. Everything below that is an agent's own work (presence, chat,
meetings, projects and tasks, files, skills, previews) works with the token.

## Built-in skills

Virtual Office writes these skills into the Skills Library at every start so agents can learn how to use office tools without custom platform code:

- `AgentPlatform-to-AgentPlatform_Communications`
- `VirtualOffice-Presence-and-Status`
- `VirtualOffice-Browser-Control`
- `VirtualOffice-Meetings`
- `VirtualOffice-Projects-and-Tasks`

Skills Library endpoints:

- `GET /api/skills-library`
- `GET /api/skills-library/<skill-name>`
- `POST /api/skills-library/apply`

The raw cross-platform communication skill is also exposed at:

- `GET /api/agent-platform-communications/skill`

## Tool surfaces

### Agent platforms

Use when the office needs to create or remove agents on a connected platform. With a passcode
set these are for a signed-in person or the office machine without the token (see above).

- `GET /api/agent-platforms`
- `POST /api/agent/create`
- `DELETE /api/agent/delete`

`POST /api/agent/create` accepts any enabled provider whose manifest declares `agentCreate`: `openclaw`, `codex`, `claude-code`, `opencode`, `antigravity` and provider extensions. Aliases such as `claude` and `agy` also work. Hermes creation is available only with `VO_HERMES_LOCAL_PROFILES_ENABLED=true` and a Hermes CLI inside the container; it then maps one office agent to one Hermes profile and runs `hermes profile create/delete`. API-only Hermes connections cannot create profiles. OpenClaw creation goes through Gateway `agents.create` / `agents.files.set` so the agent is runnable immediately and files are owned by the OpenClaw user. Codex creation maps one office agent to a Codex workspace, writes `AGENTS.md` plus `.codex/agents/<profile>.toml`, and chats through Codex's native app-server JSON-RPC protocol. Claude Code creation maps one office agent to a Claude Code workspace, writes `AGENTS.md`, `CLAUDE.md`, and `.claude/agents/<profile>.md`, and chats through Claude Code's native `stream-json` CLI protocol. Deleting an agent never deletes your own files: a standard agent folder inside the office-managed root is removed, but for an agent created in a custom folder only the files Virtual Office wrote are removed (then any folders left empty).

Codex creation supports two location modes:

- `codexCreationMode: "standard"`: create under configured `codex.workspaceRoot` and register `$CODEX_HOME/agents/<profile>.toml` when native registration is enabled.
- `codexCreationMode: "custom"` with `codexCustomDirectory`: create `<codexCustomDirectory>/<profile>` and write project-local `.codex/agents/<profile>.toml`. Virtual Office stores a registry entry under `codex.workspaceRoot` so the custom agent remains discoverable.

Codex discovery also reads the standard `$CODEX_HOME/agents/*.toml` custom-agent directory and includes a synthesized `codex-main` entry for Codex's default Main agent.

Codex app-server approval requests are surfaced through chat history while a turn is running. The web chat renders pending command, file-change, and permission approval cards with Approve/Cancel controls. Integrations can also poll `GET /api/codex/approval/pending?agentId=<id>` and answer the active callback with `POST /api/codex/approval/respond` using `approval_id` and `choice: "approve"` or `"cancel"`.

Claude Code creation supports two location modes:

- `claudeCodeCreationMode: "standard"`: create under configured `claudeCode.workspaceRoot` and register `$CLAUDE_CONFIG_DIR/agents/<profile>.md` when native registration is enabled.
- `claudeCodeCreationMode: "custom"` with `claudeCodeCustomDirectory`: create `<claudeCodeCustomDirectory>/<profile>` and write project-local `.claude/agents/<profile>.md`. Virtual Office stores a registry entry under `claudeCode.workspaceRoot` so the custom agent remains discoverable.

Claude Code discovery also reads native `$CLAUDE_CONFIG_DIR/agents/*.md` subagents and includes a synthesized `claude-code-main` entry for Claude Code's default Main agent.

Claude Code chat uses `claude -p --output-format stream-json --include-partial-messages` with `--resume <session_id>` when available. The adapter converts assistant deltas, `tool_use` blocks, `tool_result` blocks, usage metadata, run completion, and interrupts into the same Virtual Office chat/event shapes used by Hermes and Codex.

Codex configuration is product-neutral:

- `VO_CODEX_BIN`: Codex CLI executable, default `codex` on `PATH`
- `VO_CODEX_HOME`: Codex auth/config home for this deployment, default `VO_STATUS_DIR/codex-home` in Docker
- `VO_CODEX_WORKSPACE_ROOT`: Office-created Codex agent workspaces
- `VO_CODEX_MAIN_WORKSPACE`: Workspace used by `codex-main` and native custom agents
- `VO_CODEX_INCLUDE_MAIN`: include Codex's default Main agent, enabled by default
- `VO_CODEX_INCLUDE_NATIVE_AGENTS`: read `$CODEX_HOME/agents/*.toml`, enabled by default
- `VO_CODEX_REGISTER_NATIVE_AGENTS`: write `$CODEX_HOME/agents/<profile>.toml` when creating VO Codex agents, enabled by default
- `VO_CODEX_PREFER_APP_SERVER`: native app-server integration on by default
- `VO_CODEX_SANDBOX`: Codex sandbox mode, Docker example defaults to `danger-full-access` because bubblewrap sandboxing usually needs extra container privileges
- `VO_CODEX_APPROVAL_POLICY`: starting approval policy of a Codex agent nobody has set yet, default `untrusted` (Ask first). The owner's choice in the agent's chat window (Permissions, saved in `agent-permissions.json`) wins over it; with Ask first a run waits for the approval card in that agent's chat

Claude Code configuration is product-neutral:

- `VO_CLAUDE_CODE_BIN`: Claude Code CLI executable, default `claude` on `PATH`
- `VO_CLAUDE_CODE_HOME`: Claude config/auth directory for this deployment
- `VO_CLAUDE_CODE_WORKSPACE_ROOT`: Office-created Claude Code agent workspaces
- `VO_CLAUDE_CODE_MAIN_WORKSPACE`: Workspace used by `claude-code-main` and native subagents
- `VO_CLAUDE_CODE_MODEL`: optional default Claude Code model
- `VO_CLAUDE_CODE_PERMISSION_MODE`: starting permission mode of a Claude Code agent nobody has set yet, default `acceptEdits` (Edit files); the owner's choice in the chat window wins over it
- `VO_CLAUDE_CODE_INCLUDE_MAIN`: include Claude Code's default Main agent, enabled by default
- `VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS`: read `$CLAUDE_CONFIG_DIR/agents/*.md`, enabled by default
- `VO_CLAUDE_CODE_REGISTER_NATIVE_AGENTS`: write `$CLAUDE_CONFIG_DIR/agents/<profile>.md` when creating standard VO Claude Code agents, enabled by default

OpenCode configuration (off by default, enable with `VO_OPENCODE_ENABLED=true`; the CLI must be inside the container):

- `VO_OPENCODE_BIN`: OpenCode CLI executable, default `opencode`
- `VO_OPENCODE_CONFIG_DIR`: OpenCode config directory, default `/data/opencode-config` in Docker
- `VO_OPENCODE_WORKSPACE_ROOT`: Office-created OpenCode agent workspaces
- `VO_OPENCODE_MAIN_WORKSPACE`: workspace of the OpenCode Main agent
- `VO_OPENCODE_INCLUDE_MAIN`, `VO_OPENCODE_INCLUDE_AGENTS`, `VO_OPENCODE_REGISTER_AGENTS`: discovery and registration switches, enabled by default
- `VO_OPENCODE_MODEL`, `VO_OPENCODE_TIMEOUT_SEC` (default 900): optional, not forwarded by the shipped compose file

Antigravity configuration (off by default, enable with `VO_ANTIGRAVITY_ENABLED=true`; authentication stays with its native CLI):

- `VO_ANTIGRAVITY_BIN`: Antigravity CLI executable, default `agy`
- `VO_ANTIGRAVITY_HOME`: Antigravity config directory, default `/data/antigravity-config` in Docker
- `VO_ANTIGRAVITY_WORKSPACE_ROOT`: Office-created Antigravity agent workspaces
- `VO_ANTIGRAVITY_PRINT_TIMEOUT`: per-run print timeout, default `5m`
- `VO_ANTIGRAVITY_MODEL`, `VO_ANTIGRAVITY_SANDBOX`, `VO_ANTIGRAVITY_TIMEOUT_SEC` (default 600): optional, not forwarded by the shipped compose file

Never hardcode host usernames, personal auth paths, or a developer's local container layout into provider support.

### AgentPlatform-to-AgentPlatform Communications

Use when agents need to talk across providers and the exchange should be visible in Virtual Office.

- `POST /api/agent-platform-communications/send`
- `GET /api/agent-platform-communications/history`

Events are stored in:

- `VO_STATUS_DIR/agent-platform-communications.jsonl`

These events are merged into `/agent-chat`, so chat bubbles can show cross-platform interactions.

### Presence and status

Virtual Office derives live presence from gateway/session activity. Use these
endpoints when an external adapter or broker needs to set an explicit visible
state that cannot be inferred automatically.

- `GET /api/presence`
- `GET /status`
- `POST /api/presence/<agentId>`

Allowed common states:

- `working`
- `idle`
- `break`
- `meeting`

### Browser control

Current safe read/status endpoints:

- `GET /browser-status`
- `GET /browser-tabs`
- `GET /browser-controller`

Important: agents should not use raw Kasm/CDP credentials directly. A provider-neutral browser action API should be added before non-OpenClaw agents are given direct browser control.

### Meetings

- `GET /api/meetings/active`
- `GET /api/meetings/history`
- `POST /api/meetings/create`
- `POST /api/meetings/end`
- `POST /api/meetings/end-all`

Meetings should always end with a summary/resolution/action items.

### Projects and tasks

- `GET /api/projects`
- `GET /api/projects/<projectId>`
- `POST /api/projects`
- `POST /api/projects/<projectId>/tasks`
- `PUT /api/projects/<projectId>/tasks/<taskId>`
- `GET /api/projects/<projectId>/workflow/status`
- `POST /api/projects/<projectId>/workflow/start`
- `POST /api/projects/<projectId>/workflow/stop`
- `GET /api/projects/scores`

Use these for durable work that belongs on a board.

## Organization rules

- Use this file as the canonical index.
- Use skill files for concise agent instructions.
- Use provider adapter docs for implementation details.
- Do not duplicate generic browser automation skills as Virtual Office browser skills. `agent-browser` is generic; `VirtualOffice-Browser-Control` is specifically for the office-owned browser surface.
- Future tools should add one section here and one built-in skill only if agents need direct instructions.

## Current gaps

- Provider-neutral browser action endpoint is not implemented yet.
- File/upload tool skill is not yet added; add it only after the intended agent-facing file endpoints are finalized.
- Calendar/scheduler skill is not yet added; add it only if Virtual Office owns those endpoints instead of delegating to OpenClaw/provider tools.
