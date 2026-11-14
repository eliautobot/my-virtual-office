# My Virtual Office v0.11.0: OpenClaw and Hermes on My Virtual World's integration

## Breaking changes (coming from 0.7.x)

This is the first release on GitHub since 0.7.4. The list below is everything since 0.7.x that may
need your attention (0.8.0 to 0.10.1 and 0.11.0 together). Items marked **(0.11)** are new in this
release; the rest already applied to 0.10.x. Your agents, desks, layouts, looks, projects, tasks,
meetings, skills, chats and settings carry over in place. Back up the data folder first (see
[Updating](UPDATING.md)).

**What the office needs**

- **(0.11)** Node.js is needed for OpenClaw and Hermes. The Docker image includes Node 24. Plain
  installs need Node 22.19 or newer (24 recommended); the office installs the integration's npm
  packages once by itself (`npm ci --omit=dev` in `app/provider-layer`). Without Node, OpenClaw
  and Hermes are off, the office says how to fix it, and every other provider keeps working.
- OpenClaw: the office connects the way current OpenClaw expects, as a backend client. 0.7.x
  connected as OpenClaw's Control UI with the device check switched off, which current OpenClaw no
  longer allows, so 0.7.x cannot connect to it at all.
  - On the OpenClaw computer (a loopback address such as `ws://127.0.0.1:18789`, plain Python or
    Docker with host networking) the office signs in with the gateway token alone: nothing to
    approve.
  - From Docker's bridge network (the standard compose file) or another computer, the office pairs
    as a device: Agent Providers > OpenClaw shows "Waiting for approval" with an
    `openclaw devices approve <id>` command; run it once on the gateway's computer (or approve it
    in OpenClaw's Control UI > Devices). **(0.11)** After pairing the gateway token or password is
    forgotten and the device token is used; OpenClaw's device list names the office "My Virtual
    Office". If the device is removed in OpenClaw the connection says "pair again".
- Settings 0.7.x wrote into `openclaw.json` (`gateway.controlUi.allowInsecureAuth`,
  `dangerouslyDisableDeviceAuth`) are refused by current OpenClaw. The office offers to clean them
  up (with a backup) or shows the `openclaw doctor --fix` command. It never edits the file without
  asking.

**OpenClaw and Hermes**

- **(0.11)** OpenClaw and Hermes (`hermes serve`) run on the integration copied from My Virtual
  World. The Agent Providers window, the OpenClaw and Hermes sub-menus and the chat window for
  their agents are new, in the office's colours; Hermes chats are drawn like Hermes Desktop.
- **(0.11)** Several OpenClaw gateways may be connected; sign in with the gateway token or
  password. Agent ids: migrated agents keep their office ids; agents of a newly added gateway or
  Hermes get ids from their connection (two gateways with an agent called `main` no longer
  collide).
- **(0.11)** OpenClaw agents come from the gateway (`agents.list`, `agent.identity.get`), not from
  `openclaw.json` and `IDENTITY.md`; the `~/.openclaw` folder is no longer needed for the roster.
  OpenClaw models, keys and settings are changed through the gateway in Agent Providers (with Full
  access and the passcode confirmed in the last 10 minutes); the office no longer edits OpenClaw's
  files or restarts the gateway itself. An agent's model is switched per chat in its chat window;
  its default is set in Agent Providers.
- **(0.11)** Messages beginning with `/` are commands for both providers (listed in the `/` menu),
  never words to the model, and only for whoever manages the provider. Follow-up messages (Ctrl or
  Cmd + Enter) queue on the OpenClaw gateway, not in the page.
- Hermes Desktop discovery and the `VO_HERMES_DESKTOP_*` variables are gone. Connect Hermes in
  Agent Providers instead (`hermes serve`, or the Hermes API server). **(0.11)** Hermes API server
  connections (one profile per API server) keep working in the office's own chat window (chat,
  chats list, approvals, stop, Office Life signs, projects and A2A turns); Agent Providers lists
  them in a "Hermes API server (older connection)" section and their settings stay in the
  office's provider settings. Connect `hermes serve` for the full native window and commands.
- **(0.11)** Office Life (new in 0.9): for OpenClaw and Hermes runs started outside the office
  (Telegram, cron, other apps) the paper shows how long they ran, but no longer their outcome or
  tool kinds, and handoffs from such runs are not shown. Runs started in the office are unchanged.

**Your data folder**

- **(0.11)** OpenClaw and Hermes (`hermes serve`) connections, their secrets and the OpenClaw
  device move into `<data>/provider-layer/` (a SQLite database, secrets sealed with the key file
  `<data>/provider-layer.key`). The old files (`agent-providers.json` and `provider-secrets.json`
  entries, `openclaw-device.json`, `provider-agents-cache.json`) are read once, left in place and
  copied to `.pre-pl` backups. Back up the whole data folder including the key file: without the
  key the sealed secrets cannot be read.
- Docker: the data folder is no longer opened to everyone (no more `chmod 777`). Files with secrets
  are private to their owner (0600, or 0640 when their group could already read them) and keep
  their owner. Host tools that wrote into a root-owned volume only because it was open to everyone
  need the right owner now (see [Updating](UPDATING.md#file-permissions-in-the-data-folder)).

**Security and network**

- Offices behind a public domain name need `VO_ALLOWED_HOSTS` (or a passcode); otherwise they
  answer 403 "This office does not answer to that host name". IP addresses, `localhost` and private
  names (`.local`, `.lan`, `.internal`, `.ts.net`, single words) always work.
- Other web pages can no longer read the office API (no CORS), and cross-site writes are refused.
  Scripts and agents that send no `Origin` are not affected.
- With a passcode set, agents on other computers or in other containers send the agent token
  (`Authorization: Bearer <token>`, shown in Settings > Security or fixed with
  `VO_AGENT_API_TOKEN`).
- The raw gateway WebSocket tunnel on port 8091 is off by default. **(0.11)**
  `VO_OPENCLAW_BROWSER_TRANSPORT` and that tunnel are no longer used for OpenClaw chat at all.
- Demo mode: the Cron jobs page is locked, as the licence limits always said.

**API and scripts**

- **(0.11)** OpenClaw and Hermes (`hermes serve`) chat moved to `/api/providers/*`,
  `/api/chat-sessions*`, `/api/chat/*` and `/api/agent-providers/*`. Gone for these agents:
  `/api/openclaw/events` (it answers 204) and `/api/agent-chat/*` (it answers 410, except
  `/api/agent-chat/can`). `/api/agent-chat/*` keeps answering for Hermes API server agents and the
  office's other providers, and `/api/hermes/chat`, `/api/hermes/history*`,
  `/api/hermes/interrupt`, `/api/hermes/runs/*` and `/api/hermes/approval/*` stay for Hermes API
  server agents; their settings are at `/api/office/hermes-api`. `/api/openclaw/rpc` only takes
  the calls of OpenClaw's sub-menu (the Automations page uses it). Renamed: `/api/providers` is
  `/api/office/providers` (also `/conformance` and `/refresh`), and the office's own
  `/api/chat-sessions*` is `/api/office/chat-sessions*`. Scripts must change.
- **(0.11)** A turn given to an OpenClaw or Hermes (`hermes serve`) agent through
  `/api/provider-chat` (agent token, A2A) or by a project task still works: it runs in a chat named
  after the caller ("From ...") or the task ("Task ..."), shown in that agent's chat list.
- **(0.11)** Media in OpenClaw and Hermes answers is served by signed `/api/providers/media` links;
  `/chat-media?path=` stays for older messages and other providers.
- `POST /api/hermes/desktop/discover` answers 410 and names `POST /api/agent-providers/detect`.
- If you changed the office's own code: most files were rewritten since 0.7.x, so expect merge
  conflicts. Your data files are not affected.

**Going back to 0.10's path**

- **(0.11)** `VO_PROVIDER_LAYER=0` keeps 0.10's Python OpenClaw and Hermes path for this release
  (legacy); it will be removed in the next one.

## What is new since 0.7.4

### 0.11.0: OpenClaw and Hermes on My Virtual World's integration

- Several gateways, a device that pairs once, and the chat window and provider menus of My Virtual
  World in the office's colours. Codex, Claude Code, OpenCode, Antigravity and built-in agents
  keep the office's own chat window and work as before.
- One chat window for OpenClaw and Hermes agents, opened from desks, the agent menu, the roster and
  Office Life signs; up to four windows together with the office's own chat windows.
- Agent Providers: connections, their agents and each provider's own menu (models, tools, skills,
  automations, approvals, sessions, settings). The Hermes Keys tab stays.
- The OpenClaw Automations page creates, edits, runs, enables and removes jobs through the new
  integration.
- Office Life: needs-you signs for approvals and questions, also for runs started outside the
  office (a Telegram chat asking for an approval shows the sign; resolving it anywhere clears it).
  Visitors, interns (subagents), the alarm clock (scheduled jobs), handoffs (`sessions_send` and
  `sessions_spawn` in office runs), the working ring, the top status, stand-ups and the paper all
  come from the new integration.
- Agent PC: a Screen section for Hermes agents (their own desktop: watch it, take over, hand back)
  and a Browser section for OpenClaw agents (their tabs and live pictures).

### 0.10.1: Playtest fixes ([notes](RELEASE-NOTES-0.10.1.md))

Safe upgrades from 0.7.x (tested by upgrading a real 0.7.4 office in place and rolling it back),
OpenClaw pairing from Docker or another computer, live updates behind proxies and in several tabs,
a banner when the office loses its server, phone touch targets, pixel icons everywhere, many
editor and chat details, and a notice when a new version is out (Settings > General > Version, a
"What's new" window after an update, `VO_UPDATE_CHECK=0` turns the check off).

### 0.10.0: Polish ([notes](RELEASE-NOTES-0.10.0.md))

New office art with desks and chairs, agents that turn around, real night lighting, pixel name
tags, crisp pixels and themes that reach the office. Agent Studio 2.0 with a live stage, presets,
Randomize and undo; an office editor with floor and wall painting, room templates, copy and paste
and rotation; one window style everywhere.

### 0.9.0: Office Life ([notes](RELEASE-NOTES-0.9.0.md), [guide](OFFICE-LIFE.md))

The office reacts to your agents' real work, with no AI and no tokens: signs at the front desk
when an agent needs you, interns for helper agents, visitors and alarm clocks, moods,
celebrations, a morning stand-up, break-time tournaments and "The Daily Office" newspaper, each
with its own switch in Settings > Office life.

### 0.8.0: A calmer, faster, safer office ([notes](RELEASE-NOTES-0.8.0.md))

A camera that fits the whole office, agents that show the real work they do, a calm design in
every theme, a real phone layout, an optional office passcode, a much faster server, and Agent
Providers: one home for Hermes (`hermes serve`, one connection for every profile) and OpenClaw
connections with access levels.

## Upgrading

- Docker: pull the new image and restart; Node is inside. The first start migrates the saved
  OpenClaw and Hermes connections and keeps the old files as `.pre-pl` backups. With the standard
  compose file (bridge network), approve the office in OpenClaw once (see above).
- Plain install: install Node 22.19 or newer (24 recommended), then start the office; it installs
  the integration's packages once (`npm ci --omit=dev` in `app/provider-layer`).
- Back up the data folder and `provider-layer.key` together.
- To go back to 0.10's path for this release, start the office with `VO_PROVIDER_LAYER=0`.
- Step by step, rolling back and the 0.7.x details: [Updating](UPDATING.md).
