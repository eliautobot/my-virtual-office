# My Virtual Office v0.12.0: Characters

0.12.0 is the biggest release of My Virtual Office so far, and the first one on GitHub since
0.7.4. Versions 0.8.0, 0.9.0, 0.10.0, 0.10.1 and 0.11.0 were never published as GitHub releases,
so they all arrive here together: if you run 0.7.4 today, everything below is new to you.

**In short**

- **Characters.** 21 hair styles, faces that show how each agent is really doing, tops, neckwear,
  costumes and hats, work animations at the desk that follow what the agent really does, a
  signature victory move on real wins, waves, furniture that reacts to your clicks, and eight kinds
  of office pet with a bed, a bowl and tricks.
- **One chat window for every agent.** OpenClaw, Hermes, Codex, Claude Code, OpenCode, Antigravity
  and built-in agents all chat in the same window, and the Chat button reopens the agent you used
  last.
- **Voice, free for everyone.** Dictate a message, have answers read aloud, or talk with an agent
  in voice mode, with your browser's own voice or a voice service you choose.
- **OpenClaw and Hermes, rebuilt.** Several OpenClaw gateways, an office that pairs with OpenClaw
  once as a device, `hermes serve` with every Hermes profile as an agent, each provider's own menus
  (models, tools, skills, automations, approvals, sessions, settings) and Full access or Chat only
  per connection.
- **Office Life.** The office reacts to your agents' real work, with no AI and no tokens: signs at
  the front desk when an agent needs you, interns for helper agents, visitors, alarm clocks, moods,
  celebrations, a morning stand-up, break-time tournaments and a daily newspaper.
- **New art and two new editors.** Office art with chairs and real night lighting, agents that
  turn around, 13 desk and 12 boss desk designs (standing desks too), an Agent Studio with a live
  stage, and an office editor with painting, room templates, copy and paste, rotation and design
  variants. Edit office works on phones.
- **Calmer, faster, safer.** A camera that fits the whole office with smooth zoom, a real phone
  layout, one window style everywhere, an optional office passcode, cross-site protection, and a
  server and page that are much faster.

Your agents, desks, layouts, looks, projects, tasks, meetings, skills, chats and settings carry
over in place. This was tested by upgrading a real 0.7.4 office (in Docker and as plain Python)
and by rolling it back. Read **Before you upgrade** first, and back up your data folder (see
[Updating](UPDATING.md)).

## Before you upgrade: breaking changes since 0.7.4

### What the office needs

- **Docker image.** `ghcr.io/eliautobot/my-virtual-office:latest` moves to 0.12.0. To pin this
  release use the tag `0.12.0` (or `0.12`). The image is built for x86_64 (amd64) and arm64 and
  includes Node.js 24, so there is nothing else to install.
- **Node.js for plain installs.** OpenClaw, Hermes (`hermes serve`), the new chat window and voice
  run on Node.js. Plain Python installs need Node.js 22.19 or newer (24 recommended) with `npm` on
  the `PATH`; the office installs its packages once by itself (`npm ci --omit=dev` in
  `app/provider-layer`). Without Node, OpenClaw and Hermes stay off and the office says how to fix
  it; Codex, Claude Code, OpenCode, Antigravity and built-in agents keep working in the office's
  older chat window.
- **OpenClaw.** The office now connects the way current OpenClaw expects, as a backend client.
  0.7.x connected as OpenClaw's Control UI with the device check switched off, which current
  OpenClaw no longer allows, so 0.7.x cannot connect to it at all.
  - On the OpenClaw computer (a loopback address such as `ws://127.0.0.1:18789`: plain Python, or
    Docker with host networking) the office signs in with the gateway token alone. Nothing to
    approve.
  - From Docker's bridge network (the standard compose file) or from another computer, the office
    pairs as a device. **Agent Providers > OpenClaw** shows "Waiting for approval" with an
    `openclaw devices approve <id>` command and a Copy button; run it once on the gateway's computer
    (or approve the office in OpenClaw's Control UI > Devices). After pairing, the gateway token or
    password is forgotten and the device token is used. OpenClaw's device list names the office
    "My Virtual Office". If the device is removed in OpenClaw, the connection says "pair again".
  - OpenClaw must offer device pairing for that (it sends a connect challenge). Tested with
    OpenClaw 2026.7.1-2, 2026.9.6 and 2026.11.2. An OpenClaw too old to pair is reported as such
    instead of "Connected".
- **Settings 0.7.x wrote into `openclaw.json`** (`gateway.controlUi.allowInsecureAuth`,
  `dangerouslyDisableDeviceAuth` and the office's `allowedOrigins` entry) are refused by current
  OpenClaw. The office reports them at start and on the office page, and offers two choices:
  **Clean it up for me** (it keeps a backup next to the file and edits plain JSON only) or
  **I will run `openclaw doctor --fix`**. It never edits the file without asking.
- **Hermes.** Hermes Desktop discovery and the `VO_HERMES_DESKTOP_*` variables are gone. Connect
  Hermes in **Agent Providers** instead: `hermes serve` (the backend Hermes' own desktop app uses;
  one connection brings in every profile) for the full chat window and commands, or the Hermes API
  server, which keeps working as an "older connection" (one profile per API server) in the office's
  own chat window. Existing Hermes API connections carry over.

### Chat, providers and settings that moved

- **Every agent chats in one new window.** The chat window that came with the OpenClaw and Hermes
  integration now hosts every agent kind. Your open chats and your last chat choice are carried
  over once. The older chat window is only used when the integration is off (no Node.js, or
  `VO_PROVIDER_LAYER=0`).
- **Agent Providers** (**More tools > Providers**) is the one place where OpenClaw and Hermes are
  added, signed in, tested, reconnected, switched off and given an access level (Full access or
  Chat only). Existing connections start on Full access.
- **OpenClaw agents come from the gateway** (its agent list and identities), not from
  `openclaw.json` and `IDENTITY.md`, so the `~/.openclaw` folder is no longer needed for the
  roster. OpenClaw models, keys and settings are changed through the gateway in Agent Providers
  (Full access, plus the passcode confirmed in the last 10 minutes when one is set). The office no
  longer edits OpenClaw's files or restarts the gateway itself. An agent's model is switched per
  chat in its chat window; its default is set in Agent Providers.
- **Agent ids.** Agents you already have keep their ids, desks and looks. Agents of a newly added
  gateway or Hermes get ids from their connection, so two gateways with an agent called `main` no
  longer collide.
- **Slash commands.** In OpenClaw and Hermes chats, a message that begins with `/` is a command
  (listed in the `/` menu), never words to the model, and only for whoever manages the provider.
  Follow-up messages (Ctrl or Cmd + Enter) queue on the OpenClaw gateway, not in the page.
- **Voice input moved to Settings > Voice.** The Whisper address of 0.7.x becomes a "Whisper server
  (this network)" listening service there. It is carried over once, and only when the office really
  used it (Whisper switched on, or `VO_WHISPER_URL` set).
- **Themes style the interface only.** They no longer recolour the office itself.

### Your data folder

- The first start moves your OpenClaw and Hermes (`hermes serve`) connections, their secrets and
  the OpenClaw device into `<data>/provider-layer/` (a SQLite database, secrets sealed with the key
  file `<data>/provider-layer.key`). Before it changes anything it copies `vo-config.json` to
  `vo-config.json.pre-hp`; the older provider files are read once, left in place and copied to
  `.pre-pl` backups. **Back up the whole data folder together with `provider-layer.key`:** without
  the key the sealed secrets cannot be read.
- New files you may see: `access.json` (passcode and agent token), `office-life/` (the Office Life
  journal), `provider-audit.log` (changes made through the provider menus, without their values)
  and the media cache of the providers.
- **Docker:** the data folder is no longer opened to everyone (no more `chmod 777`). Files with
  secrets are private to their owner (0600, or 0640 when their group could already read them) and
  keep their owner. Host tools that wrote into a root-owned volume only because it was open to
  everyone need the right owner now (see
  [Updating](UPDATING.md#file-permissions-in-the-data-folder)). The compose file now runs the office
  with a small init process (`init: true`), and an optional `user:` line runs it as your own user.

### Security and network

- **Host check.** The office answers to IP addresses, `localhost` and private names (`.local`,
  `.lan`, `.internal`, `.ts.net`, single words). An office behind a public domain name needs that
  name in `VO_ALLOWED_HOSTS` (or a passcode); otherwise it answers 403 "This office does not answer
  to that host name". Proxies that rewrite `Host` should send `X-Forwarded-Host`.
- **No CORS, no cross-site writes.** Other web pages can no longer read the office API, and
  requests that change anything must come from the office's own page. Scripts and agents that call
  the API without a browser (no `Origin`) are not affected.
- **Agent token.** With a passcode set, agents on other computers or in other containers send the
  agent token (`Authorization: Bearer <token>`, shown in **Settings > Security**, or fixed with
  `VO_AGENT_API_TOKEN`). The office's own computer skips the passcode.
- **Port 8091 is off.** The raw gateway WebSocket tunnel is off by default, and
  `VO_OPENCLAW_BROWSER_TRANSPORT` is no longer used for OpenClaw chat.
- **Demo mode:** the Cron jobs page is locked, as the licence limits always said. Locked features
  open a short explanation window instead of a browser alert.

### API and scripts

- OpenClaw and Hermes (`hermes serve`) chat moved to `/api/providers/*`, `/api/chat-sessions*`,
  `/api/chat/*` and `/api/agent-providers/*`. Gone for these agents: `/api/openclaw/events` (it
  answers 204) and `/api/agent-chat/*` (it answers 410, except `/api/agent-chat/can`).
  `/api/agent-chat/*` keeps answering for Hermes API server agents and the office's other
  providers, and `/api/hermes/chat`, `/api/hermes/history*`, `/api/hermes/interrupt`,
  `/api/hermes/runs/*` and `/api/hermes/approval/*` stay for Hermes API server agents; their
  settings are at `/api/office/hermes-api`. `/api/openclaw/rpc` only takes the calls of OpenClaw's
  own menu (the Automations page uses it).
- Renamed: `/api/providers` is `/api/office/providers` (also `/conformance` and `/refresh`), and
  the office's own `/api/chat-sessions*` is `/api/office/chat-sessions*`. Scripts must change.
- A turn given to an OpenClaw or Hermes (`hermes serve`) agent through `/api/provider-chat` (agent
  token, agent to agent) or by a project task still works: it runs in a chat named after the
  caller ("From ...") or the task ("Task ..."), shown in that agent's chat list.
- Media in OpenClaw and Hermes answers is served by signed `/api/providers/media` links;
  `/chat-media?path=` stays for older messages and other providers.
- `POST /api/hermes/desktop/discover` answers 410 and names `POST /api/agent-providers/detect`.
- `GET /api/layouts` also lists 8 read-only room templates (ids starting with `room-`).
- If you changed the office's own code: most files were rewritten since 0.7.x, so expect merge
  conflicts. Your data files are not affected.

### The older OpenClaw and Hermes path

- `VO_PROVIDER_LAYER=0` keeps the older Python OpenClaw and Hermes path of 0.10 for this release,
  with the older chat window for every agent. It is legacy and will be removed in a later release.

## New features

### Characters

Everything here is drawn in the office's own pixel style, from every side (front, back, left,
right), standing, walking and sitting, in every theme and on phones. Agents you never styled look
exactly as before.

- **Hair:** 21 styles in three groups. Ten are new: fade, afro, bob, braids, locs, side part,
  pigtails, pixie, slicked back and curtains. The older styles are redrawn with light and shade.
  Hair fits neatly under every hat, and long hair sways a little as people walk.
- **Faces and expressions:** with Office Life's Moods on, faces show how the agent is really
  doing: focused while it works, stuck when a run goes wrong, happy after a win or when you wave
  at it, waiting while it needs you, and sleepy when it is offline. Agents blink, and their mouths
  move while they talk to each other.
- **Outfits:** tops (tee, hoodie, suit, lab coat, sweater, vest, blouse), neckwear (scarf, tie, bow
  tie, necklace, in any colour) and full-body costumes (lobster, chicken, ghost, Santa, astronaut, dino), with
  ready-made sets for Winter, Summer, Halloween and the holidays.
- **Hats and glasses:** 12 hats, among them a Santa hat, a witch hat, a sun hat and a hair bow. Hats, glasses
  and beards follow the head in every view. Office Life's headphones sit properly on every hair
  style and over every hat.
- **Male and Female:** Male / Female buttons at the top of each look tab (and in the new-agent
  look step) set the agent's gender, and each list then offers that gender's items plus the shared
  ones: most clothes, hats, glasses, costumes and colours are for everyone; facial hair and a few
  hair styles (bald, fade, slick back) are Male; lip colour, arched brows, a few hair styles
  (pixie, bob, ponytail, bun, pigtails), the tiara and the new blouse, necklace and hair bow are
  Female. Male agents have no lashes; Female agents choose from five lash styles (natural, long,
  curled, winged, both lids) or none. Switching keeps the shared choices and swaps the rest for
  the new gender's defaults, Randomize keeps the gender, and saved agents look exactly as before.
- **More looks:** 12 skin tones and colours for shirt, trousers and shoes.
- **Agents turn around:** they walk with front, back and side views, sit on a chair behind their
  desk with their hands on the keys, and an agent behind a wall shows as a faint silhouette.

### Agents act out their real work

- **At the desk**, what an agent does follows what it is really doing right now, for every
  provider: quick typing bursts while it runs commands, scrolling while it reads a web page, papers
  on the desk while it edits files, looking around while it searches, talking while it sends
  messages, and a thinking pose while it thinks. It always matches the desk monitor.
- **Desk monitors** show the command, web page, file, search or message the agent is on: amber for
  an approval, red for an error, green when done, off when the agent is offline. Desks nobody uses
  keep their screens off. Desks with several screens show the work on every screen.
- **Activity chips** above agents show the running tool, "needs approval", "run failed" and
  "done" as pixel icons. Reasoning text is never drawn on the office.
- **Victory moves:** each agent has a signature move (fist pump, chair spin, little dance, bow, air
  guitar, salute, jump or slow clap). It plays on real wins: a task done, a project done, or back
  on track after a problem. The office picks one for every agent; choose another in **Agent Studio
  > Moves** and try it with **Play move**.
- **Waves:** click an agent and it waves at you, then its menu opens. The menu has a **Wave** entry
  for a big wave.
- **Busy agents look busy:** a long quiet step (a long think or a slow command) no longer makes an
  agent look idle; it stays at its desk with the screen on until the run really ends. While its
  helpers (subagents) work, the agent stays at its desk and its task line says so ("Waiting on 2
  helpers"), and a chip next to the name tag counts the helpers running right now. Agents in the
  middle of a run when the office restarts still show as working.
- **Paper airplanes** fly when one agent really messages another; agents stretch after a run
  longer than 5 minutes; sleeping agents lean over with their hands off the desk and ease back up
  when they wake.
- **Live chat bubbles** over agents follow their conversations, including OpenClaw and Hermes
  conversations from any channel. Bubbles stay readable at every zoom, avoid each other and the
  controls, and look the same in every theme. While an agent thinks, three dots move inside its
  name tag.

### The office reacts to your clicks

- Click (or tap) furniture and it reacts: the floor lamp switches off and on (and really stops
  lighting the room at night), the TV changes channel, the vending machine drops a can, the water
  cooler fills a cup, the coffee maker brews, the microwave counts down, the toaster toasts, the
  clock's cuckoo looks out, the whiteboard shows notes, a diagram or a clean board, and drawers,
  books, plants, the dartboard and the bin react too.
- Reactions are just for fun: they are not saved, only happen in your own browser, and never
  happen while you edit the office. **Settings > Office life > Click reactions** turns them (and
  waves) off.

### Office pets

- Eight kinds: cat, pug and lobster as before, and new corgi, bunny, fox, duck and turtle.
- Click or tap the pet and it does its own trick (a pounce, a roll over, a binky, a mouse dive and
  more). Now and then it shows off on its own.
- A **pet bed** and a **food bowl** in the furniture catalog: the pet sleeps in its bed and eats at
  its bowl. Without them it behaves as before.
- A favourite agent: the pet naps by their desk, sits by their chair while they work and greets
  them when they come online or finish. Pick one, let the office pick, or choose nobody.
- The **Pet** tab of the office editor shows every kind as a picture, with the name and the
  favourite. The pet never stands on furniture and never pulls agents away from real work.

### Agent Studio

- **A big live stage** drawn by the office itself, with the desk, chair and name tag, so looks and
  desk items show exactly as they will in the office. Poses: Stand, Walk, Sit and type, Idle.
  Facing: Front, Left, Right, Back. Zoom, pause, and **Find in office**.
- **Tabs:** Looks, Body, Hair, Face, Outfit, Hats and glasses, Items and desk, Moves, Voice and
  Advanced (plus Details on phones). Every choice is a picture of the real thing.
- The Face tab previews each expression on the stage without changing the look.
- **Randomize** with locks (body and skin, hair, face, outfit, hats and glasses, items), ready-made
  looks and outfit sets, **Reset look**, and **Copy look from** another agent.
- **Undo and redo** (`Ctrl`/`Cmd` + `Z`, `Ctrl`/`Cmd` + `Shift` + `Z` or `Ctrl` + `Y`). **Discard**
  really puts the agent back, and saving shows one honest message: saved, saved with a provider
  warning, or failed with your changes kept.
- **New agent** has Look and Desk steps, so a new agent starts with its own look and a free desk.
  When the provider refuses, the wizard stays open with everything you entered, says why and offers
  Retry.

### Desks and boss desks

- **13 desk designs:** Classic, Analyst, Gamer, Developer, Creative Studio, Trader, Streamer, Retro
  80s, Maker Bench and Cosy Home Office, plus three standing desks: Standing Desk, Treadmill Desk
  and Counter Desk.
- **12 boss desk designs:** Classic, Command Center, Executive, CEO Glass, Studio Producer,
  Architect's Studio, Captain's Desk, Zen Garden, Data Ops and Gaming Throne, plus two standing
  boss desks: Executive Lectern and War Table.
- Every design comes in its own set of colours and is drawn in all four rotations.
- **Standing desks:** agents walk up, step in and work standing, wave, show when they need you and
  even nod off on their feet.
- Agents sit close enough that their hands reach the keyboard and mouse at every desk and in every
  rotation. Desks in offices you already have load as Classic and look exactly as before.

### Office Life ([guide](OFFICE-LIFE.md))

The office reacts to the real work your agents do. **It uses no AI and costs no tokens:** it never
calls a model, starts a run or sends a prompt. Each feature has its own switch in **Settings >
Office life**. Full guide: [Office Life](OFFICE-LIFE.md).

- **Needs you:** an agent blocked on an approval or a question walks to the front desk and holds up
  a sign ("Needs your OK", "Has a question" or "Needs you"). Click it and the agent's chat opens on
  that exact card. The sign clears the moment you answer, wherever you answer (the office, Hermes,
  OpenClaw, Telegram), also for runs started outside the office. Agents off screen get a badge at
  the edge of the office.
- **Interns and handoffs:** helper agents (OpenClaw and Hermes subagents and delegations) show up
  as interns with an INTERN tag, sit at a free desk while they run and leave when done. Work sent
  from one agent to another travels as a folder.
- **An intern for every helper:** each running helper gets its own intern. Interns take the free
  desks nearest their agent, then stand in a ring round its desk, spread out and clear of seats and
  doorways. A new Office life setting, **Most interns in the office** (24 by default, 1 to 48),
  keeps a phone smooth; past it every agent keeps a fair share and its chip says so
  ("30 helpers · 24 shown").
- **Visitors and alarm clocks:** a message from Telegram, Discord, Slack, WhatsApp, SMS, email and
  other outside channels arrives as a courier who drops an envelope on the agent's desk. A scheduled
  job rings an alarm clock on the desk, with the job's name.
- **Moods:** focused, stuck, relieved, asleep and waiting, from real run outcomes, now shown on the
  agents' faces too.
- **Celebrations:** "+N XP" with confetti, high-fives, a "Project done!" pennant, a cake in the
  kitchen for a finished project, and the agent's victory move.
- **Daily stand-up:** at a set time (09:30 Monday to Friday by default) agents gather at the
  meeting table and each says one line about what it did. Each stand-up is saved to Meetings
  history and named by the office's time of day.
- **Seasons and occasions:** seasonal decor that follows your hemisphere, five holidays you can
  switch off one by one, up to 12 dates of your own, donuts on Fridays and umbrellas on rainy days.
- **Break-time tournaments:** idle agents play ping pong or darts brackets on your tables. Click a
  player to cheer. Wins add trophies on the leaderboard, never XP, and real work always wins.
- **The Daily Office:** at 18:00 by default the office prints a front page with a headline, a
  column per agent, the MVP of the day and stats. Open it from **More > Daily Office**, browse past
  days, or **Replay the day**.
- **Calm mode** shows signs and icons only (nobody walks around, no confetti, no tournaments). Calm
  mode, or your computer's reduced-motion setting, also stills the new animations: hair does not
  sway, desk work and victory moves hold one pose, a wave is a raised hand, and furniture changes
  its look without the motion.
- **Front Desk** and **Notice Board** furniture items. Both are optional; offices without them get
  sensible spots automatically.
- **Privacy:** no message text, command, question, goal or session title is ever drawn on the
  office, kept in the Office Life journal or printed in the newspaper.

### One chat window for every agent

- **The same window for every agent kind:** OpenClaw, Hermes, Codex, Claude Code, OpenCode,
  Antigravity, built-in and extension agents. Each agent gets the features its provider really
  supports. Open it from the Chat button, a desk, the agent's menu, the roster or an Office Life
  sign.
- **It reopens the agent you used last** in this browser (or your most recent chat). Picking
  another agent in the window's picker switches that window. A second window opens only when you
  ask for one: **+** in the header, or the new-window button on a picker row. Several windows can
  sit side by side.
- **Approval and question cards** with each platform's real choices (Hermes: Allow once, Allow in
  this chat, Always allow, Deny; OpenClaw: Allow once, Always allow, Deny), question cards with
  options, "Other" and hidden answers for secrets. The chat says "Waiting for your OK" while an
  approval waits.
- **Model and effort per chat** for OpenClaw and Hermes, a context meter, live chat titles, and a
  chats list with rename, delete and dots for "working" and "waiting for you". For Codex, Claude
  Code and OpenCode the model is shown (read only).
- **Send while it works:** Enter adds to the running answer, Ctrl or Cmd + Enter queues a
  follow-up. A message sent while the agent is busy in another chat waits in the window's queue and
  goes once the agent is free.
- **Commands:** type `/` in an OpenClaw or Hermes chat for the provider's own commands.
- **Plan steps, folded tool output, collapsed reasoning,** and a clear reason when a run fails,
  stops or is cut off, with **Retry**. Pictures, audio, video and files the agent makes show under
  its answer, with a viewer.
- **A side panel** with **Tasks** (helpers and automations, live, with Stop and Steer), **Files**
  (browse and preview; upload, new folder and delete with Full access), **Browser** for OpenClaw
  agents and **Screen** for Hermes agents.
- Attach files to a message (Hermes chats too), copy messages, and see unread badges on the Chat
  button and the windows.

### Voice

Voice is free for everyone, in the demo too.

- **Dictation** (microphone button): speak and the words go where your cursor was.
- **Read aloud** (speaker button) under every answer, with Stop. **Settings > Voice > Read every
  answer aloud** reads each new answer by itself.
- **Voice mode** (headphones button): a conversation right in the chat. The office listens, notices
  when you stop talking, and speaks the answer sentence by sentence while it is still being written.
  What you say and hear shows in the chat as messages.
- **Without any setup** the browser's own speech recognition and voice are used where the browser
  has them. For better voices and transcription, add a voice service in **Settings > Voice**:
  OpenAI, OpenRouter, Groq, ElevenLabs, Google Cloud, Deepgram, xAI (Grok), Qwen (Alibaba Model
  Studio), any OpenAI-compatible server, or a Whisper server on your network (listening only, no
  key). Models are picked from the service's own list. Keys are never shown again.
- **Each agent can have its own voice,** free: click the agent and choose **Voice**, or use
  **Settings > Voice > An agent's voice** (it lists every agent, also those the demo keeps out of
  the office). With a licence, **Agent Studio > Voice** has the same settings.

### OpenClaw

- **Several gateways** can be connected, each with its own agents. Sign in with the gateway token or
  password; from Docker or another computer the office pairs once as a device (see Before you
  upgrade).
- **OpenClaw's own menu** in Agent Providers: its agents, models, tools, skills, automations,
  approvals, sessions and settings.
- **Automations:** the Cron jobs page creates, edits, runs, enables and removes OpenClaw jobs. It
  shows readable errors with Retry and keeps cron expressions it cannot edit visually.
- **Honest status:** a connection that OpenClaw gave too few permissions says "Connected, but
  OpenClaw did not give this office permission" with the reason and the fix, instead of a plain
  "Connected". The office's agent list says when OpenClaw is waiting for approval, offline or needs
  attention, with a link to fix it.
- Works with OpenClaw 2026.7, 2026.9 and 2026.11 (including the tasks panel: on 2026.7 the office
  sorts the task list itself, and on 2026.11, which removed its background task list, the panel
  says so).

### Hermes

- **`hermes serve`, the full connection:** one connection brings in every Hermes profile as an
  office agent (never twice). Sign in with Hermes' session token, or its username and password
  (used once, then forgotten). **Find** looks for Hermes on the usual addresses; **Test** checks
  what you typed without saving.
- **Plain-word errors:** wrong token, Hermes only listening on its own machine, sign-in not turned
  on, wrong host name, not a Hermes at all.
- **Reconnects by itself** when Hermes restarts or the network drops, catches up on missed events
  and asks open approvals and questions again.
- **Hermes' own menu** in Agent Providers: its profiles, models, tools, skills, automations,
  approvals, sessions, settings and keys. Secrets are never shown.
- Hermes chats are drawn like Hermes' own desktop app.

### Codex, Claude Code, OpenCode, Antigravity and built-in agents

- They chat in the same window as everyone else, with their approvals (where the provider reports
  them, as Codex does), Stop, attachments and history.
- Their real tool use reaches the desk animations, monitors, activity chips and Office Life (for
  runs the office starts).
- OpenCode, Antigravity and extension agents show their own provider name instead of "OpenClaw".
- Agent pickers add the provider when names repeat ("Main · OpenClaw", "Main · Codex").

### Access levels per connection

- **Full access** lets the office change the platform's settings, the agent's files, Hermes' agent
  desktop and OpenClaw's browser, always behind a confirm dialog that shows old and new values.
- **Chat only** still chats, picks model and effort, answers approvals and questions, attaches
  files and stops runs, but changes nothing else. The server enforces it.

### Agent PC

- Click an agent's desk monitor (or **PC** in its menu) for a window per agent: browse the agent's
  real workspace (read only).
- **Screen** for Hermes agents: watch the agent's own desktop, take over and hand back.
- **Browser** for OpenClaw agents: its tabs and live pictures.

### Edit office

- **What you click is what you get:** every click places what the ghost shows; a red ghost says why
  ("Overlaps ...", "Outside the office"). Snap to **Tile**, **Half** or **Free** (hold `Alt`).
- **Saves at once:** every finished edit saves with a visible status (Saving, All changes saved,
  Save failed with Retry), also when you close the tab right after. Undo and redo save too.
- **Catalog thumbnails** drawn by the office, with tile sizes and search; drag a card onto the
  floor.
- **Design variants:** the desk and the boss desk in the catalog show how many designs they have,
  with an arrow that opens them right there: a preview of each, its footprint, its screens, whether
  you sit or stand, and its colours. Select a desk you already placed and use its **Variants**
  dropdown to switch the design or colour in place.
- **Paint:** floor materials (Checker, Wood, Carpet, Tile, Concrete, Plain) or your own two colours,
  for an area or the whole floor; a paint roller colours walls.
- **Room templates:** 4-desk pod, Desk row, Meeting room, Meeting corner, Kitchenette, Lounge,
  Reception and Game corner, with previews. A template that does not fit shows where it fits and
  offers **Place at a free spot** or **Expand office to fit**.
- **Duplicate, copy, paste and select all,** `Ctrl`/`Cmd` + click to add to a selection, and a
  double click on empty floor to select an area. Deleting says what went, with Undo.
- **Rotation** in 90 degree steps for desks, the boss desk, the meeting table, kitchen counters,
  whiteboards and couches (`R`, also before you place an item).
- **Resize the office on all four sides,** alignment guides with equal-gap marks and one selection
  toolbar. New items: fridge, Front Desk, Notice Board, pet bed and food bowl.
- **Keys:** `Ctrl`/`Cmd` + `D` duplicate, `C`/`V` copy and paste, `A` select all, `Z` undo,
  `Shift` + `Z` or `Ctrl` + `Y` redo; arrows nudge (`Shift` for a whole tile), `Delete` deletes,
  `Esc` steps back one level and never leaves the editor, `E` or **Done** leaves it, `?` shows the
  shortcut card.
- **Edit office opens without slowing the page:** it draws the office from a picture it keeps and
  only redraws what you change.

### Phones and tablets

- **A real phone layout** (900 px wide and below): top bar, office, a bottom bar and a dashboard
  sheet you drag between peek, half and full. Windows open full screen, every control is a 44 px
  touch target, and the page never scrolls sideways.
- **Edit office on a phone:** it is in the bottom bar (Projects moved into the **•••** menu). The
  editor is a bottom sheet: drag its handle to make it smaller or bigger (it remembers the size)
  while the office stays visible above it. Long-press an item to pick it up, drag with one finger,
  pan and zoom with two.
- **The ••• menu is a real sheet:** drag it taller or swipe it down to close it.
- **A compact chat on phones:** a slimmer title bar, smaller text and spacing, a one-row message box
  and slimmer top and bottom bars show up to about twice as many lines of the conversation. The
  "running tasks" row stays on screen, and a task card you fold stays folded when you send a
  message (on every screen size).
- The office opens framed on all your agents, keeps toasts and labels clear of them, and stops
  drawing behind full-screen pages such as Settings, which saves battery.

### Look, themes and windows

- **New office art:** one calm palette, one light, redrawn props and a new fridge. Floor lamps glow
  after dark and windows cast daylight, sunset light or moonlight that follows your weather
  location's sunrise and sunset and the weather. At night the office keeps its lights on; **Settings
  > General > Night inside > Dim (moonlight)** brings back a darker room.
- **Pixel name tags and icons** everywhere on the office and in the interface, instead of emoji.
- **Four themes in dark and light plus a Custom theme,** applied to every page (Models, Providers,
  Cron jobs, Setup too). Themes style the interface; the office keeps its own colours.
- **One window style:** Agent PC, Projects, Meetings, Skills, Settings and the rest share one frame,
  in-app confirmations instead of browser pop-ups, focus that stays inside a window and `Esc` to
  close. A window you click comes to the front.
- **A dock** with Agents, Edit office, Projects, Meetings, More tools, Settings and Chat, and
  dashboard cards that remember whether they are open.
- **Settings in clear categories,** with Discard and Save changes shown only when something changed.
- **Keyboard shortcuts:** `C` chat, `G` agents, `E` edit, `P` projects, `B` bubbles, `M` mini-map,
  `,` settings, `?` help.
- Self-hosted fonts (no requests to Google Fonts) and readable contrast in every theme.

### Camera and zoom

- The office opens on **Fit**: the whole office is visible, and the camera never shows space
  outside it.
- **Smooth zoom:** the mouse wheel, a trackpad, pinch and the + / - buttons glide toward where you
  point and stay exactly where you leave them. The whole-office view and focusing an agent pick a
  crisp pixel size. **Settings > General > Office size** chooses **Sharp pixels** or **Fill the
  screen**.
- Map controls on the office (zoom, fit, mini-map, all bubbles), a mini-map (`M`), and keyboard
  panning (arrows or WASD, `+` / `-`, `0` fits).
- Agents walk around furniture, never through walls or onto furniture; tall furniture is drawn in
  front of agents who walk behind it.
- Click or tap an agent or its name tag for its menu (Chat, PC, Bubble, Settings, Wave). The
  separate ••• button above each agent is gone.

### Projects, meetings and skills

- A project task given to an OpenClaw or Hermes agent runs in a chat named after the task, shown in
  that agent's chat list.
- A finished project credits only the agents who finished its tasks, and brings a "Project done!"
  pennant, a cake and victory moves.
- Daily stand-ups are saved to Meetings history.
- Projects, skills and the office layout no longer overwrite each other's changes when two tabs or
  two requests save at once (see Fixes).

### Security, access and licence

- **Optional office passcode** (setup wizard or **Settings > Security**): browsers sign in once on a
  login page (30 days, rate-limited tries). The office's own computer and agents with the agent
  token skip it.
- **Always-on protection:** cross-site checks, the host check, no framing by other sites, and text
  escaped everywhere names, messages and settings are shown. Only the app's own files are served.
- **With a passcode set,** changes to provider settings from another computer need the passcode
  typed in the last 10 minutes, and changes are written to an audit log without their values.
- **The agent token cannot change settings:** with a passcode set, an agent using the office API
  token can still chat, work on projects and tasks, join meetings and answer approvals, but changing
  provider settings, model providers, the gateway, the licence or the SMS takeover, and creating or
  deleting agents, need a person signed in to the office.
- **Licence:** voice is free for everyone, in the demo too. Otherwise the demo is as before: up to
  3 agents, and Agent Studio, Edit office, Cron jobs, the SMS panel and the Agent browser need a
  licence key.

### Version notice

- **Settings > General > Version** shows the version you run, whether it is up to date, and a Check
  now button. A small banner says when a new version is out, and a "What's new" window shows these
  notes once after an update (it works offline).
- The office only asks GitHub for its latest release, at most twice a day; nothing about your
  office is sent. Turn it off there, or with `VO_UPDATE_CHECK=0` for the whole server.

### Performance

- **No more server stalls:** the agents list used to freeze for up to 12 seconds every 30 seconds;
  its slowest answer is now a few milliseconds. Provider settings answer in about 2 ms instead of
  5 to 7 seconds, the server uses about half the memory, and it stops in a third of a second.
- **Smaller downloads:** text files are compressed (the office script is about four times smaller
  on the wire) and versioned files are cached by the browser for good; browsers load a new version
  without a hard refresh.
- **Lighter drawing:** a busy office uses less CPU per frame on desktop and phone, and drawing and
  live updates pause while the tab is hidden.
- **0.12:** the project and chat checks the page makes all the time answer much faster (about
  113 ms down to 1.5 ms per check), and fewer layout passes run while the page loads.

## Improvements
- The setup wizard connects Hermes again (it used an older route that the current connection
  layer does not offer, and wrongly asked you to update the office).
- Creating an OpenClaw agent from Docker finds OpenClaw's folder through the gateway, or says
  which setting to set, instead of failing with a folder permission error.
- **Model and details** of an OpenClaw agent no longer shows an error or "No skills configured":
  it points to Agent Providers, where its skills live.
- A Codex or Claude Code program path you type is used as typed; a missing one is reported by its
  path instead of silently running another copy. Testing before saving says it tested the saved one.

**Office and agents**

- An agent without a desk of its own gets the same free desk every time the office opens, and
  Agent Studio's desk list says which one ("Automatic desk"). A desk still assigned to someone who
  is not in this office counts as free.
- Boss desks are less deep, so the boss no longer looks across a wide empty top at the screens.
- Offline agents go back to their desk, faded, with "Zzz"; finished agents stay at their desk.
- When several agents need you they stand apart at the front desk with their signs side by side.
- Helpers that are already working when you open the office sit at their desks right away; only
  new ones walk in.
- At the stand-up, an agent pulled away from the table walks back, or joins by phone.
- In a crowded office a name tag that covers another agent moves to a free spot.
- A very bright wall colour is toned down on screen (the saved colour does not change). Unknown
  furniture from a newer version shows as a dashed crate you can see and delete.
- Autumn decor keeps orange leaves on the plants but no longer drops a leaf pile on the floor.
- The Daily Office shows each agent's pixel figure next to its name.

**Chat and agents**

- Agent details show where the last request came from (Scheduled job, Subagent task, Heartbeat)
  with a short summary instead of the long internal instructions.
- Chat says "Retrying (1/5)" while the provider retries.
- Changing agent or chat while files upload or audio is transcribed cancels the send and gives your
  text and files back.
- Links in chat open in a new tab safely; images only load from the web or the office's own media.
- The cursor goes to the message box when chat opens, and back to the button that opened it when
  it closes.

**Pages and settings**

- Test buttons in the setup wizard, Models and Agent Providers test what you typed without saving
  it. The setup wizard starts from your current settings and keeps secrets you leave blank.
- The Models page is redone in the Agent Providers style, with readable errors and Retry.
- A login page with a backdrop drawn from the office.
- When the office loses its server, a banner says "Lost connection to the office. Retrying..." and
  the dashboard counts dim; "Back online" when it returns.
- Live updates keep working through reloads, several tabs and a reverse proxy.
- Server errors answer with a readable message instead of a broken page.
- The phone dashboard strip is thinner, so the office gets more room.
- Screen readers hear item names in the editor ("Add Boss Desk to favorites"), never internal ids.

## Fixes

**Chat**

- A new chat with an Antigravity, OpenCode or extension agent no longer loses its first message.
- A message sent while the agent was busy no longer leaves a "failed" line: it waits and is sent
  once the agent is free.
- When the gateway refuses a message you see why, instead of a chat that hangs. Failed and stopped
  runs show in the conversation with Retry.
- The Send button can no longer send twice, and Stop only shows while a run is going.
- Expired approval cards close instead of looking pending.
- A run that is still going when you switch away is picked up again when you come back.
- OpenClaw system-event lines ("System: ...") fold into a collapsed row and stay out of chat titles.
- The chat window says "no connection" (not "online") while the office's connection is lost.
- Narrow chat windows: the model and effort chips are no longer cut (the model chip keeps its
  arrow), the buttons are centred, and the message box's focus outline no longer runs into the + and Send
  buttons.
- The time on your own messages is readable in every theme, and the Copy button no longer covers it.
- Chat bubbles over agents only reopen for a new message, never for tool or thinking updates or
  after you closed them.
- Codex in exec mode no longer logs an error in the browser on every turn.
- Behind HTTPS, the chat's direct gateway connection uses the office's own address and port.

**OpenClaw and Hermes**

- OpenClaw from Docker or another computer works again (device pairing).
- A request the OpenClaw gateway refused while it was restarting is asked again once it is back,
  instead of failing.
- OpenClaw 2026.11: tool steps, approvals and handoffs show correctly (it renamed a tool wrapper),
  the context meter works after a chat's first answer, and the tasks panel explains that the background
  task list is gone instead of showing an error.
- OpenClaw 2026.9: its agent lists work, and creating an OpenClaw agent no longer fails halfway.
- Deleted OpenClaw agents no longer come back as offline ghosts.
- OpenClaw tool activity reaches the activity chips and Agent PC (they used to say only "Working").
- A tool call is counted once, and a scheduled run finishes once, in the day's stats.
- `openclaw.json` is never replaced after a failed read, or when it is not plain JSON (comments,
  JSON5, duplicate keys).
- The Cron jobs page signs in again in the default setup, and only sends the fields you changed.
- Hermes agents on `hermes serve` are no longer shown offline when the office's computer has no
  Hermes command line (the usual Docker install).
- Renamed Hermes connections keep their saved API key.
- The setup wizard's "Test gateway" counts agents correctly.

**Office and agents**

- Agents sit on the real seat of a couch at every rotation, and stay seated through a wave or a
  victory move.
- Agents walk around furniture, never through walls or onto furniture, and stop exactly at their
  target. Interns never take an agent's seat.
- The pet never stands on furniture, lies properly in its bed, and never settles in a walkway.
- A finished project credits only the agents who finished its tasks, and a run that ended in an
  unknown way no longer counts as a failure (so it cannot make an agent look stuck).
- Phones: activity chips, bubbles and Office Life signs no longer hide under the dashboard sheet,
  the bottom bar or an open chat, so a tap reaches them.
- Agent Studio no longer warns that the office was changed somewhere else when it was not.
- After a hidden tab the office no longer fast-forwards, and a drawing error no longer stops it.
- An agent no longer stays "working" after a Claude Code reply in the chat window, or after
  OpenClaw's scheduled heartbeat (every 30 minutes by default). If the office ever misses the end
  of an OpenClaw run, it notices within about 30 seconds that the agent is free.
- **New agent:** the desk list shows only free desks (taken ones say by whom, regular desks come
  first) and the new agent sits exactly at the desk you picked, for every kind of agent.
- On the Providers page, Escape closes the Agent Providers dialog.
- Agent Studio no longer offers **Delete agent** for a provider's main agent (the office refuses
  that anyway).
- Desks of agents that share a name (each provider's "Main") stay with the right agent after a
  reload.

**Edit office**

- `E` leaves the editor again, as the shortcut card says; `Esc` steps back and never leaves it.
- **Cancel** only asks to discard changes when something changed.
- Floor pieces never land on a wall, and nothing can be dragged onto the face of a wall.
- Couch rotation and colour save, a pan-drag no longer drops a placed item, and the colour picker
  closes when you leave the editor.
- Edits made before the server answered (after a restart, or offline) are merged and saved when it
  answers, instead of being lost.
- Two tabs editing the office no longer overwrite each other: a save based on an older copy is
  refused and the current layout is shown.
- Shrinking the office and dragging its edges stop at furniture and walls; imported layouts are
  checked and can be undone; one desk per agent.

**Saving and data**

- **Settings > Full reset** works again.
- Settings are written safely, only save after your current settings loaded, and only send what
  you changed. The office layout is never saved before the server copy loaded.
- Projects: two changes to one project at the same time no longer lose one of them.
- Skills: a save over a newer copy of a skill is refused instead of overwriting it.
- Agent desk notes keep their tags when you edit them.
- SMS reply modes: two changes at once no longer lose one.
- Office Life settings keep edits made while a save is on the way, and two saves at once keep both.
- The Models page, Agent Providers and the agent dialog keep what you typed while the page
  refreshes, a save is on the way, or you open another section.
- Deleting an agent never deletes your own files.
- In Docker, settings you save in **Settings** or the setup wizard (Codex, Claude Code, Hermes, the
  office name, the gateway address) now stick after a restart. Before, the Docker Compose defaults
  quietly replaced them.
- Agent-to-agent messages and the Hermes message queue are no longer writable by other users on
  the computer, and secret files an older version left readable are tightened when the office
  starts.

## Known issues and limitations

- **The microphone needs https or localhost.** Browsers only allow the microphone on a secure page:
  `https://`, or `localhost` on the office's own computer. Over plain `http://` to another
  computer's address, the microphone and voice mode buttons still show, and pressing them says the
  microphone needs https or localhost. Reading answers aloud does not need the microphone.
- **Without a passcode** the office is open to anyone who can reach its port on your network, as
  before. Use a private network, and set a passcode when others share it.
- **Codex, Claude Code, OpenCode and Antigravity:** only runs the office starts are seen (work done
  in their own apps or terminals does not show), they have no interns, visitors or alarm clocks,
  and their model is shown read only (no model or effort picker in the chat window yet).
- **Runs started outside the office** (Telegram, scheduled jobs, other apps): for OpenClaw and
  Hermes the newspaper shows how long they ran, but not their outcome or tool kinds, and handoffs
  from such runs are not shown.
- **OpenClaw questions after a restart:** open approvals are read back from the gateway, open
  questions cannot be; such a question shows a sign again only if the gateway sends it again.
- **OpenClaw 2026.11** removed its background task list; the tasks panel says so, and helpers still
  report back in the chat.
- **Hermes** that listens only on its own machine takes a session token, not a password. From a
  Docker container on its own network, Hermes has to listen on an address the container can reach.
- **Agent screens** are shown as pictures that refresh, not as live video.
- **Demo offices upgraded from 0.7.x:** the 3-agent limit can be filled by agents 0.7.x already
  placed (for example its Codex and Claude Code rows), so other agents get no desk, as on 0.7.x.
- **Sharp pixels** may leave a margin around the office on some screens; choose **Fill the screen**
  in **Settings > General > Office size** if you prefer.
- **Office Life:** a helper that finishes in under a second shows no intern; birthdays only appear
  for agents whose provider records a creation date; seasonal decor needs a weather location.
- **Time zone:** with no zone in Settings and no `VO_TIMEZONE`/`TZ`, the office starts on UTC; the
  first browser that can save settings adopts its own zone once. Check **Settings > Office life** if
  your stand-up runs at the wrong hour.
- The compose file does not pass on every variable (for example `VO_WHISPER_URL`); add the ones you
  need to its `environment:` list.
- The optional Agent Browser recipe in the compose file is x86_64 only, and the Codex example in
  Docker uses `danger-full-access` because Codex's own sandbox needs extra container privileges.
- `VO_PROVIDER_LAYER=0` is legacy and will be removed in a later release.

## Upgrading

**Docker (the published image)**

1. Back up the data volume (see [Updating](UPDATING.md#1-back-up-your-data-first)); keep
   `provider-layer.key` with it from now on.
2. In your checkout, `git pull` (the newer compose file, with `init: true`, and the docs), then
   `docker compose pull virtual-office` and `docker compose up -d virtual-office`. Node.js is
   inside the image. To stay on this version instead of `latest`, set
   `VO_IMAGE=ghcr.io/eliautobot/my-virtual-office:0.12.0`.
3. With the standard compose file (bridge network) or OpenClaw on another computer: open **Agent
   Providers > OpenClaw** and run the `openclaw devices approve <id>` command it shows, once, on
   the gateway's computer. The office connects by itself as soon as it is approved.
4. If the office shows leftover 0.7.x settings in `openclaw.json`, choose **Clean it up for me** or
   run `openclaw doctor --fix`.
5. Behind a public domain name: add it to `VO_ALLOWED_HOSTS` (or set a passcode).
6. Check `/health`: it answers `"version": "0.12.0"`.

**Docker built from source:** `docker build -t my-virtual-office:0.12.0 ./app`, then
`VO_IMAGE=my-virtual-office:0.12.0 docker compose up -d virtual-office`.

**Plain Python:** install Node.js 22.19 or newer (24 recommended) with `npm`, update the code
(`git pull`, or check out `v0.12.0`), and start `app/server.py` again. The first start installs the
integration's packages once.

The first start migrates your connections (keeping `.pre-hp` and `.pre-pl` backups), and browsers
load the new version without a hard refresh. Step by step: [Updating](UPDATING.md), and for the
0.7.x details [Upgrading from 0.7.x](UPDATING.md#upgrading-from-07x).

## Rolling back

Point `VO_IMAGE` at the older version and recreate the container, for example
`VO_IMAGE=ghcr.io/eliautobot/my-virtual-office:0.7.4 docker compose up -d virtual-office`, or run
`git checkout v0.7.4` for a plain install. If the older version has trouble with the newer data,
restore your backup.

- **0.7.4 reads the upgraded data** (layout, desks, looks, projects, meetings, skills and settings;
  furniture and connections it does not know are skipped). But it has no passcode, its Docker
  entrypoint opens the data folder to everyone again, and it cannot connect to current OpenClaw at
  all (it needs OpenClaw 2026.7 with the `openclaw.json` settings described above; if you cleaned
  them up, the backup next to `openclaw.json` has them).
- **Looks, moves and the pet** are kept as saved, but an older build only knows its own lists: a
  new hair style may show as no hair, a new pet kind as the lobster, and new tops, costumes, hats,
  moves, desk designs, the pet bed and the food bowl may not show as chosen. Back on 0.12 they are
  all there again, unless you changed that agent's look (or the pet) in the older build.

Details: [Updating > Rolling back](UPDATING.md#rolling-back).

## Release notes of the versions in this release

The detailed notes of each version this release brings together:

- [0.11.0: OpenClaw and Hermes on a new integration](RELEASE-NOTES-0.11.0.md)
- [0.10.1: Playtest fixes](RELEASE-NOTES-0.10.1.md)
- [0.10.0: Polish](RELEASE-NOTES-0.10.0.md)
- [0.9.0: Office Life](RELEASE-NOTES-0.9.0.md) and the [Office Life guide](OFFICE-LIFE.md)
- [0.8.0: A calmer, faster, safer office](RELEASE-NOTES-0.8.0.md)
- [0.7.4](RELEASE-NOTES-0.7.4.md), the previous GitHub release
