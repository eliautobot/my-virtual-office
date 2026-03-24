# My Virtual Office

A self-hosted retro pixel-art AI workspace for [OpenClaw](https://openclaw.ai). Turn invisible agent work into a living, breathing office.

![My Virtual Office](screenshot.png)

[![Watch the Demo](https://img.youtube.com/vi/JmJitNaEq9Y/maxresdefault.jpg)](https://youtu.be/JmJitNaEq9Y)

▶️ **[Watch the full demo on YouTube](https://youtu.be/JmJitNaEq9Y)**

## What Is It?

Virtual Office gives your AI agents a physical presence. Instead of watching logs scroll by, you see agents walking between desks, grabbing coffee, sitting in meetings, and chatting — all in a charming GBA-style pixel-art office that runs in your browser.

It connects to your OpenClaw gateway and visualizes everything your agents are doing in real time.

## Features

### 🏢 Live Office Canvas
- Real-time pixel-art office with agents that walk, sit, work, and interact
- Agents move to their desks when working, wander when idle, visit the kitchen, lounge on the couch
- Smooth A* pathfinding with collision avoidance
- Wall occlusion — agents behind walls get naturally shadowed
- 100 FPS rendering with configurable canvas size

### 🎨 Full Office Editor
- Drag-and-drop furniture placement with snap-to-grid
- 25+ furniture items: desks, boss desk, meeting table, couches, bookshelves, whiteboards, filing cabinets, plants, vending machines, kitchen appliances, ping pong table, dart board, TV, and more
- Interior wall builder — create rooms, hallways, and departments with doors
- Wall color picker per section with accent and trim colors
- Floor tile color customization
- Rotation support for select furniture (couch)
- Text labels for naming rooms and areas

### 👤 Agent Customization
- Full character appearance editor: skin tone, hair style/color, eye color, eyebrows
- Facial hair, glasses, headwear options
- Costumes (lobster suit, capes, etc.)
- Held items and desk accessories (coffee mug, envelope, clipboard, plant, etc.)
- Gender-aware sprite rendering
- Each agent gets a unique color tag and emoji

### 🐾 Office Pet
- Choose from Cat, Pug, or Lobster
- Realistic behavior: sleeping, sitting, grooming, wandering, greeting agents, investigating furniture
- Agents interact with the pet — petting (♥) and playful chasing
- Full pathfinding and collision avoidance, same as agents
- Directional walking sprites (front, back, side views) for cat and pug
- Custom naming — default pet is a lobster named Clawy

### 💬 Chat with Agents
- Click any agent to open a chat window
- Full markdown rendering with syntax highlighting
- Inline image support — send images and see thumbnails in the chat
- Click images for full-size lightbox view
- Voice input via Whisper STT (premium)
- File attachments with drag-and-drop or paste
- Audio file auto-transcription
- Streaming responses with live typing indicator
- Tool activity feed showing what the agent is doing (exec, read, write, search, etc.)
- Movable/snappable chat window with float mode
- Agent selector dropdown to switch between agents

### 📊 Dashboard Panel
- **PC Performance** — live CPU and RAM monitoring
- **API Usage** — track agent API calls and costs
- **Branch Management** — organize agents into departments/teams with color-coded borders
- **Agent Directory** — see all agents with live status (working, idle, meeting, break)
- **Activity Log** — real-time feed of office events

### 🌦️ Dynamic Environment
- **Interactive windows** with live weather pulled from your location
- **Day/night cycle** — ambient lighting shifts throughout the day
- **Animated furniture** — TV with 5 channels (sports, news, cooking, cartoon, movie) that agents walk over to watch
- **Clock** showing real time

### 📋 Meeting System
- 1-on-1 meetings — agents walk to each other's desks
- Group meetings — agents gather around the meeting table (10 seats, 5 per side)
- Meetings triggered by agent activity or manual scheduling
- Meeting status visible in dashboard

### 🏗️ Branch System
- Create departments (Engineering, Sales, Support, etc.)
- Color-coded wall sections per branch
- Agents assigned to branches with visual grouping
- Branch themes and emoji customization

### 🔧 Additional Tools (Premium)
- **Agent Browser** — embedded browser with live view, URL bar, and remote control
- **SMS Panel** — Twilio integration for SMS/phone from the office
- **Cron Manager** — schedule recurring agent tasks visually
- **Models Panel** — per-agent model switching from the UI
- **Whisper STT** — voice-to-text input in chat

## Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/eliautobot/my-virtual-office.git
cd my-virtual-office
docker compose up -d
```

Then open `http://localhost:8090/setup` to run the setup wizard.

### First Run

1. Open `http://localhost:8090/setup`
2. Follow the setup wizard to connect your OpenClaw instance
3. Enter a license key or skip for demo mode
4. Customize your office, add agents, and watch them come to life

## Modes

### Free Demo
Works without a license key:
- Up to 3 agents
- Full office editor and furniture
- Agent customization and appearance editor
- Branch management
- Weather and day/night cycle
- Chat with any agent
- Office pet
- API usage monitoring
- Setup wizard

Demo mode shows a watermark and demo banner.

### Full License
Unlocks everything:
- Unlimited agents
- Agent Browser panel
- SMS / Twilio panel
- Cron Job Manager
- Whisper STT voice input
- No watermark or demo banner

### How to Activate
Activate during the setup wizard or later from **☰ Menu → Settings**.

Accepted key formats:
- `VO-EARLY-xxxxxxxx-xxxxxxxx`
- `VO-FULL-xxxxxxxx-xxxxxxxx`

Premium features unlock immediately. The key persists across restarts and updates.

## Configuration

All settings live in `vo-config.json`. Environment variables override config values.

| Variable | Default | Description |
|----------|---------|-------------|
| `VO_OFFICE_NAME` | Virtual Office | Office display name |
| `VO_PORT` | 8090 | HTTP server port |
| `VO_WS_PORT` | 8091 | WebSocket proxy port |
| `VO_GATEWAY_URL` | ws://127.0.0.1:18789 | OpenClaw gateway WebSocket URL |
| `VO_GATEWAY_HTTP` | http://127.0.0.1:18789 | OpenClaw gateway HTTP URL |
| `VO_OPENCLAW_PATH` | ~/.openclaw | Path to OpenClaw home directory |
| `VO_STATUS_DIR` | /tmp/vo-data | Directory for presence/status data |
| `VO_WEATHER_LOCATION` | *(none)* | Weather location for window display |

## Updating

```bash
docker compose pull
docker compose up -d
```

Your license key and office config persist across updates.

## Roadmap

- More office themes and skins
- Premium character packs and costumes
- More pet species and behaviors
- Agent-to-agent visible interactions
- Deeper IDE integrations
- More idle activities and office events

## License

MIT
