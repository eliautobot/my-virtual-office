# Virtual Office — OpenClaw Integration Architecture

## Document Purpose
This is the technical blueprint for making Virtual Office a portable, plug-and-play product that works with **any** OpenClaw installation. It covers discovery, presence, delivery, and the full list of hardcoded items that need to be generalized.

---

## Current State: Hardcoded Items Audit

Everything below must be addressed to make the product portable.

### Category 1: Hardcoded Agent Roster

| File | What's hardcoded | Lines | Impact |
|------|-----------------|-------|--------|
| `game.js` | `AGENT_DEFS` — 15 agents with names, emojis, roles, branches, colors, gender, desk assignments | 1812-1827 | **Critical** — entire agent roster is static |
| `game.js` | `DEFAULT_APPEARANCES` — per-agent visual config (hair, skin, accessories) for all 15 agents by ID | 1837-1851 | Medium — appearance defaults per agent |
| `game.js` | `DEFAULT_BRANCHES` — HQ, PQ, ENG, GEN, BIZ with Eli-specific names | 31-37 | Medium — branch definitions |
| `game.js` | `LOCATIONS` — hardcoded desk pixel positions for PQ (6 desks), ENG (4 desks), boss, center×3, forge, meeting room, lounge, cooler, wander spots, interaction spots | 1543-1604 | **Critical** — desk positions are static |
| `game.js` | Branch-specific agent behavior — desk assignment by branch (`PQ` → `pqDesks`, else `engDesks`), face direction (`ENG` faces left), branch-specific idle text | 2145, 2164, 2679-2680, 2691 | **Critical** — agent behavior hardcoded to PQ/ENG |
| `game.js` | Agent constructor desk type strings — `'boss'`, `'center'`, `'center2'`, `'center3'`, `'forge'` mapped to `LOCATIONS` | 2140-2146 | Medium — desk type→position map |
| `server.py` | `AGENT_INFO` — 15 agents with IDs, emojis, names, branches | 24-39 | **Critical** — duplicates game.js roster |
| `server.py` | `AGENT_WORKSPACES` — maps 15 agent keys to workspace folder names | 43-60 | **Critical** — filesystem paths |
| `server.py` | `AGENT_SESSION_IDS` — maps 15 agent keys to session folder names | 62-78 | **Critical** — session file locations |
| `server.py` | Hardcoded agent IDs in default status creation — `"elix"`, `"pq-m-moe"`, `"eng-flo"`, etc. | 1157-1165 | Medium — initial status bootstrap |
| `server.py` | Special-case agent detection: `from_agent = "elix"` / `"pq-m-moe"` / `"eng-m-flo"` | 175-178 | Low — chat source labeling |
| `server.py` | `sk == "elix" and a["id"] == "main"` — special-case for main agent | 809, 856 | Low — elix↔main mapping |
| `office.py` | `VALID_KEYS` — hardcoded list of 15 agent keys | 26-28 | Medium — limits who can update status |
| `update_status.py` | `VALID_KEYS` — hardcoded list of 9 agent keys (older, incomplete version) | 25-27 | Medium — same issue, stale data |
| `office-sync.sh` | Hardcoded agent map: `[main]="elix"`, `[pq-m-moe]="pq-m-moe"`, etc. (11 agents) | 11-21 | Medium — office sync script |
| `prime-agents.sh` | Hardcoded agent list + Eli-specific prime command with workspace path | 8-12 | Low — priming script |
| `browser-panel.js` | Hardcoded agent name/emoji map for 9 agents (lines 406-415) | 406-415 | Low — browser controller labels |
| `cron.html` | Hardcoded agent list for cron job target selector (6 agents) | 271-276 | Low — cron UI |
| `index.html` | Default chat agent select: `⚡ Elix` as only option | 264 | Low — initial chat target |
| `chat.js` | `currentAgentKey = 'elix'` | 5 | Low — default chat agent |

### Category 2: Hardcoded File Paths

| File | What's hardcoded | Lines | Impact |
|------|-----------------|-------|--------|
| `server.py` | `WORKSPACE_BASE = "/home/eliubuntu/.openclaw"` | 19 | **Critical** — all file access roots here |
| `server.py` | `AUTH_PROFILES_PATH` — reads from `agents/main/agent/auth-profiles.json` (4 references) | 20, 585, 725, 757, 821 | **Critical** — auth token location |
| `server.py` | `STATUS_FILE = "/tmp/vo-product/virtual-office-status.json"` | 18 | Medium — status file location |
| `server.py` | `CONFIG_PATH` — reads OpenClaw config from `WORKSPACE_BASE/openclaw.json` | 199 | Medium — config location |
| `server.py` | Browser controller JSON: `/tmp/vo-product/browser-controller.json` | 261 | Low |
| `server.py` | API usage JSON: `/tmp/vo-product/api-usage.json` | 382 | Low |
| `server.py` | Model change request/result: `/tmp/vo-product/model-change-*.json` | 693-699 | Low |
| `server.py` | SMS paths: `/home/eliubuntu/.openclaw/workspace-pq-alan/sms-*.json` (5 refs) | 349, 999, 1019, 1020, 1055-1056 | Low — Eli-specific feature |
| `office.py` | `STATUS_FILE = "/tmp/vo-product/virtual-office-status.json"` | 23 | Medium |
| `update_status.py` | `STATUS_FILE = "/tmp/virtual-office-status.json"` (different path from office.py!) | 22 | Medium — path mismatch |
| `api-usage-collector.sh` | `/tmp/office-shared/api-usage.json`, imports from `/home/eliubuntu/.npm-global/...`, reads from `/home/eliubuntu/.openclaw/agents/main/agent` | 3-4, 66-67 | Medium |
| `model-change-watcher.sh` | `/tmp/office-shared/model-change-*.json`, `/home/eliubuntu/.openclaw/openclaw.json`, `/home/eliubuntu/.openclaw/agents/main/agent/auth-profiles.json` (repeated in bash and python sections) | 5-8, 29-32 | Medium |
| `office-sync.sh` | `STATUS_FILE="/tmp/office-shared/..."`, `AGENTS_DIR="/home/eliubuntu/.openclaw/agents"` | 5-6 | Medium |
| `media-cleanup.sh` | `MEDIA_DIR="/home/eliubuntu/.openclaw/media/inbound"` | 5 | Low |
| `prime-agents.sh` | References `/home/eliubuntu/.openclaw/workspace/Projects/Eli's Virtual Office/app/office.py` | 11 | Low |

**NOTE:** There are 3 different status file paths in use:
- `/tmp/vo-product/virtual-office-status.json` (server.py, office.py)
- `/tmp/virtual-office-status.json` (update_status.py — stale)
- `/tmp/office-shared/virtual-office-status.json` (office-sync.sh — different!)

This must be unified.

### Category 3: Hardcoded Network / IPs / Ports

| File | What's hardcoded | Lines | Impact |
|------|-----------------|-------|--------|
| `server.py` | `GATEWAY_URL = "ws://127.0.0.1:18789"` — OpenClaw gateway WS | 196 | **Critical** — gateway connection |
| `server.py` | `GATEWAY_URL_FALLBACK = "ws://localhost:18789"` | 197 | **Critical** |
| `server.py` | `GATEWAY_HTTP = "http://127.0.0.1:18789"` — gateway HTTP | 198 | **Critical** |
| `server.py` | `http://127.0.0.1:9222/json` — CDP browser control | 278 | Low — optional feature |
| `server.py` | `http://100.101.16.92:8099/metrics` — Eli's Windows PC metrics | 308 | Low — Eli-specific |
| `server.py` | `http://127.0.0.1:8087/transcribe` — Whisper server | 885 | Low — optional feature |
| `server.py` | `Origin: http://127.0.0.1:8090` — WS proxy origin header | 1095 | Low |
| `server.py` | `PORT = 8090`, `WS_PORT = 8091` | 16-17 | Low — should be configurable |
| `chat.js` | `ws://${host}:8086` / `wss://${host}:8443/ws-gateway` — gateway WS ports | 634-636 | Medium — port assumptions |
| `browser-panel.js` | `window.location.hostname \|\| '127.0.0.1'` | 9 | Low |
| `pc-metrics-server.py` | Default port `8099` | 152 | Low — optional feature |
| `whisper-server.py` | `PORT = 8087` | 9 | Low — optional feature |

### Category 4: Branding / Eli-Specific

| File | What's hardcoded | Lines | Impact |
|------|-----------------|-------|--------|
| `index.html` | `<title>Eli's Virtual Office</title>` | 6 | Low — branding |
| `index.html` | `ELI'S VIRTUAL ⚡ OFFICE ⚡` sidebar brand | ~41 | Low — branding |
| `index.html` | `📞 SMS` button labeled "Alan's SMS Panel" | 32 | Low — Eli-specific |
| `models.html` | `<title>Model Settings — Eli's Virtual Office</title>` | 6 | Low |
| `cron.html` | `<title>Cron Manager — Eli's Virtual Office</title>` | 6 | Low |
| `cron.html` | Eli's phone number `8332596095` as quick-fill button | 250 | Low — Eli-specific |
| `cron.html` | Hardcoded agent list in delivery targets: `Elix (@Elix_autobot)` | 239 | Low |
| `cron.html` | Hardcoded agent selector: 6 specific agents by name | 271-276 | Low |
| `sms-panel.js` | `'Eli'` / `'Alan'` name references throughout (8+ refs) | 1, 36-59, 169-171 | Low — Eli-specific feature |
| `server.py` | `"""Eli's Virtual Office server."""` docstring | 2 | Low |
| `server.py` | `"🏢 Eli's Virtual Office → ..."` startup message | 1172 | Low |
| `style.css` | `/* Eli's Virtual Office - GBA Pixel Art Style */` comment | 1 | Low |
| `style.css` | `--pq-blue`, `--eng-orange` CSS custom properties | 9, 11 | Low — branch-specific colors |
| `game.js` | `// Eli's Virtual Office - GBA Pixel Art Visualization` comment | 1 | Low |
| `game.js` | Neon signs: `'PRO QUALITY PLUMBING'`, `'CALTRAN ENGINEERING'`, `"ELIX'S HQ"` (rendered on wall, 9 fillText calls) | 1292-1319, 4474-4480 | **Medium** — visible branding in the office |
| `game.js` | Weather location: `'Lehigh+Acres,FL'` (Eli's city) | 304 | Medium — location-specific |
| `game.js` | `localStorage` key: `'vo-product-office-config'` | 9 | Low — but name is product-specific |
| `manifest.json` | `"name": "Eli's Virtual Office"` | 2 | Low — PWA manifest |
| `Dockerfile` | Hardcoded `EXPOSE 8090 8091` | 7 | Low |

### Category 5: Eli-Specific Features (may not ship in generic product)

| Feature | Files | Notes |
|---------|-------|-------|
| SMS Panel (Alan) | `sms-panel.js`, `server.py` (lines 336-361, 993-1070) | Tied to Eli's SMS/Alan setup. 6 endpoints: `/sms-log`, `/sms-mode`, `/sms-contacts`, `/sms-send`, `/sms-contacts/save`, `/sms-webhook` |
| PC Metrics | `pc-monitor.js`, `pc-metrics-server.py`, `server.py` (line 308), `index.html` (lines 45-75) | Tied to Eli's Windows PC at `100.101.16.92:8099`. Full sidebar section in HTML. |
| Browser Panel | `browser-panel.js`, `index.html` (line 33, 290+), `server.py` (lines 254-282) | Tied to Eli's Kasm browser container. Hardcoded agent name map (lines 406-415). |
| API Usage Monitor | `api-usage-collector.sh`, `api-usage.js`, `server.py` (line 382), `index.html` (lines 77-84) | Reads Eli's OpenClaw config via node import. Full sidebar section. |
| Model Change Watcher | `model-change-watcher.sh`, `server.py` (lines 693-699) | Reads/writes Eli's openclaw.json + auth-profiles.json |
| Office Sync | `office-sync.sh` | Reads Eli's session timestamps from `~/.openclaw/agents/` with hardcoded agent map |
| Prime Agents | `prime-agents.sh` | Sends warmup commands to 8 specific agents with Eli's workspace path |
| Media Cleanup | `media-cleanup.sh` | Cleans Eli's `~/.openclaw/media/inbound` |
| Whisper STT | `whisper-server.py`, `server.py` (line 885), `chat.js` (transcribe calls) | Optional but currently hardcoded to port 8087 |
| Weather | `game.js` (line 304) | Hardcoded to `Lehigh+Acres,FL` |

### Category 6: Duplicated / Stale Code

| Issue | Files | Notes |
|-------|-------|-------|
| `update_status.py` is stale | `update_status.py` | Only has 9 agents (missing Alan, Filer, Tasky, Itty, Trainer, Forge). Different STATUS_FILE path. **Should be deleted or merged into office.py** |
| Three different status file paths | `server.py`, `office.py`, `update_status.py`, `office-sync.sh` | `/tmp/vo-product/...`, `/tmp/virtual-office-status.json`, `/tmp/office-shared/...` — must unify |
| `game.js.bak2` exists | `game.js.bak2` | Old backup, should be cleaned |
| `server.py.bak` and `server.py.bak2` exist | backup files | Should be cleaned |
| `chat.js.bak` exists | backup file | Should be cleaned |

---

## Target Architecture

### Overview

```
┌─────────────────────────────────────────────┐
│           Virtual Office UI                  │
│  (canvas, sidebar, chat, editor, agents)     │
│                                              │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐ │
│  │  Layout   │  │  Agents   │  │ Branches  │ │
│  │  Editor   │  │  Editor   │  │  Manager  │ │
│  └──────────┘  └───────────┘  └───────────┘ │
└──────────────────┬──────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │  Integration API   │
         │  (office-api.js)   │
         └─────────┬─────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌───────────┐
│OpenClaw│  │ Presence  │  │ Metadata  │
│Gateway │  │  Store    │  │  Store    │
│  (WS)  │  │ (JSON)   │  │ (JSON)    │
└────────┘  └──────────┘  └───────────┘
```

### Data Ownership

| Data | Owner | Storage |
|------|-------|---------|
| Agent sessions, messages, models | OpenClaw Gateway | Gateway API |
| Agent display metadata (emoji, color, appearance) | Virtual Office | Local config file |
| Branch definitions | Virtual Office | Local config file |
| Office layout (furniture, canvas size) | Virtual Office | Local config file |
| Presence state (working/idle/meeting) | Virtual Office | Status file (JSON) |
| Agent roster (who exists) | **Discovered from OpenClaw** | Cached locally |

---

## Integration Contract

### 1. Agent Discovery

On startup (and periodically), Virtual Office queries OpenClaw for available agents/sessions.

**Source:** OpenClaw Gateway API or config file.

**What we need per agent:**
```json
{
  "agentId": "eng-m-flo",        // OpenClaw agent ID
  "sessionKey": "...",            // primary session key
  "name": "Flo",                 // display name (from OC config or default)
  "emoji": "🌊",                 // optional
  "model": "ollama/kimi-k2.5",   // optional
  "lastActiveAt": 1710000000,    // epoch seconds
  "kind": "agent"                // session kind
}
```

**Discovery methods (in priority order):**
1. **OpenClaw config file** (`openclaw.json`) — read `agents` section for agent IDs, models, names
2. **Gateway sessions API** — list active/recent sessions
3. **Filesystem scan** — look for `~/.openclaw/agents/*/` directories

**Result:** A dynamic roster. No hardcoded `AGENT_DEFS`.

### 2. Presence Schema

Each agent's presence state:

```json
{
  "state": "working",           // idle | working | meeting | break
  "task": "Reviewing plans",    // optional task description
  "updatedAt": 1710000000,      // epoch seconds
  "source": "explicit"          // explicit (skill) | inferred (activity) | manual (UI)
}
```

**State transitions:**
- `idle` → default state
- `working` → agent is actively processing / has recent tool calls
- `meeting` → multi-agent conversation in progress
- `break` → agent explicitly on break (or inferred from lounge behavior)

**Inference rules (passive mode):**
- Agent replied or made tool calls in last 60s → `working`
- Agent has active multi-agent session → `meeting`
- Agent quiet for >5 min → `idle`

**Explicit updates (enhanced mode):**
- Agent calls presence API/tool → direct state set

### 3. Presence API

HTTP endpoints served by the Virtual Office backend:

```
GET  /api/presence                    → all agents' presence
GET  /api/presence/:agentId           → one agent's presence
POST /api/presence/:agentId           → update presence
     Body: { "state": "working", "task": "..." }

GET  /api/agents                      → discovered roster + metadata
POST /api/agents/:agentId/metadata    → update display metadata
     Body: { "emoji": "🌊", "color": "#e65100", "branch": "ENG" }

GET  /api/branches                    → branch list
POST /api/branches                    → create branch
PUT  /api/branches/:branchId          → edit branch
DELETE /api/branches/:branchId        → delete branch (agents → Unassigned)

GET  /api/meetings                    → active meetings
POST /api/meetings                    → create meeting
DELETE /api/meetings/:meetingId       → end meeting
```

### 4. CLI (wraps the API)

```bash
# Presence
vo status                              # show all presence
vo status <agentId>                    # show one
vo working <agentId> "task text"       # set working
vo idle <agentId>                      # set idle

# Meetings
vo meet start "topic" agent1,agent2    # start meeting
vo meet end <meetingId>                # end meeting

# Discovery
vo agents                              # list discovered agents
vo branches                            # list branches

# Setup
vo setup                               # interactive first-run config
vo connect <openclaw-url>              # set gateway URL
```

### 5. Virtual Office Skill (for OpenClaw agents)

A lightweight, optional skill that agents can use.

**Skill name:** `virtual-office`
**Location:** Ships with the Virtual Office package, installable as an OpenClaw skill.

**SKILL.md contents (simplified):**
```markdown
# Virtual Office Presence

When this skill is available, update your office presence:

## When starting work:
POST http://localhost:8090/api/presence/{your-agent-id}
Body: {"state": "working", "task": "description of what you're doing"}

## When finishing work:
POST http://localhost:8090/api/presence/{your-agent-id}
Body: {"state": "idle"}

## When entering a meeting:
POST http://localhost:8090/api/meetings
Body: {"topic": "...", "agents": ["agent1", "agent2"]}

## When leaving a meeting:
DELETE http://localhost:8090/api/meetings/{meetingId}
```

**Key design principle:** The skill is a few lines. It does NOT require agents to learn complex office.py commands or carry huge instruction blocks. It's just "POST your state when it changes."

---

## Configuration

### Single config file: `vo-config.json`

```json
{
  "office": {
    "name": "My Virtual Office",
    "port": 8090
  },
  "openclaw": {
    "gatewayUrl": "ws://localhost:18789",
    "configPath": "/home/user/.openclaw/openclaw.json",
    "workspacePath": "/home/user/.openclaw"
  },
  "presence": {
    "statusFile": "/tmp/vo-status.json",
    "inferenceEnabled": true,
    "inferenceIdleTimeout": 300
  },
  "features": {
    "pcMetrics": false,
    "smsPanel": false,
    "browserPanel": false,
    "whisper": false
  }
}
```

All paths, ports, and feature flags come from this one file. No more scattered hardcoded values.

---

## Setup Flow (First Run)

### Step 1: User starts Virtual Office
- Docker: `docker run -p 8090:8090 virtual-office`
- Desktop: double-click app

### Step 2: Setup wizard appears
- "Welcome to Virtual Office"
- Enter OpenClaw gateway URL (default: `ws://localhost:18789`)
- Enter OpenClaw home path (default: `~/.openclaw`)
- Test connection → green checkmark

### Step 3: Auto-discovery
- Reads `openclaw.json` for agent definitions
- Scans `~/.openclaw/agents/` for agent directories
- Presents discovered agents
- User can assign branches, edit names/emojis, or accept defaults

### Step 4: Office ready
- Layout editor available
- Agents appear with auto-assigned desks
- Chat connected to gateway
- Passive presence inference active

### Optional Step 5: Enable enhanced presence
- Install Virtual Office skill to agents
- Agents begin sending explicit state updates

---

## Delivery

### Phase 1: Docker (primary)

```yaml
# docker-compose.yml
version: '3.8'
services:
  virtual-office:
    image: virtual-office:latest
    ports:
      - "8090:8090"
    volumes:
      - ~/.openclaw:/openclaw:ro          # read-only access to OC data
      - vo-data:/data                      # persistent office config
    environment:
      - VO_OPENCLAW_PATH=/openclaw
      - VO_GATEWAY_URL=ws://host.docker.internal:18789
volumes:
  vo-data:
```

**User runs:**
```bash
docker compose up -d
# Open http://localhost:8090
```

### Phase 2: Desktop App (future)

Same backend, wrapped in Electron/Tauri for:
- Windows `.exe`
- Mac `.app`
- Linux AppImage

---

## Refactoring Plan

### Phase 1: Foundation (make it configurable)

| Task | Priority | Files | Description |
|------|----------|-------|-------------|
| Create `vo-config.json` loader | P0 | `server.py` | Single config source, env var overrides |
| Replace `WORKSPACE_BASE` | P0 | `server.py` | Read from config |
| Replace `STATUS_FILE` | P0 | `server.py`, `office.py` | Read from config |
| Replace `PORT`, `WS_PORT` | P1 | `server.py` | Read from config |
| Replace branding strings | P2 | `index.html`, `*.html` | Read from config or template |

### Phase 2: Dynamic Agent Discovery

| Task | Priority | Files | Description |
|------|----------|-------|-------------|
| Build discovery service | P0 | NEW `discovery.py` | Read OC config + scan agents/ |
| Replace `AGENT_INFO` | P0 | `server.py` | Populate from discovery |
| Replace `AGENT_WORKSPACES` | P0 | `server.py` | Derive from discovery |
| Replace `AGENT_SESSION_IDS` | P0 | `server.py` | Derive from discovery |
| Replace `AGENT_DEFS` in game.js | P0 | `game.js` | Fetch from `/api/agents` endpoint |
| Replace hardcoded `LOCATIONS` | P1 | `game.js` | Auto-assign desks based on agent count |
| Replace `DEFAULT_APPEARANCES` | P2 | `game.js` | Generate random defaults, save overrides |
| Dynamic chat agent selector | P1 | `chat.js`, `index.html` | Populate from API |

### Phase 3: Presence API + Skill

| Task | Priority | Files | Description |
|------|----------|-------|-------------|
| Build presence API endpoints | P0 | `server.py` | `/api/presence/*` |
| Build passive inference engine | P1 | `server.py` | Watch session activity → infer state |
| Create CLI wrapper | P2 | NEW `vo-cli.py` | Wraps API calls |
| Create Virtual Office skill | P1 | NEW `skill/` | SKILL.md + minimal instructions |
| Remove `office.py` dependency | P1 | `office.py` | Replace with API calls |

### Phase 4: Packaging + Polish

| Task | Priority | Files | Description |
|------|----------|-------|-------------|
| Create Dockerfile | P0 | NEW `Dockerfile` | Clean multi-stage build |
| Create docker-compose.yml | P0 | NEW `docker-compose.yml` | Easy startup |
| Create setup wizard UI | P1 | NEW page in app | First-run config |
| Feature flags for optional modules | P2 | config + server | SMS, PC metrics, browser, whisper |
| Remove/gate Eli-specific features | P2 | multiple | SMS, PC metrics, etc. behind flags |

---

## What NOT to change

- The internal Virtual Office at port 8085 (`Projects/Eli's Virtual Office/`) — **never touch this**
- Core game rendering (weather, lighting, animations, movement AI)
- Furniture drawing functions
- Canvas/zoom/camera system
- Chat bubble rendering system

These are all already generic and work fine.

---

## Success Criteria

A new user should be able to:

1. ✅ Install with one command (`docker compose up`)
2. ✅ See a setup wizard on first visit
3. ✅ Have agents auto-discovered from their OpenClaw
4. ✅ See agents in the office with inferred presence (no skill needed)
5. ✅ Edit office layout, branches, agent appearance
6. ✅ Chat with any agent through the office
7. ✅ Optionally install the presence skill for richer state
8. ✅ Not see "Eli", "Pro Quality Plumbing", or any Eli-specific references

---

## File: Quick Reference

```
vo-product/
├── app/
│   ├── server.py          # Main backend (HTTP + WS proxy)
│   ├── game.js            # Office canvas rendering (9291 lines)
│   ├── chat.js            # Chat panel (1131 lines)
│   ├── index.html         # Main page (592 lines)
│   ├── style.css          # All styles (2144 lines)
│   ├── office.py          # Status update CLI (271 lines) → replace with API
│   ├── update_status.py   # Older status CLI (267 lines) → deprecate
│   ├── browser-panel.js   # Kasm browser panel → optional feature
│   ├── sms-panel.js       # SMS panel → optional feature
│   ├── pc-monitor.js      # PC metrics → optional feature
│   ├── api-usage.js       # API usage display
│   ├── models.html        # Model settings page
│   ├── cron.html          # Cron manager page
│   └── *.sh               # Various helper scripts → review/generalize
├── vo-config.json         # NEW — single config file
├── Dockerfile             # NEW — clean build
├── docker-compose.yml     # NEW — easy startup
├── skill/                 # NEW — Virtual Office presence skill
│   └── SKILL.md
└── INTEGRATION-SPEC.md    # This document
```
