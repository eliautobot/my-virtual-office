# My Virtual Office

A self-hosted retro AI workspace for OpenClaw.

Virtual Office turns invisible agent work into a living office where agents move through rooms, chat, work, and make your AI system feel visible. It runs locally with Docker and supports both a free demo mode and paid premium unlocks.

## What it does

- 🏢 **Live office canvas** — see agents in a pixel-art office instead of abstract background processes
- 💬 **Chat with agents** — talk to any visible agent directly from the office
- 🎨 **Office editor** — edit furniture, walls, and floor colors
- 👤 **Agent customization** — change appearance, hair, and accessories
- 🌿 **Branch management** — organize office space branches and agent groups
- 🌦️ **Weather + day/night cycle** — the office environment changes over time
- 📊 **API usage monitoring** — monitor activity from the workspace
- 🧭 **Setup wizard** — guided first-run setup flow

## Modes

### Free Demo
The demo works without a license key and includes:
- 3 agents max
- full office editor
- agent customization
- branch management
- weather + day/night cycle
- chat with any agent
- API usage monitoring
- setup wizard

Demo mode also shows a watermark and demo banner.

### Paid License
A paid license unlocks:
- unlimited agents
- Agent Browser
- SMS / phone panel with Twilio
- Cron Job Manager
- Whisper STT voice input
- no watermark or demo banner

## Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/eliautobot/my-virtual-office.git
cd virtual-office
docker compose up -d
```

Then open:

- `http://localhost:8090/setup`

### First Run

1. Open `http://localhost:8090/setup`
2. Follow the setup wizard
3. Connect your OpenClaw instance
4. Enter a license key or skip for demo mode
5. Start customizing your office

## Activation

Virtual Office can run in two modes:

### Free Demo
The demo works without a license key and includes:
- 3 agents max
- full office editor
- agent customization
- branch management
- weather + day/night cycle
- chat with any agent
- API usage monitoring
- setup wizard

Demo mode shows a watermark and demo banner, and premium features stay locked.

### Full License
A paid license unlocks:
- unlimited agents
- Agent Browser
- SMS / Twilio panel
- Cron Job Manager
- Whisper STT voice input
- no watermark or demo banner

### How to activate
You can activate either:
- during the setup wizard
- or later from **☰ Menu → Settings**

Accepted key formats:
- `VO-EARLY-xxxxxxxx-xxxxxxxx`
- `VO-FULL-xxxxxxxx-xxxxxxxx`

After activation, premium features unlock immediately and the key is saved to config so it persists across restarts and updates.

## Update flow

To update your self-hosted instance:

```bash
docker compose pull
docker compose up -d
```

Your saved license key remains active after update.

## Configuration

All settings live in `vo-config.json`. Environment variables override config file values.

| Variable | Default | Description |
|----------|---------|-------------|
| `VO_OFFICE_NAME` | Virtual Office | Office display name |
| `VO_PORT` | 8090 | HTTP server port |
| `VO_WS_PORT` | 8091 | WebSocket proxy port |
| `VO_GATEWAY_URL` | ws://127.0.0.1:18789 | OpenClaw gateway WebSocket URL |
| `VO_GATEWAY_HTTP` | http://127.0.0.1:18789 | OpenClaw gateway HTTP URL |
| `VO_OPENCLAW_PATH` | ~/.openclaw | Path to OpenClaw home directory |
| `VO_STATUS_DIR` | /tmp/vo-data | Directory for presence/status data |
| `VO_WEATHER_LOCATION` | *(none)* | Weather location |

## Buyer flow

After purchase, the buyer receives a license key by email.

Then they:
1. open Virtual Office
2. go through the setup wizard or open **☰ Menu → Settings**
3. paste the key
4. click activate
5. premium features unlock immediately

If they already started with the demo, they can upgrade in place with no reinstall.

## Roadmap

Safe roadmap direction:
- more themes and office skins
- premium character packs
- deeper IDE integrations
- agent-to-agent interactions
- more activities and events

## License

MIT
