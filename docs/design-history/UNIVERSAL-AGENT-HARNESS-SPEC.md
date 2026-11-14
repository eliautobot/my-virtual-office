# Universal Agent Harness Spec

Status: superseded early draft, kept for history. The implemented provider contract is
documented in `docs/PROVIDER-SDK.md`; the provider registry and the six built-in providers
(OpenClaw, Hermes, Codex, Claude Code, OpenCode, Antigravity) live in `app/providers/`.  
Scope: Turn My Virtual Office from an OpenClaw-specific control surface into a universal multi-provider office runtime that can host, route, visualize, and coordinate agents from many systems at once.

---

## 1. Summary

My Virtual Office should evolve from:

- one office connected to one OpenClaw backend

into:

- one office runtime that can host agents from multiple provider systems at the same time
- one shared agent directory, task space, message bus, and project model
- one office where an OpenClaw agent can talk to a Hermes agent, which can talk to a Claude Code or Codex worker, all as first-class office citizens

This spec defines the architecture for that universal harness.

---

## 2. Product goal

The user should be able to:

- connect multiple agent providers to one office
- see all agents in one shared office at once
- chat with any agent from one UI
- let agents message each other across providers
- assign projects and tasks across providers
- run automations across providers
- manage a mostly unified settings experience while preserving provider-specific power where needed

Example target scenario:

- `openclaw:main` delegates research to `hermes:research-1`
- `hermes:research-1` asks `claude-code:frontend-dev` to inspect a repo
- `codex:reviewer` reviews the output
- all activity appears in the same office, same meeting system, same project, same task thread

---

## 3. Non-goals

This project should not try to:

- replace the native runtime internals of OpenClaw, Hermes, Claude Code, Codex, etc.
- force all providers to expose the same native feature set
- fully normalize every provider-specific capability into one least-common-denominator UI
- require providers to implement a brand-new external protocol before they can be useful

The office is a broker and control plane, not a reimplementation of every provider.

---

## 4. Core architectural decision

My Virtual Office becomes the **shared office runtime** above provider runtimes.

### 4.1 Layers

1. **Office Runtime / Broker**
   - canonical system of record for office identity, routing, projects, tasks, meetings, and normalized events

2. **Provider Adapters**
   - connect external systems into the office
   - examples: OpenClaw adapter, Hermes adapter, Claude Code adapter, Codex adapter

3. **Office UI**
   - renders normalized office state, not raw provider payloads

### 4.2 Important consequence

Providers do not talk to each other directly.

They talk through the office runtime:

- agent A sends a message to the broker
- broker resolves recipient, permissions, project context, and thread
- recipient adapter delivers message into recipient provider
- adapter returns normalized events back to broker
- broker updates office state and fanout

This keeps the product coherent.

---

## 5. Supported provider classes

The system must support more than one adapter category.

### 5.1 Runtime providers

Full agent runtimes with their own session and agent concepts.

Examples:
- OpenClaw
- Hermes
- future orchestrators

### 5.2 Harness providers

CLI or session-based coding agents managed by the office.

Examples:
- Claude Code
- Codex
- Gemini CLI
- OpenCode
- Aider

### 5.3 API providers

HTTP or WebSocket services that can act like agents.

Examples:
- custom internal AI services
- hosted orchestrators
- domain-specific remote agents

---

## 6. Canonical office models

The following models are the product truth. Provider data is mapped into them.

## 6.1 OfficeAgent

```ts
export type OfficeAgent = {
  id: string;                     // canonical office id, e.g. "openclaw:main"
  providerId: string;             // e.g. "openclaw-main", "hermes-local", "claude-code"
  providerType: "runtime" | "harness" | "api";
  providerAgentId: string;        // native provider id
  name: string;
  role: string | null;
  branchId: string | null;
  deskId: string | null;
  avatar: OfficeAvatar | null;
  status: OfficeAgentStatus;
  capabilities: string[];
  projectIds: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};
```

### 6.2 OfficeAgentStatus

```ts
export type OfficeAgentStatus =
  | "offline"
  | "idle"
  | "working"
  | "thinking"
  | "meeting"
  | "waiting_input"
  | "waiting_approval"
  | "error";
```

### 6.3 OfficeThread

```ts
export type OfficeThread = {
  id: string;
  projectId: string | null;
  title: string | null;
  participants: string[]; // OfficeAgent ids
  visibility: "private" | "project" | "office";
  source: "user" | "agent" | "system";
  createdAt: number;
  updatedAt: number;
};
```

### 6.4 OfficeMessage

```ts
export type OfficeMessage = {
  id: string;
  threadId: string;
  senderAgentId: string | null;
  senderKind: "user" | "agent" | "system";
  text: string;
  attachments: OfficeAttachment[];
  providerRef?: {
    providerId: string;
    nativeSessionId?: string;
    nativeMessageId?: string;
    nativeRunId?: string;
  };
  createdAt: number;
};
```

### 6.5 OfficeProject

```ts
export type OfficeProject = {
  id: string;
  name: string;
  description: string | null;
  rootPath: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
  linkedAgentIds: string[];
  sharedContextId: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};
```

### 6.6 OfficeAutomation

```ts
export type OfficeAutomation = {
  id: string;
  name: string;
  targetAgentId: string | null;
  targetThreadId: string | null;
  projectId: string | null;
  schedule: OfficeSchedule;
  action: OfficeAutomationAction;
  executor: {
    kind: "provider-native" | "office-runtime";
    providerId?: string;
  };
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: "ok" | "error" | null;
  createdAt: number;
  updatedAt: number;
};
```

### 6.7 OfficePromptPack

The canonical prompt/personality representation.

```ts
export type OfficePromptPack = {
  identity: string | null;
  mission: string | null;
  style: string | null;
  boundaries: string | null;
  memory: string | null;
  userContext: string | null;
  projectContext: string | null;
  extraSections: Array<{ key: string; title: string; content: string }>;
  updatedAt: number;
};
```

Important: `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, etc. are provider/workspace materializations of this model, not the canonical truth.

---

## 7. Capability model

Every provider and every agent can expose capabilities.

```ts
export type OfficeCapability =
  | "chat"
  | "streaming"
  | "projects"
  | "workspace"
  | "files.read"
  | "files.write"
  | "shell"
  | "automation.native"
  | "automation.office"
  | "approvals.native"
  | "settings.raw"
  | "multi-agent"
  | "agent-management"
  | "prompt-pack.sync"
  | "sessions.persistent"
  | "review"
  | "browser"
  | "voice";
```

Rules:

- the UI must gate features by capability
- unsupported features must be hidden or marked unavailable
- no fake success paths
- if the office can emulate a feature safely, expose it as office-owned, not native

---

## 8. Provider adapter contract

Each provider adapter implements a shared contract.

```ts
export interface OfficeProviderAdapter {
  id: string;
  label: string;
  type: "runtime" | "harness" | "api";

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  health(): Promise<ProviderHealth>;

  listAgents(): Promise<ProviderAgentRecord[]>;
  getAgent(providerAgentId: string): Promise<ProviderAgentRecord | null>;
  createAgent?(input: CreateProviderAgentInput): Promise<ProviderAgentRecord>;
  updateAgent?(providerAgentId: string, patch: ProviderAgentPatch): Promise<void>;
  deleteAgent?(providerAgentId: string): Promise<void>;

  listThreads?(agentId?: string): Promise<ProviderThreadRecord[]>;
  getThreadMessages?(threadId: string): Promise<ProviderMessageRecord[]>;

  sendMessage(input: ProviderSendMessageInput): Promise<ProviderSendMessageResult>;
  interrupt?(input: ProviderInterruptInput): Promise<void>;

  syncPromptPack?(providerAgentId: string, promptPack: OfficePromptPack): Promise<void>;
  loadPromptPack?(providerAgentId: string): Promise<OfficePromptPack | null>;

  bindProject?(providerAgentId: string, project: OfficeProject): Promise<void>;

  listAutomations?(providerAgentId?: string): Promise<ProviderAutomationRecord[]>;
  upsertAutomation?(input: ProviderAutomationInput): Promise<void>;
  deleteAutomation?(automationId: string): Promise<void>;

  supports(capability: OfficeCapability): boolean;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}
```

---

## 9. Office runtime responsibilities

The Office Runtime, called the **Office Broker**, owns the following responsibilities.

### 9.1 Registry

- maintain canonical office agent ids
- map provider agents into office agents
- handle provider attach/detach
- persist office-only attributes like avatar, desk, branch, tags

### 9.2 Routing

- route user-to-agent, agent-to-agent, and system-to-agent messages
- resolve destination provider adapter
- maintain shared threads across providers
- enforce permissions and visibility

### 9.3 Event normalization

- consume provider-native events
- normalize into office events
- fanout to UI and internal systems

### 9.4 State persistence

- agents
- threads
- messages
- projects
- meetings
- automations
- office layout preferences
- provider connection profiles

### 9.5 Presence / animation mapping

- translate runtime state into office state
- drive walking, sitting, thinking, meeting, error indicators, etc.

### 9.6 Automation execution

- run office-owned automations when provider-native scheduling is unavailable
- optionally delegate native automations to providers when supported

---

## 10. Office event model

The office UI should consume office-native events, not raw provider payloads.

```ts
export type OfficeEvent =
  | { type: "agent.registered"; agent: OfficeAgent }
  | { type: "agent.updated"; agent: OfficeAgent }
  | { type: "agent.removed"; agentId: string }
  | { type: "agent.status.changed"; agentId: string; status: OfficeAgentStatus }
  | { type: "thread.created"; thread: OfficeThread }
  | { type: "message.created"; message: OfficeMessage }
  | { type: "message.delta"; threadId: string; senderAgentId: string; textDelta: string }
  | { type: "task.updated"; taskId: string; status: string }
  | { type: "meeting.updated"; meetingId: string; state: string }
  | { type: "automation.updated"; automation: OfficeAutomation }
  | { type: "provider.health"; providerId: string; health: ProviderHealth };
```

Provider adapters may still emit provider-specific payloads for advanced tooling, but the office UI should not depend on them.

---

## 11. Cross-provider messaging model

This is the defining feature of the universal harness.

## 11.1 Rules

- all cross-provider messaging goes through the Office Broker
- every message belongs to an office thread
- provider-native sessions are linked, not treated as the canonical thread
- the broker is responsible for correlation ids and transcript stitching

## 11.2 Flow

1. sender creates or appends to an office thread
2. broker stores canonical message
3. broker resolves recipient adapter
4. adapter delivers the message to the native provider session
5. adapter emits normalized deltas/final output
6. broker appends those back into the same office thread

## 11.3 Context policy

Each send operation may define one of:

- `full-thread` - send recent office thread context
- `project-summary` - send project summary and last N messages
- `task-brief` - send distilled task brief only
- `custom` - explicit adapter input prepared by the sender or system

This avoids uncontrolled transcript bloat.

---

## 12. Settings architecture

Settings must be split into layers.

## 12.1 Office-owned settings

Examples:
- desk assignment
- avatar/look
- branch/team placement
- office room behavior
- movement preferences
- visible title and badge styling
- office notification preferences

These do not belong to any provider.

## 12.2 Universal agent settings

Examples:
- display name
- role/title
- prompt pack
- boundaries
- project assignment
- automation targets
- tags

These are canonical office settings, optionally synced into providers.

## 12.3 Provider-backed settings

Examples:
- OpenClaw tool policy, exec approvals, sandbox mode
- Hermes orchestration config
- Claude Code model / permission mode / workspace policy
- Codex execution profile

These are shown in provider-specific tabs.

## 12.4 Raw advanced settings

Examples:
- raw config files
- raw workspace file editors
- provider-native debug/status

This should be advanced mode only.

---

## 13. Prompt pack materialization

The office should edit canonical prompt data, then materialize it into provider-specific shapes.

### 13.1 OpenClaw materialization

Possible files:
- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `MEMORY.md`
- `memory/YYYY-MM-DD.md`

### 13.2 Hermes materialization

Options:
- sync to Hermes agent instructions/system prompt
- optionally write adapter-managed files if workspace-backed mode exists

### 13.3 Claude Code / Codex materialization

Options:
- inject as session bootstrap system context
- write office-managed prompt files inside a workspace folder, for example `.office/`
- sync project prompt pack into a worktree bootstrap folder

Rule: the UI edits `OfficePromptPack`, not raw `AGENTS.md` as the main UX.

---

## 14. Projects architecture

Projects must be first-class office objects.

### 14.1 Canonical project ownership

The office runtime owns:
- project identity
- repo/root path metadata
- shared context
- linked agents
- active tasks
- project-level threads

### 14.2 Provider binding

Each provider may bind a project differently.

#### OpenClaw
- workspace path
- project folders
- skills/context in workspace

#### Hermes
- shared project context
- linked sub-agents
- optional workspace binding if supported

#### Claude Code / Codex
- repo checkout or worktree path
- session cwd
- bootstrap prompt files
- branch/worktree strategy

Projects are not “just folders inside OpenClaw.” That is only one provider strategy.

---

## 15. Automations architecture

The current OpenClaw-native cron model becomes a universal automation model.

### 15.1 Canonical office automation

Users create automations in one UI.

Each automation chooses an executor:

- `provider-native` when the provider supports reliable native scheduling
- `office-runtime` when the office should schedule and dispatch the action itself

### 15.2 Why this matters

This allows:
- OpenClaw agents to use OpenClaw cron if desired
- Hermes agents to use Hermes-native scheduling if available
- Claude Code or Codex agents to still participate through office-run scheduling

### 15.3 UI rule

The main UI says `Automations`, not `OpenClaw Cron`.

Advanced views may still expose native provider scheduler details.

---

## 16. Claude Code and Codex integration model

Claude Code and Codex should be handled as **harness-backed providers**.

## 16.1 Why

They are not full gateway runtimes in the OpenClaw sense.
They are managed sessions and workers.

## 16.2 What the office adapter owns

- session launch / resume / terminate
- workspace binding
- run state detection
- transcript persistence
- prompt pack injection
- activity normalization
- mapping native session state to office presence

## 16.3 Office presence mapping

- idle -> seated / wandering
- running -> typing / working state
- waiting input -> visible prompt / raised hand indicator
- waiting approval -> approval indicator
- error -> red badge / error bubble
- complete -> report bubble / completed task state

---

## 17. OpenClaw adapter expectations

The OpenClaw adapter should expose strong native support for:

- agents
- sessions
- streaming chat
- files
- cron
- approvals
- prompt-pack sync
- project binding

OpenClaw remains a first-class provider, but it is not the product truth.

---

## 18. Hermes adapter expectations

The Hermes adapter should expose:

- agent registry or synthetic team registry
- session and thread mapping
- streaming chat
- orchestration events
- prompt pack sync where possible
- automation support, native or office-owned

Hermes may need more adapter-owned structures than OpenClaw. That is acceptable.

---

## 19. Security model

### 19.1 Server-side provider access

The browser should not directly hold provider secrets when avoidable.

The office server should:
- manage provider tokens and credentials
- broker provider API connections
- expose same-origin WebSocket / HTTP APIs to the UI

### 19.2 Isolation

Harness-backed providers should support workspace isolation policies.

Examples:
- per-agent workspace
- per-project worktree
- read-only project mounts for reviewer agents
- explicit destructive-action gating

### 19.3 Cross-provider permissions

The broker must support policy decisions like:
- can this agent message that agent
- can this agent access that project
- can this automation invoke that harness
- can this provider see office-global threads

---

## 20. Persistence

The office runtime needs durable storage for:

- provider profiles
- office agents and metadata
- threads and messages
- projects
- automations
- prompt packs
- office-only settings
- provider-native mapping references

Suggested rule:
- provider-native data remains in its provider when appropriate
- office correlation, layout, routing, and shared transcript data remain in office storage

---

## 21. Recommended UI structure

## 21.1 Agent settings tabs

### Core tabs
- Identity
- Brain
- Workspace
- Projects
- Automations
- Office

### Provider tabs
- OpenClaw
- Hermes
- Claude Code
- Codex
- Advanced

## 21.2 Provider directory

Add a provider management surface showing:
- connected providers
- health
- last sync
- supported capabilities
- auth status
- agent counts

## 21.3 Agent directory

Single office-wide directory, filterable by:
- provider
- branch
- project
- status
- capability

---

## 22. Delivery phases

## Phase 1 - Office runtime foundation

Deliver:
- office broker
- canonical office models
- event bus
- provider registry
- provider health surface
- normalized thread/message persistence

Success condition:
- the office can host multiple providers without the UI hardcoding one provider shape

## Phase 2 - OpenClaw first-class adapter

Deliver:
- wrap current OpenClaw-specific behavior behind the provider contract
- keep existing office experience working

Success condition:
- OpenClaw remains fully functional under the new abstraction

## Phase 3 - Hermes adapter

Deliver:
- Hermes provider support
- cross-provider messaging between OpenClaw and Hermes

Success condition:
- an OpenClaw agent and a Hermes agent can both exist in the same office and exchange messages via the broker

## Phase 4 - Harness base

Deliver:
- generic harness provider framework
- session manager
- transcript capture
- workspace binding
- status mapping

Success condition:
- the office can host non-gateway agents as first-class office workers

## Phase 5 - Claude Code adapter

Deliver:
- Claude Code provider
- prompt pack injection
- workspace and project binding
- cross-provider messaging

Success condition:
- a Claude Code worker can participate in the office alongside OpenClaw and Hermes agents

## Phase 6 - Codex adapter

Deliver:
- Codex provider built on the same harness base

Success condition:
- no new architecture required, only a new provider implementation

## Phase 7 - Universal automations and projects

Deliver:
- office-owned automations
- universal project registry
- provider binding strategies

Success condition:
- automations and projects are no longer OpenClaw-only concepts

---

## 23. Migration strategy from today

Current state:
- My Virtual Office is OpenClaw-native
- many UX concepts are directly mapped to OpenClaw files, cron, and workspace conventions

Migration plan:

1. keep current OpenClaw behavior working
2. introduce broker and provider abstraction behind existing UI
3. gradually move canonical truth from OpenClaw-specific assumptions into office-native models
4. keep provider-native advanced panels for power users
5. only later replace top-level UI labels like `Cron` with `Automations` when the office-owned system is ready

This avoids a flag day rewrite.

---

## 24. Open questions

- Which persistence layer should the office runtime use for canonical broker state?
- Should office threads always be canonical, or should some provider-native threads remain primary in 1:1 chat views?
- How should project worktrees be provisioned for harness providers?
- How much prompt-pack materialization should be file-based versus session-injected?
- Should agent-to-agent messaging be explicit inbox routing, shared project threads, or both?
- How should meeting participation map to real provider tasks and locks?
- Should provider adapters run in-process, sidecar processes, or remote microservices?

---

## 25. Recommendation

Build My Virtual Office as a **universal office runtime with provider adapters**, not as:

- one selected backend at a time
- or an OpenClaw-shaped shim that every other system must impersonate forever

That architecture is the cleanest path to:

- multi-provider teams
- cross-provider collaboration
- first-class Claude Code and Codex workers
- future provider growth without redesigning the whole product again

---

## 26. Immediate next spec to write

After this spec, the next documents should be:

1. `OFFICE-BROKER-API-SPEC.md`
2. `PROVIDER-ADAPTER-SDK-SPEC.md`
3. `HARNESS-PROVIDER-SPEC.md`
4. `UNIVERSAL-AUTOMATIONS-SPEC.md`
5. `UNIVERSAL-PROJECTS-SPEC.md`
6. `PROMPT-PACK-MATERIALIZATION-SPEC.md`
7. `CLAUDE-CODE-ADAPTER-SPEC.md`
8. `CODEX-ADAPTER-SPEC.md`
