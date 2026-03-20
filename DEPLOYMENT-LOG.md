# Virtual Office — Deployment Log

## Date: 2026-03-20
## Status: In Progress
## Owners: Elix (product/technical) + Forge/Reva (commercial/website)

---

## A) Product Feature Gating Matrix (as implemented)

### FREE DEMO (no license, 3 agents max)
| Feature | Available |
|---------|-----------|
| Office canvas with pixel-art agents | ✅ |
| Edit Office (furniture placement, walls, floor) | ✅ |
| Agent customization (appearance, hair, accessories) | ✅ |
| Branch manager (organize departments) | ✅ |
| Weather effects on windows | ✅ |
| Day/night cycle | ✅ |
| Agent auto-discovery from OpenClaw | ✅ |
| API Usage panel (auto-detects providers) | ✅ |
| Setup wizard | ✅ |
| Chat with agents | ✅ |
| 3 agent maximum | ⚠️ LIMIT |
| Demo watermark on canvas | ⚠️ SHOWN |
| Orange "DEMO MODE" banner | ⚠️ SHOWN |
| Agent Browser panel | ❌ LOCKED |
| SMS/Phone panel (Twilio) | ❌ LOCKED |
| Model Manager (/models.html) | ✅ NOT LOCKED |
| Cron Job Manager (/cron.html) | ❌ LOCKED |
| Whisper STT (voice input) | ❌ LOCKED |

### PAID (Early Bird $9.99 / Full $35.99)
Everything above PLUS:
- Unlimited agents
- Agent Browser panel (CDP + VNC live view)
- SMS/Phone panel (Twilio integration)
- Cron Job Manager
- Whisper STT voice input
- No watermark, no demo banner

### ROADMAP (not implemented yet, future updates)
- Themes/skins for office
- More agent activities and events
- Agent-to-agent autonomous interactions
- Claude Code / Codex / VS Code deeper integrations
- Premium character packs
- Multi-office support

---

## B) License/Activation Flow

### Key Format
`VO-{TIER}-{8-hex-ID}-{8-hex-HMAC-SIG}`
- Tiers: EARLY ($9.99), FULL ($35.99)
- Example: `VO-EARLY-a1b2c3d4-e5f6a7b8`

### Activation Steps
1. User opens Virtual Office → sees setup wizard (or clicks ☰ Menu)
2. Step 0: License Key field + ACTIVATE button
3. Key validated client-side via `POST /api/license/activate`
4. Validation is **offline HMAC** — no external server needed
5. Valid key saved to `vo-config.json` on disk
6. All premium features immediately unlocked
7. Key persists across restarts and updates

### Deactivation
- `POST /api/license/deactivate` removes key from config
- Falls back to demo mode

### Dev Bypass
- `VO_DEV=1` environment variable unlocks everything (for development)

### Key Generation
- `python license.py generate [EARLY|FULL]` mints new keys
- Keys are deterministic (same ID → same signature)
- 10 pre-generated test keys exist

---

## C) Deployment/Repo Plan

### Source Location
`~/.openclaw/workspace/Projects/Virtual-Office-Product/`

### Structure
```
Virtual-Office-Product/
├── app/                    # Main application
│   ├── Dockerfile         # Python 3.12-slim base
│   ├── entrypoint.sh      # Startup script
│   ├── server.py          # HTTP + WebSocket server
│   ├── game.js            # Canvas rendering (10K+ lines)
│   ├── style.css          # UI styles
│   ├── index.html         # Main page
│   ├── setup.html         # Setup wizard (7 steps)
│   ├── license.py         # License validation
│   ├── chat.js            # Agent chat panel
│   ├── pc-monitor.js      # PC performance widget
│   ├── api-usage.js       # API usage widget
│   ├── browser-panel.js   # Agent browser panel
│   ├── sms-panel.js       # SMS panel
│   ├── cron.html          # Cron manager
│   ├── models.html        # Model manager
│   ├── office.py          # Status update script
│   ├── vo-config.json     # Template config (clean)
│   └── pc-metrics-server.py  # Standalone PC monitor server
├── website/               # Marketing website
├── docker-compose.yml     # Docker Compose config
├── README.md              # Install/usage docs
├── LICENSE                # MIT License
└── .dockerignore          # Build exclusions
```

### Docker Image
- Base: `python:3.12-slim`
- Deps: `websockets` only
- Volumes: `/openclaw` (OpenClaw home, read-only), `/data` (persistent config)
- Ports: 8090 (HTTP), 8091 (WebSocket)

### Update Flow
```bash
# Pull latest
docker compose pull
# Or rebuild from source
docker compose build
# Restart
docker compose up -d
```
- License key persists in `/data/vo-config.json` (Docker volume)
- Office layout/furniture persists in `/data/office-config.json`
- Updates don't wipe user config

### GitHub Plan
- Public repo: `yourvirtualoffice/virtual-office` (or org TBD)
- Full app with gated features (open-core model)
- README with install, activation, features, screenshots
- Releases with tagged Docker images

---

## D) Deployment Log

### 2026-03-20 12:00-13:00 — Elix
- Added interactive windows (weather/sun configurable) to product
- Removed hardcoded clock from wall
- Added camera edge buffer (3 tiles)
- Made PC Performance a configurable feature (setup wizard + settings)
- Fixed chat panel CSS leak (setup.html styles bleeding into toolbar)
- Made API Usage widget auto-detect providers from OpenClaw

### 2026-03-20 13:15-13:30 — Elix + Forge
- Forge flagged: no Obsidian access + no cross-agent communication
- Fixed: added sessions_send + sessions_list to Forge's tools
- Verified: Obsidian SSH tunnel running, REST API reachable
- Coordinated deployment plan with Forge
- Work split: Elix=product/technical, Forge=commercial/website

### Pending
- [ ] LemonSqueezy account (needs Eli)
- [ ] Domain purchase/setup (needs Eli)
- [ ] GitHub repo creation
- [ ] Docker Hub image push
- [ ] Website CTA wiring to payment
- [ ] Final website copy pass
- [ ] End-to-end test: fresh install → setup wizard → demo → activate → premium

---

## E) Website Update Instructions for Forge

### Update these on the website NOW:

**Free Demo section:**
- 3 agents max
- Full office editor (furniture, walls, floor colors)
- Agent customization (appearance, hair, accessories)
- Branch management
- Real weather + day/night cycle
- Chat with any agent
- API usage monitoring
- Setup wizard

**Early Bird ($9.99) section:**
- Everything in Free, plus:
- Unlimited agents
- Agent Browser (watch AI browse the web live)
- SMS/Phone panel (Twilio)
- Cron Job Manager
- Voice input (Whisper STT)
- No watermark or demo banner

**Full License ($35.99) section:**
- Same as Early Bird (identical features)
- Supports continued development
- Price will be the standard after early bird period ends

**Install instructions to add:**
```
1. Install Docker on your machine
2. Run: docker compose up -d
3. Open http://localhost:8090/setup
4. Follow the setup wizard
5. Enter your license key (or skip for free demo)
```

**What happens after purchase:**
1. You receive a license key via email from LemonSqueezy
2. Open your Virtual Office → ☰ Menu → Settings (or setup wizard)
3. Paste your license key → click Activate
4. All premium features unlock immediately
5. Key persists across updates — just docker compose pull && up

**Roadmap section (safe to promise):**
- More themes and office skins
- Premium character packs
- Deeper IDE integrations
- Agent-to-agent autonomous interactions
- More activities and events

### 2026-03-20 14:35 — Eli Updates
- **Domain purchased:** myvirtualoffice.ai (GoDaddy)
- **Stripe account:** ready, eli.autobot13@gmail.com
- **LemonSqueezy account:** pending approval, eli.autobot13@gmail.com
- **GitHub repo:** still needed

### Status
- [x] Domain: myvirtualoffice.ai ✅
- [x] Stripe: ready ✅
- [ ] LemonSqueezy: pending approval ⏳
- [ ] GitHub repo: not created yet
- [ ] DNS pointing domain to website
- [ ] Docker Hub image publish
