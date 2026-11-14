# Virtual Office Provider Contract

Contract version: `1.1`

The Virtual Office core routes agent operations through a provider registry. A
future provider can be installed as an extension without adding provider-name
branches to `server.py`, `game.js`, or `chat.js`.

## Design rules

- Providers own native discovery, authentication, lifecycle calls, and native
  profile synchronization.
- The registry owns stable identity, capability negotiation, normalization, and
  operation dispatch.
- The UI reads provider manifests and agent capabilities. It does not assume
  that every provider behaves like OpenClaw.
- Native files remain authoritative for existing agents. Virtual Office does
  not rewrite them during discovery.
- Unsupported features must be declared as `false`; they are hidden or
  disabled instead of emulated silently.
- Provider secrets and credentials never belong in manifests or browser
  responses.

## Extension discovery

The server loads Python modules named `vo_provider_*.py` (or `vw_provider_*.py`) from:

1. `${VO_STATUS_DIR}/provider-extensions` (in Docker `/data/provider-extensions`, inside the
   `vo-data` volume)
2. Each directory in `VO_PROVIDER_EXTENSION_DIRS` (separated by `:`)

Extensions load only at startup, so restart Virtual Office after adding or changing one. The
shipped `docker-compose.yml` does not forward `VO_PROVIDER_EXTENSION_DIRS`; add it to the
`environment:` list (and mount the folder) before using it.

An extension exports:

```python
def build_provider(context):
    return MyProvider(context)
```

It may return one provider or a list of providers. The object must expose a
`manifest` attribute containing a `ProviderManifest`.

## Minimal provider

```python
from providers.registry import ProviderManifest


class ExampleProvider:
    manifest = ProviderManifest(
        id="example",
        name="Example Runtime",
        description="Example external agent framework",
        icon="🧩",
        category="agent-runtime",
        provider_type="framework",
        capabilities={
            "discover": True,
            "health": True,
            "chat": True,
            "agentCreate": False,
            "agentDelete": False,
            "profileEdit": False,
            "resourcesRead": False,
            "resourcesWrite": False,
            "sessions": False,
        },
        creation_schema={},
        resource_schema=[],
        settings_schema={"version": 1, "configKey": "example", "sections": []},
    )

    def test(self):
        return {
            "ok": True,
            "installed": True,
            "authOk": True,
            "version": "1.0",
        }

    def discover_agents(self):
        return [{
            "providerAgentId": "researcher",
            "name": "Researcher",
            "role": "Research agent",
            "emoji": "🔎",
            "workspace": "/absolute/provider/workspace",
        }]

    def send_chat_message(
        self,
        profile,
        message,
        session_id=None,
        timeout_sec=None,
        on_progress=None,
        files=None,
    ):
        return {
            "ok": True,
            "reply": "Provider reply",
            "sessionId": session_id or "native-session-id",
            "tools": [],
        }
```

`settings_schema` is required: conformance fails without it. Run
`GET /api/office/providers/conformance` after installation. A provider that fails the contract
remains visible in diagnostics but should not be treated as ready.

## Required operations

Capabilities determine which operations are required.

| Capability | Provider operation |
|---|---|
| `health` | `test()` |
| `discover` | `discover_agents()` |
| `chat` | `send_chat_message(profile, message, ...)` |
| `sessions` | `list_sessions(profile, limit=40)` |
| `interrupt` | `interrupt(profile)` |
| `agentCreate` | `create_agent(**fields)` |
| `agentDelete` | `delete_agent(profile)` |
| `profileEdit` | `update_profile(profile, patch)` |
| `approvals` | `pending_approval(...)` and `respond_approval(...)` |

Session create, switch, and delete operations are optional:

- `create_session(profile)`
- `export_session(profile, session_id)` or `read_session(...)`
- `delete_session(profile, session_id)`

When a provider supports fresh conversations but does not allocate a session
until the first message, Virtual Office can clear its local history as the
`sessionCreate` behavior.

## Capability names

The `1.1` contract recognizes:

```text
taskProgress discover health chat streaming sessions sessionCreate sessionDelete
sessionSwitch interrupt approvals agentCreate agentDelete profileEdit
resourcesRead resourcesWrite skills models projects meetings agentToAgent
attachments tools
```

Capabilities are per provider by default. A discovered agent may supply
`capabilityOverrides` for a connection or native agent that is more limited.

Examples:

- A read-only remote connection sets `resourcesWrite: false`.
- A CLI without persistent sessions sets all session capabilities to `false`.
- A provider without native approval events sets `approvals: false`.

## Conformance rules

`GET /api/office/providers/conformance` reports these errors:

- A declared capability without its operation (see Required operations), including
  `approvals` without both `pending_approval()` and `respond_approval()`.
- `category` other than `agent-runtime`.
- No `settings_schema`.
- `agentCreate` without `creation_schema.fields`.
- `resourcesRead` without a `resource_schema`; `resourcesWrite` without at least one writable
  resource; resource entries without `id` and `paths`, with unsafe paths or blanket workspace
  globs; `sensitive` resources that are not hidden.
- `skills` without a `skill_schema` or without `resourcesRead`; skill entries without `id` and a
  relative `path`, or with a format other than `agentskills`.
- `connection_schema` transports that are not objects, have empty or duplicate ids, are
  `network` without `modeKey`, `urlKey`, `schemes` and `defaultEndpoints`, are `process`
  without `executableKey`, or have another kind.

## Canonical agent fields

Discovery returns native rows. The registry adds:

```json
{
  "id": "provider-native-id",
  "statusKey": "provider:native-id",
  "providerKind": "provider",
  "providerType": "framework",
  "providerAgentId": "native-id",
  "providerConnectionId": "default",
  "profile": "native-id",
  "name": "Display name",
  "role": "Agent role",
  "emoji": "🤖",
  "workspace": "/absolute/path",
  "capabilities": {}
}
```

Stable ownership is `providerKind + providerConnectionId + providerAgentId`.
Prefixes are display conventions only; routing never depends on them.

## Creation schema

`creationSchema` drives the New Agent form. Example:

```python
creation_schema={
    "fields": [
        {"name": "name", "label": "Name", "type": "text", "required": True},
        {"name": "role", "label": "Role", "type": "text", "required": True},
        {"name": "emoji", "label": "Emoji", "type": "text"},
        {"name": "prompt", "label": "Standing Prompt", "type": "textarea"},
        {"name": "profile", "label": "Native ID", "type": "text"},
        {"name": "model", "label": "Model", "type": "text"},
    ]
}
```

Provider-specific fields can be added to the schema without changing the
frontend.

## Resource and skill schemas

`resourceSchema` tells the Agent Desk which resources are meaningful:

```python
resource_schema=[
    {
        "id": "identity",
        "label": "Identity",
        "paths": ["IDENTITY.md"],
        "runtimeActive": True,
        "writable": True,
    },
    {
        "id": "nativeAgent",
        "label": "Native agent definition",
        "paths": [".framework/agents/*.yaml"],
        "runtimeActive": True,
        "writable": True,
    },
]
```

The Agent Desk provides:

- path-scoped file access;
- previewed diffs;
- atomic writes;
- SHA revision conflict detection;
- automatic backups;
- history and restore;
- traversal rejection;
- capability-driven read-only behavior.

`skillSchema` separately declares native AgentSkill roots. Skill roots must
point to directories that contain `<skill-name>/SKILL.md`. Virtual Office
validates AgentSkills frontmatter before writes, confines every path and
realpath to the declared root, and creates recoverable backups before
overwrites or deletes. Credential-bearing and undeclared files are never
returned to the browser.

`update_profile()` must synchronize every native file that represents the same
identity or prompt. It should return the paths changed and backup identifier.

## Native auto-detection

Provider detection and agent detection are separate:

1. Virtual Office loads enabled provider manifests.
2. Each provider scans only its configured native roots or remote API.
3. Native rows are normalized and deduplicated by provider ownership.
4. Missing agents become unavailable; they are not silently deleted.
5. Discovery is read-only.

Providers should combine managed workspaces and native definitions. A native
agent found outside Virtual Office must appear without a central code change.

## Standard responses

Successful operation:

```json
{"ok": true}
```

Unsupported operation:

```json
{
  "ok": false,
  "code": "not_supported",
  "error": "Provider does not support operation"
}
```

Chat result:

```json
{
  "ok": true,
  "reply": "text",
  "sessionId": "native-id",
  "tools": [
    {
      "id": "call-id",
      "name": "read",
      "status": "completed",
      "arguments": {},
      "result": ""
    }
  ]
}
```

Health should distinguish installation from readiness:

```json
{
  "ok": true,
  "installed": true,
  "authOk": true,
  "ready": true,
  "version": "1.2.3",
  "error": ""
}
```

An installed but unauthenticated provider may still allow agent creation and
native file editing while chat remains unavailable.

## Chat capability manifest

The chat window never switches features on by provider name. It reads one manifest per agent and
chat, and everything the manifest does not say is off.

`GET /api/agent-chat/can?agent=<office agent id>&session=<provider session key>`

| Field | Meaning |
|---|---|
| `ok` | `true`, or `false` with `reason` (`offline`, `signin`, `gone`, `licence`), `message` and `fix`. On `false` the chat shows the message and fix and offers nothing. |
| `agent`, `kind`, `transport` | The office agent and its provider. `transport` is one of `hermes-serve`, `hermes-api`, `openclaw`, `codex`, `claude-code`, `opencode`, `antigravity`, `builtin`; the chat uses it only to pick the send and stream path. |
| `manage` | `true` when the caller may manage (a browser session or the office machine). The agent API token never manages. |
| `access` | `full` or `chat` (Chat only). |
| `connection` | `{id, name, state, detail, fix}` for the connection line in the chat header. |
| `caps` | The switches below. |
| `locked` | Why a feature is off, by name (`screen`, `browser`, `computerWrite`, `settings`): a sentence the side panel shows on a locked tab. |
| `limits` | `attachmentBytes` (default 25 MB) and `maxFiles` (default 10, at most 50). |
| `prefs` | The chat's current `model` and `effort`. |

`caps` switches (all `true`/`false` unless noted):

| Switch | What the chat shows |
|---|---|
| `stream`, `stop` | Live answer, Stop button. |
| `sessions`, `sessionCreate`, `sessionRename`, `sessionDelete`, `history` | The sessions drawer and its New, Rename and Delete; earlier messages. |
| `models`, `effort` | Model picker and effort picker above the composer. |
| `context` | Context meter. |
| `attachments`, `files` | Attach button; `attachments` without `files` means pictures only. |
| `approvals` + `approvalOptions` | Approval cards. Options from `allow-once`, `allow-session`, `allow-always`, `deny` (default: Allow once and Deny). |
| `questions`, `secrets` | Question cards; secret questions with a hidden input. |
| `plan`, `progressCard` | Plan steps in the chat; the provider's own progress card. |
| `tasks`, `taskSteer` | Side panel Tasks tab; the Steer box for a running task. |
| `queue` | `redirect`, `steer` or `local`: what Enter does while an answer is running. With `redirect` or `steer`, Enter adds to the running turn and Ctrl+Enter sends after it; with `local`, Enter sends after the answer. |
| `observe`, `presence`, `titles`, `media` | Turns started elsewhere, working/waiting dots, live chat titles, inline media. |
| `browser`, `screen`, `computer`, `computerWrite` | Side panel Browser, Screen, and Files (read; write). |

The chat also applies these rules: `computerWrite` needs `computer`, `secrets` needs `questions`,
`progressCard` needs `plan`, `taskSteer` needs `tasks`. The server applies two more: a Chat only
connection never offers `browser`, `screen` or `computerWrite` (it fills `locked` instead), and
`sessionDelete` is off when the caller cannot manage.

### Manifest for Provider SDK providers

Built-in adapters (Hermes over `hermes serve`, OpenClaw) answer the whole manifest themselves. Every
other provider, including Python extensions built with this SDK, gets a manifest built from its
capability names and the agent's `capabilityOverrides`:

| Manifest switch | From |
|---|---|
| `stream`, `stop` | always on |
| `sessions` | `sessions` |
| `sessionCreate` | `sessionCreate` (default: `sessions`) |
| `sessionDelete` | `sessionDelete` |
| `history` | `history` (default: `sessions`) |
| `attachments` | `attachments` |
| `approvals` | `approvals`, with Allow once and Deny |

Everything else is off and `queue` is `local`. Declare those capability names only when the provider
really supports them: the chat offers exactly what they say.

## Universal chat events

The office sends one small event vocabulary to the chat, whatever the provider. In this release the
built-in Hermes (`hermes serve`) and OpenClaw adapters publish it; Provider SDK extensions keep their
own chat path (see Required operations). It is documented here so new adapters can target it.

### Stream and snapshot

- `GET /api/agent-chat/state?agent=<id>&session=<key>` answers a snapshot: `{ok, seq, title,
  working, usage, provider: {status}, runs: [...], approvals: [...], questions: [...]}` plus `plan`,
  `queue`, `model`, `effort` when known. Pending approvals and questions are listed here so a page
  opened late still shows their cards.
- `GET /api/agent-chat/events?agent=<id>&session=<key>` is a Server-Sent Events stream. Each event is
  `id: <seq>` and `data: {seq, ts, scope, session, run, observed, event: {type, ...}}`, where `scope`
  is `chat`, `agent` or `connection`. Comments are heartbeats. Reconnect with `Last-Event-ID` or
  `?since=<seq>`; nothing is sent twice. A `{"type": "resync", "reason": ...}` frame means "read
  `/history` and `/state` again" (after an overflow the stream closes). At most 8 streams per client
  address.

### Turn events

| `event.type` | Fields |
|---|---|
| `run.start` | `label` or `phase`, `observed` (a turn started outside the office) |
| `run.status` | `phase` (or `text`): the run's status line, for example "Waiting for your approval" |
| `run.delta` | `{text, at}` answer piece, `{thinking, tat}` reasoning piece, or `{text, at: 0, replace: true}` whole answer. `at` and `tat` are the piece's offset in the text so far: repeats are dropped, a gap makes the page read the snapshot again. |
| `tool.start` | `toolId`, `name`, `title`, `toolKind`, `input` |
| `tool.update` | `toolId`, `text` (more output), `replace` |
| `tool.end` | `toolId`, `ok` or `status` (`error`/`failed` = failed), `text`, `error`, `exitCode`, `ms` |
| `approval.requested` | `approvalId`, `title`, `command`, `summary`, `options`, `cwd`, `approvalKind` |
| `approval.resolved` | `approvalId`, `decision` |
| `question.requested` | `questionId`, `questions: [{questionId, header, question, options: [{label, recommended, description}], multiSelect, other, secret}]` |
| `question.resolved` | `questionId`, `status`, `answers` |
| `plan.update` | `title`, `steps: [{step, status}]` (`pending`, `in_progress`, `completed`, `cancelled`), `explanation`, `revision` |
| `usage.update` | `used`, `size`, `cost` |
| `run.end` | `status` (`ok`/`completed`, `stopped`/`cancelled`, `interrupted`, `error`/`failed`), final `text`, `steered`, `media: [{url, name, mime, kind, size}]`, `model`, `effort`, `tokensIn`, `tokensOut`, `cost`, `ms`, `error`, `fix` |

The final `text` of `run.end` wins over the pieces. `interrupted` shows its `error` as the reason
("The connection to the agent was lost." when none is given). The chat keeps at most 100,000
characters of an answer, the last 4,000 characters of a tool's output, 5 questions per card, 8
options per question and 20 media items per answer.

Frames that are not part of a turn: `session.task` (Tasks tab), `agent.activity` (drawer dots and
presence), `session.card` (progress card), `native` with `op: "title"` (live chat title),
`provider` / `provider.status` (connection line).

### Answers back

All `POST`, JSON, and only from a browser session or the office machine:

- `/api/agent-chat/runs` `{agent, session, text, files, queue, clientId}`: send. `text` up to
  100,000 characters, up to 10 uploaded `files`, `queue` one of `""`, `redirect`, `later`, `steer`,
  `followup`.
- `/api/agent-chat/stop` `{agent, session, run}`.
- `/api/agent-chat/approvals` `{agent, session, run, approval, decision}`. A settled one answers 409
  `not_pending` ("Already answered").
- `/api/agent-chat/questions` `{agent, session, run, question, answers}` with `answers` as
  `{questionId: [labels]}`, `{value: "..."}` for a secret, or `cancel: true`. Secret values are
  never logged or echoed.
- `/api/agent-chat/prefs` `{agent, session, model, effort}` (only the keys sent change).

Errors everywhere are an HTTP status plus `{ok: false, error, message, fix}`.

## Validation checklist

Before enabling a provider:

1. Run `/api/office/providers/conformance`.
2. Confirm native agent discovery and stable IDs across restarts.
3. Create a namespaced real agent.
4. Confirm every declared capability works.
5. Confirm unsupported controls are hidden or rejected cleanly.
6. Test profile synchronization against actual native files.
7. Test file preview, save, conflict, backup, restore, and traversal rejection.
8. Test chat, tool events, sessions, interrupt, attachments, projects,
   meetings, and agent-to-agent communication when declared.
9. Confirm authentication failures are concise and actionable.
10. Delete the test agent and verify native cleanup.
