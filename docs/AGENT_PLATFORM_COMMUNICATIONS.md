# AgentPlatform-to-AgentPlatform Communications

Status: supported.

## Goal

Give My Virtual Office a built-in communication layer that agent platforms can use to talk to each other through the office instead of through offscreen private CLI calls.

This is the foundation for visible cross-platform conversations between OpenClaw, Hermes, and future provider adapters.

## Built-in skill

Skill name:

`AgentPlatform-to-AgentPlatform_Communications`

The skill is seeded into the Virtual Office Skills Library and is also exposed at:

`GET /api/agent-platform-communications/skill`

Agents can read/apply the skill and learn the endpoint without custom code.

## Send endpoint

`POST /api/agent-platform-communications/send`

Body:

```json
{
  "fromAgentId": "main",
  "toAgentId": "hermes-default",
  "message": "Hi Hermes, can you review this?",
  "conversationId": "optional-thread-id",
  "metadata": {"topic": "optional"}
}
```

Response:

```json
{
  "ok": true,
  "conversationId": "main__hermes-default",
  "messageId": "...",
  "replyMessageId": "...",
  "reply": "..."
}
```

## History endpoint

`GET /api/agent-platform-communications/history?conversationId=<id>`

Optional filters:

- `conversationId`
- `agentId`
- `limit`

Events are stored in:

`VO_STATUS_DIR/agent-platform-communications.jsonl`

Each event has a normalized shape with:

- schema
- id
- timestamp
- conversationId
- direction: `request` or `reply`
- from agent ref
- to agent ref
- text
- metadata
- visibleInOffice flag

## Current routing

Messages are delivered through the same provider routing as office chat, so any provider
with chat support can be a target: OpenClaw, Hermes, Codex, Claude Code, OpenCode, Antigravity
and provider extensions (see [Provider SDK](PROVIDER-SDK.md)).

## Visibility

This implementation logs conversations in an office-owned communication log. `/agent-chat` merges those communication events into each involved agent's chat-bubble payload so cross-platform agent conversations are visible instead of happening offscreen.

## Security

The send endpoint makes a real agent do work, so treat it like the rest of the office API:

- Browser requests from other sites are always refused (cross-site protection).
- Without an office passcode, anyone who can reach the office port can call this endpoint.
  Keep Virtual Office on a private network (see the README, Security and remote access).
- With an office passcode (Settings > Security), calls must come from the office machine
  itself, from a logged-in browser, or carry the agent API token
  (`Authorization: Bearer <token>` or `X-Virtual-Office-Token`).
