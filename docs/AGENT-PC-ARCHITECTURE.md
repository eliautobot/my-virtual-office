# Agent PC Architecture

Status: production feature contract  
Applies to: My Virtual Office

## Product intent

Agent PC is a read-mostly view of an agent's real working environment. It is
not a task dashboard, approval queue, IDE, or second agent filesystem.

Every route opens the same window:

- a Preview Bubble opens the relevant resource in the Agent PC;
- an agent character's PC action opens that agent's last PC state;
- an assigned desk monitor opens that agent's PC even when no live preview
  exists.

The character action launcher also exposes in-world speech, full chat, and
agent settings. Agents without an assigned desk anchor live Preview Bubbles to
their character.

## Data ownership

Agent PC keeps four kinds of data separate:

| Data | Owner | Persistence |
|---|---|---|
| Home and connected files | Agent provider / user's filesystem | Existing provider or host storage |
| Recent, Sources, Outputs | My Virtual Office index | SQLite under `VO_STATUS_DIR` |
| Saved items | My Virtual Office | Content-addressed copies under `VO_STATUS_DIR/agent-pc/saved` |
| Open tabs and navigation state | My Virtual Office | SQLite per agent |

Files are never copied merely because they are listed or previewed. Repeated
activity against the same canonical resource updates one indexed row. Only an
explicit Save action creates a durable managed copy.

## Agent lifecycle

An immutable My Virtual Office agent key owns the Agent PC profile. Display
names do not control ownership.

When an agent is created or first discovered:

1. My Virtual Office creates or refreshes its Agent PC profile.
2. The provider's declared workspace becomes the Home root when available.
3. The PC is immediately callable, including when Home is temporarily offline.
4. Existing Home files are browsable but are not bulk indexed.

When an agent is removed or deleted:

1. Its Agent PC profile is archived.
2. New activity tracking stops.
3. Recent metadata, Saved items, and UI provenance remain.
4. Provider or project files are not deleted by Agent PC.

Provider-agent deletion and filesystem deletion remain separate provider
operations. Reusing a display name never inherits an archived profile unless
the immutable provider identity is deliberately reconnected.

## Roots and cross-platform paths

The browser never receives unrestricted host filesystem access. It addresses
resources with an opaque `rootId` and a safe relative path.

Root kinds:

- `home`: the provider-declared workspace;
- `connected`: an administrator-approved external root;
- `saved`: My Virtual Office's managed Saved area.

Provider paths are resolved into server-visible paths. A configured mapping is
required when the provider and My Virtual Office use different namespaces:

```json
[
  {
    "id": "windows-projects",
    "label": "Windows Projects",
    "hostPath": "C:\\Users\\you\\Projects",
    "containerPath": "/agent-mounts/windows-projects",
    "readOnly": true
  }
]
```

Configure mappings with `VO_AGENT_PC_PATH_MAPPINGS_JSON`. The container path
must already exist. Agent PC does not mutate Docker mounts at runtime.

Supported deployment patterns:

| Deployment | Access path |
|---|---|
| Native Linux/macOS/Windows server and local provider | Provider workspace path directly |
| Docker and provider on same host | Bind mount plus host/container path mapping |
| Docker Desktop and provider on Windows | Windows host path mapped to a Linux container path |
| Server and provider on different computers | Authenticated Agent Files Connector (transport contract below) |

The included connector transport is capability-based: list approved roots,
enumerate a root, stat/read an allowed file, and stream byte ranges. It does
not expose arbitrary absolute paths or command execution. When disconnected,
cached metadata and Saved items remain visible while live resources show
Offline.

My Virtual Office points at the connector with the same mapping variable:

```json
[
  {
    "id": "remote-windows-projects",
    "label": "Windows Projects",
    "hostPath": "D:\\Projects",
    "connectorUrl": "https://windows-provider.example:8765",
    "connectorToken": "a-long-random-secret",
    "connectorRootId": "projects",
    "readOnly": true
  }
]
```

On the provider computer, copy
`integrations/agent-files-connector.example.json`, set a random token and the
approved roots, then run:

```shell
python app/agent_files_connector.py --config connector.json
```

The connector binds to loopback by default. Remote deployments should use its
TLS certificate settings or a trusted encrypted overlay. My Virtual Office
rejects non-loopback HTTP connectors unless
`VO_AGENT_PC_ALLOW_INSECURE_CONNECTORS=true` is explicitly configured.

## Activity ingestion

Meaningful file and source activity can arrive from:

1. explicit `/api/previews` publications;
2. normalized provider lifecycle/tool events observed by the server;
3. the browser chat event stream while connected;
4. future remote connector change records.

All inputs pass through the same classifier and idempotent upsert. The index
distinguishes:

- `source`: read/view/fetch activity;
- `output`: write/edit/patch/generate activity;
- `recent`: the union ordered by last touch;
- `browser`: a live shared viewer, not a filesystem artifact.

Opening or version-checking a file from the read-only Agent PC is deliberately
not recorded as agent activity. Live version polling is limited to the visible
Preview Bubble resource for each agent and the one actively viewed PC tab;
background and Saved tabs do not continuously probe provider files.

The default retention is 100 recent resources per agent and 90 days. Saved
items never expire automatically. Cleanup never deletes provider-owned files.

## HTTP contract

Agent PC endpoints are rooted at `/api/agent-pc`:

- `GET /api/agent-pc/{agentId}`: profile, roots, recent lists, saved items,
  capabilities, and persisted UI state;
- `GET /api/agent-pc/{agentId}/tree?rootId=...&path=...`: bounded directory
  listing;
- `GET /api/agent-pc/{agentId}/descriptor?...`: safe preview descriptor;
- `GET /api/agent-pc/{agentId}/content?...`: streamed file or Saved content;
- `POST /api/agent-pc/{agentId}/activity`: idempotent recent/source/output
  upsert;
- `POST /api/agent-pc/{agentId}/roots`: connect an approved mapping/subfolder;
- `DELETE /api/agent-pc/{agentId}/roots/{rootId}`: disconnect metadata only;
- `POST /api/agent-pc/{agentId}/saved`: save a file snapshot or URL bookmark;
- `DELETE /api/agent-pc/{agentId}/saved/{savedId}`: remove a managed Saved
  item;
- `PUT /api/agent-pc/{agentId}/state`: persist open tabs and navigation state.

## Security invariants

- Every filesystem operation resolves an opaque root plus a normalized
  relative path and verifies the real path remains inside the root.
- Symlink escapes are rejected.
- Hidden path components, credential filenames, private keys, and unsupported
  resource types are not exposed.
- Listings are bounded and skip noisy dependency/cache directories.
- Preview size limits are type-specific and content is served with `nosniff`,
  no-store caching, sandbox CSP, and byte-range support.
- Connected roots are read-only from Agent PC even when their underlying mount
  is writable for provider runtimes.
- External folders are never deleted when an agent is removed.

## UX contract

The expanded window is titled `<Agent Name>'s PC` and contains:

- Recent
- Sources
- Outputs
- Files (Home and Connected Folders)
- Saved

Files open in tabs in the existing preview surface. Closing a tab closes only
the view. The source file and index remain. Each agent restores its own tabs,
selected section, and last selection.

Connect Folder selects from server-approved mappings and explains missing
Docker/remote connectivity rather than pretending a browser can mount a host
folder. The PC remains usable in a clear offline/read-only state.

## Non-goals

- editing, moving, renaming, or deleting provider files;
- task assignment, approvals, or review workflow;
- cloning every provider workspace;
- silently exposing a whole host filesystem;
- dynamically changing Docker bind mounts;
- treating session deletion as artifact deletion.

## Verification

The focused backend, HTTP, connector, provider-observer, and browser-hub tests
live under `tests/`. The repeatable load suite is:

```shell
python3 tests/stress_agent_pc.py
```

It exercises bounded large-directory listing, concurrent idempotent activity
upserts, retention, Saved-blob deduplication/cleanup, and persisted tab state.
