# My Virtual Office v0.8.0: A Calmer, Faster, Safer Office

Version 0.8.0 is the biggest update so far. The office now fits your screen, agents show the real
work they are doing, the design is calm and consistent in every theme, phones get a real layout,
you can protect the office with a passcode, and the server no longer stalls.

## Highlights

- **The whole office fits the window.** The camera opens on the full office (phones open framed on
  all the agents), with zoom, fit, mini-map and bubble buttons on the map.
- **Night and day you can see:** floor lamps glow after dark and windows cast daylight, sunset or
  moonlight that follows the weather.
- **Agents show their real work.** Desk monitors show the command, web page, file or search an
  agent is on; activity chips above agents show the running tool, "needs approval", "run failed"
  and "done". Reasoning text is never drawn on the office.
- **Click an agent, get its launcher:** Chat, PC, Bubble and Settings.
- **Agent PC:** a persistent per-agent PC window to browse the agent's real workspace (read-only).
- **Office passcode (optional)** and always-on cross-site protection.
- **A new look:** a dock with a More tools menu, dashboard cards, pixel icons, self-hosted fonts,
  four themes in dark and light plus a Custom theme, and in-app windows instead of browser pop-ups.
- **Phones:** top bar, office, action bar and a bottom sheet; windows open full screen; 44 px
  touch targets; editing furniture with long-press and drag.
- **Speed:** no more 12-second stalls; pages download about four times smaller.
- **Hermes and OpenClaw, rebuilt:** Hermes connects through `hermes serve` with every profile as an
  agent, both platforms get Full access or Chat only, their own settings menus, and a chat window
  that turns on exactly what each one can do.

## Hermes and OpenClaw, rebuilt

**One home for connections.** The **Agent Providers** page (**More tools > Providers**) is where
Hermes and OpenClaw are added, signed in, tested, reconnected, switched off and given an access
level. **Settings > Connections** and the setup wizard now show a summary and the same form.

**The full Hermes connection.**
- The office connects to `hermes serve`, the backend Hermes' own desktop app uses. One connection
  brings in every Hermes profile as an office agent; the same profile is never shown twice.
- Sign in with Hermes' session token, or with its username and password. The password is used once
  and then forgotten; the office keeps Hermes' own sign-in and renews it by itself.
- **Find** looks for Hermes on the usual addresses. **Test** checks what you typed without saving.
- When something is wrong the page says what and how to fix it in plain words (wrong token, Hermes
  only listening on its own machine, sign-in not turned on, wrong host name, not a Hermes at all).
- If Hermes restarts or the network drops, the office reconnects by itself, catches up on the
  events it missed and asks open approvals and questions again. An answer that was really cut off
  says so instead of looking finished.

**Older Hermes connections keep working.** Connections to Hermes' API server are labelled "Legacy
(API server)". **Switch to the full Hermes connection** moves their agents in one click (the office
guesses each agent's profile); every agent keeps its desk, look and chats. **Switch back** undoes it.

**Full access or Chat only, per connection.** Full access lets the office change the platform's
settings, the agent's files, Hermes' Bot Desktop and OpenClaw's browser, always behind a confirm
dialog that shows old and new values. Chat only still chats, picks model and effort, answers
approvals and questions, attaches files and stops runs, but changes nothing else. The server
enforces it, including the office's own OpenClaw writes (cron, agents, models and keys, skills).
Existing connections start on Full access.

**Hermes' settings, from the office.** Ten tabs: Overview (usage for 7 or 30 days), Agents (new
profile), Models (default per profile, with Hermes' warning for expensive ones), Tools, Skills,
Automations, MCP servers, Sessions, Settings (everything Hermes describes, by category) and Keys.
Secrets are never shown. If the settings changed elsewhere meanwhile, nothing is overwritten. With an
office passcode, a change from another machine needs the passcode typed in the last 10 minutes.
Each change is written to an audit log without its values.

**OpenClaw's settings, from the office.** Overview, Agents (model per agent), Approvals (what may
run, when to ask, grants with Revoke), Sessions, and links to Automations and Skills.

**A chat window that knows each platform.**
- Approval cards with the platform's real choices (Hermes: Allow once, Allow in this chat, Always
  allow, Deny; OpenClaw: Allow once, Always allow, Deny), and question cards with options, "Other"
  and hidden answers for secrets.
- Model and effort pickers per chat, a context meter, live chat titles, and a sessions drawer with
  ages, rename, delete and dots for "working" (blue) and "waiting for you" (orange).
- Send while it works: Enter adds to the running answer, Ctrl+Enter queues a follow-up; queued
  messages are chips you can edit, delete or send now.
- Plan steps, folded tool output, collapsed reasoning, and a clear reason when a run fails, stops
  or is cut off.
- Pictures, audio, video and files the agent makes show under its answer, with a viewer.
- A side panel with **Tasks** (subagents and automations, Stop, Steer), **Browser** for OpenClaw
  (tabs, address bar, clicks and typing), **Screen** for Hermes' Bot Desktop (snapshots, Take over,
  Hand back) and **Files** (browse and preview; upload, new folder and delete with Full access). On
  phones the panel and the drawer open as full-screen sheets.
- Hermes chats take attachments now.
- Codex, Claude Code, OpenCode and Antigravity chats look and work as before.

Details: [Hermes Provider Adapter](HERMES_PROVIDER_ADAPTER.md),
[OpenClaw Provider](OPENCLAW_PROVIDER.md), and for provider authors the chat manifest and event
format in [Provider SDK](PROVIDER-SDK.md).

## Office

- Default camera is **Fit**: the whole office is visible. Phones open framed on every agent with a
  small margin, and the camera never shows space outside the office.
- Smooth animated camera. The mouse wheel zooms around the pointer and scales with trackpads,
  pinch zooms around the fingers, a remaining finger keeps panning, and a double tap on empty floor
  resets the view. Keyboard: arrows or WASD pan, `+` / `-` zoom, `0` fits.
- Map controls on the canvas: zoom in, zoom out (disabled at the limits), fit, mini-map, and
  expand or minimize all chat bubbles (`B`). They slide aside when an open chat window would
  cover them, and lie in one row on short landscape screens.
- **Mini-map** (off by default): press `M` or its map button. It shows when you zoom in; click or
  tap it to jump there.
- Clicking or tapping an agent's body, name tag or `•••` opens its launcher (Chat, PC, Bubble,
  Settings); clicking a desk monitor opens the Agent PC. Hover shows a pointer and a ring under
  the agent. One tap is exactly one click. The launcher stays readable on desktop at any zoom
  and `Esc` closes it.
- Desk monitors show live activity: terminal with a blinking cursor, browser address bar, editor,
  search box, messages; amber for approval, red for an error, green when done, off when offline.
- Chat bubbles are drawn at a constant readable size at every zoom and sit next to their own
  agent. They avoid each other, faces, names, the map controls and Agent PC windows (a bubble with
  no room folds to its tab), put the newest conversation on top, and only reopen for a new message,
  never for tool or thinking updates or after you closed them. Phones show one open bubble at a
  time. Thinking shows as animated dots.
- Paper airplanes fly when one office agent really messages another; agents stretch after a run
  longer than 5 minutes. Offline agents go back to their desk, faded, with "Zzz"; finished agents
  stay at their desk.
- Agents walk around furniture, never through walls or onto furniture, and stop exactly at their
  target. The pet never stands on furniture either, and never pulls agents out of real work. Ping
  pong only happens when the office has a table.
- Tall furniture (bookshelves, plants, vending machines, couches, cabinets, water cooler,
  whiteboard, floor lamps) is drawn in front of agents who walk behind it.
- Day and night follow the sunrise and sunset of your weather location (with a time-zone estimate
  as a fallback). Floor lamps glow after dark, and windows cast warm daylight, orange sunset light
  or faint moonlight, dimmer when it is cloudy or rainy. The pet's name tag is readable at night.
- **Office editor:** every finished edit saves at once with a visible status (Saving, All changes
  saved, Save failed with Retry). A plain click saves nothing. Undo and Redo save too, with
  `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` and `Ctrl+Y`, plus a Redo button. Arrows nudge, Shift+arrows
  move one tile, `R` rotates. Rotation pivots on the item and refuses to overlap or leave the
  office. Cancel restores the whole office, size included.
- **Editing on phones:** long-press an item (or touch the selected one) to pick it up, drag with
  one finger, pan and zoom with two; the item toolbar docks above the catalog.
- Shrinking the office and dragging its edges stop at furniture and walls; groups move only when
  every item fits; imported layouts are checked and can be undone; one desk per agent.
- Default branches are now "Operations" and "Engineering".

## Chat

- One clear run status line per conversation, a Stop button only while a run is going, and a
  Send button that cannot double-send.
- Failed and stopped runs are shown in the conversation with **Retry**. When the Gateway refuses a
  message you now see why, instead of a chat that hangs.
- Changing agent or session while files upload or audio transcribes cancels the send and gives
  your text and files back.
- Copy buttons on code blocks and on every message, empty states with suggestions, loading and
  error states with Retry.
- Drag and drop files into chat, attachments up to 25 MB each; small non-image files go natively
  to OpenClaw agents.
- Unread badge on the Chat button and on each chat window's button. Long conversations keep the
  newest 200 messages on screen with "Show older messages".
- New chat windows open on the next agent not already open; the "+" button starts a new session.
  The window tabs show each window's agent name and stay hidden while only one window is open.
- OpenClaw system-event lines (for example "System: ..." notes or a resumed-session note) no
  longer clutter your messages: they fold into a collapsed "System events" row above the
  message and are kept out of session titles.
- Opening chat puts the cursor in the message box; closing it returns focus to the button that
  opened it. On phones the full-screen chat keeps `Tab` inside and `Esc` closes it.
- The time on your own messages is readable in every theme, and the Copy button no longer
  covers it.
- Expired approval cards close instead of looking pending.
- A run that is still going when you switch away is picked up again when you come back.
- Links always open in a new tab safely; images only load from the web or the office's own media.

## Design and phone

- One design system: a token layer drives every color, size and font in all themes and on every
  page (Models, Providers, Cron, Setup follow the theme too).
- Self-hosted Press Start 2P (titles) and Inter (text); no Google Fonts requests. Text is never
  smaller than 12 px, and data is never set in the pixel font.
- A dock with Agents, Edit office, Projects, Meetings, More tools, Settings and Chat; the More
  tools menu holds Models, Providers, Cron jobs, Skills library, SMS panel, Agent browser and
  the theme switches.
- Dashboard cards (Agents, Projects, Meetings, Leaderboard, Branches, System, Activity) that
  remember whether they are open.
- Settings in clear categories: General, Themes, Connections, Usage, Integrations, Security, Data
  and Help.
- In-app windows for confirmations, prompts, messages and "licensed feature" notices (no more
  browser pop-ups). Windows trap focus, close with `Esc` and return focus where it was.
- Keyboard shortcuts: `C` chat, `G` agents, `E` edit, `P` projects, `B` bubbles, `M` mini-map,
  `,` settings, `?` help. Windows opened from the More menu return focus to the More button, and
  closed SMS and Agent browser panels take no `Tab` stops.
- Phones and narrow windows (900 px and below): top bar, office, action bar and a bottom sheet
  (peek, half, full). The page itself never scrolls sideways. The Agent PC opens full screen with
  44 px buttons.
- Short landscape screens (for example a phone on its side): the chat uses the full height at
  the right edge, with its tabs, header and agent name fully visible.
- Pages: titles read "Models - My Virtual Office" and so on, the "← Office" back links are 44 px
  touch targets on phones, and the Projects board uses the pixel icons instead of emoji.
- Measured on the running app across 4 themes in dark and light: text contrast failures went from
  46 to 0, and the Settings window no longer lets keyboard focus escape (25 of 40 Tab presses
  escaped before, 0 now).
- The marketing site under `website/` uses neutral sample agents and the same fonts.

## Security

- **Cross-site protection is always on.** Requests that change anything must come from the
  office's own page (Origin, Sec-Fetch-Site and Referer checks); permissive CORS is gone.
- **Host check:** the office answers to IP addresses, `localhost`, LAN names and private suffixes.
  Other host names must be listed in `VO_ALLOWED_HOSTS` (or the office needs a passcode). This
  blocks DNS-rebinding pages.
- **Optional office passcode** (setup wizard or Settings > Security): browsers sign in once on a
  login page (HttpOnly cookie, 30 days, rate-limited tries). The office machine itself and agents
  with the **agent API token** skip it, so local agents keep working. `VO_AGENT_API_TOKEN` sets a
  fixed token; `VO_TRUSTED_CLIENT_IPS` lets the Docker bridge address count as the office machine.
  After sign-in the login page only sends you back to a page of the office, never to another site.
- **No framing by other sites:** every page is sent with `X-Frame-Options: SAMEORIGIN` and
  `Content-Security-Policy: frame-ancestors 'self'`, so another site cannot hide the office in a
  frame and trick you into clicking it.
- The Hermes messaging platform plugin works with a passcode: its routes check their own
  platform token. Only `/api/hermes-platform/status` needs a signed-in browser when a passcode is
  set.
- The raw Gateway WebSocket tunnel on port 8091 is off unless you use the old direct mode.
- Only the app's own files are served; stray test pages and source files are no longer published.
- Every place that shows names, messages, project fields, cron jobs, SMS rows or settings now
  escapes text, and no inline click handlers carry data.
- Chat media and uploads are served safely; helper service URLs (Whisper, PC metrics) must be
  plain http(s).
- Agent names, emoji and roles from discovery are cleaned; meeting and project fields are checked.
- Test buttons in the wizard, Models and Providers test what you typed without saving it.

## Reliability and speed

Measured on the same machine before and after:

- **No more server stalls:** the agents list used to freeze for up to 12.4 seconds every 30
  seconds. Over 35 polls its slowest answer is now 3.6 ms (the roster refreshes in the
  background and provider health is checked in parallel and cached).
- **Provider settings** answer in about 2 ms instead of 5.5 to 7.2 seconds.
- **Memory:** the server uses about 105 MB instead of 215 MB.
- **Restarts:** stopping takes 0.35 s instead of 10.2 s, and the office answers 0.3 s after it starts.
- **Smaller downloads:** text files are compressed. The office script is 205 KB on the wire
  instead of 892 KB, the chat script 70 KB instead of 316 KB, and the chat history feed 108 KB
  instead of 403 KB. The office now asks only for its own agents' recent messages (about 15 KB)
  and gets "unchanged" when nothing changed. Versioned files are cached by the browser and the
  server updates their version tokens by itself.
- **Lighter drawing:** a cached still layer and frame pacing cut canvas work per frame from about
  2435 calls to about 670. CPU use for the office tab went from 21.6 to 15.5 percent of one core
  on a desktop, and from 73.7 to 36 percent on a throttled phone profile. Drawing and polling
  pause when the tab is hidden.
- A fixed 60 Hz simulation means no fast-forward after a hidden tab. A drawing error no longer
  stops the office.
- **Data safety:** settings and state files are written atomically; Settings only saves after
  your current settings loaded and only sends what you changed; the office layout is never saved
  before the server copy loaded; projects save task by task without overwriting other changes;
  deleting an agent never deletes your own files.
- Server errors answer with a readable JSON message instead of a broken page.
- Model and provider saves ask the Gateway for at most one restart.
- The PC Performance and API Usage cards only poll while open, and the PC card never asks for
  metrics when no PC monitor address is set up. The System card says "API key configured. This
  provider does not report quota windows." once instead of twice.

## Fixes

- Works with OpenClaw 2026.9 agent lists, and creating an OpenClaw agent no longer fails halfway
  on OpenClaw 2026.9.
- The Cron jobs page works in the default proxy mode (it used to fail to sign in). It shows
  readable errors with Retry, keeps cron expressions it cannot edit visually, and only sends the
  fields you changed.
- Deleted OpenClaw agents no longer come back as offline ghosts.
- The setup wizard's "Test gateway" counts agents correctly; the wizard starts from your current
  settings, keeps secrets you leave blank and only saves what you change.
- OpenCode, Antigravity and extension agents show their own provider name instead of "OpenClaw".
- Renamed Hermes connections keep their saved API key; blank number fields keep their value.
- The Providers page keeps what you typed when the page refreshes health or you switch providers.
- The Models page shows readable errors with Retry and never rewrites values it does not know.
- The agent dialog keeps unsaved bio edits when you open another section.
- Each agent's workspace panel and undo history stay with that agent.
- Long-standing editor bugs: couch rotation and color now save, a pan-drag no longer drops a
  placed item, and the color picker closes when you leave the editor.
- The fps box and performance logs only show with `?debug=1`.

## Upgrade notes

- **Back up the `vo-data` volume first** (see the README, Updating). 0.8.0 adds
  `/data/access.json` (passcode and agent token) and `/data/.openclaw-proxy-secret`.
- **Reverse proxy with a public domain:** add the domain to `VO_ALLOWED_HOSTS` or set a passcode,
  otherwise the office answers `host_not_allowed`. Proxies that rewrite `Host` should send
  `X-Forwarded-Host`.
- **Other web pages can no longer post to the office** from a browser. Scripts and agents that
  call the API without a browser are not affected.
- **Direct Gateway mode:** the default is the same-origin proxy and port 8091 is closed. If you
  relied on `VO_OPENCLAW_BROWSER_TRANSPORT=direct`, add that variable to the compose
  `environment:` list.
- **Demo mode:** the Cron jobs page is now locked in demo mode, as the license limits always
  said. Locked features open a short explanation window instead of an alert.
- The compose file now runs the office with a small init process (`init: true`); recreate the
  container with `docker compose up -d virtual-office` to get it. An optional `user:` line (with
  `PUID`/`PGID`) runs the office as your host user.
- You no longer need to bump `?v=` tokens by hand after editing app files.
- To build this version yourself: `docker build -t my-virtual-office:0.8.0 ./app`, then
  `VO_IMAGE=my-virtual-office:0.8.0 docker compose up -d virtual-office`. Roll back the same way
  with an older `VO_IMAGE`.
- Check the running version at `/health` (`"version": "0.8.0"`).
- **Agent Providers upgrade (runs once by itself):** before it changes anything the office copies
  `vo-config.json` to `vo-config.json.pre-hp` (mode 0600). Existing Hermes API-server connections
  become "Legacy (API server)" rows with Full access, OpenClaw gets Full access, and
  `vo-config.json` is made private (0600). New files in `/data`: `agent-providers.json`,
  `provider-secrets.json` (tokens and sign-ins, 0600, never shown again), `provider-audit.log`,
  `provider-agents-cache.json`, `provider-media.key` and the `provider-media/` cache.
- **Hermes Desktop discovery is gone.** The `VO_HERMES_DESKTOP_*` variables and the port scan were
  removed; add Hermes through Agent Providers (its **Find** button) instead.
  `POST /api/hermes/desktop/discover` answers 410 and names `POST /api/agent-providers/detect`.

## Known limits

- Without a passcode the office is open to anyone who can reach its port on your network, as
  before. Use a private network and set a passcode when others share it.
- The compose file does not forward some variables (Whisper URL, PC metrics URL, Hermes platform
  settings, provider extension folders); add them to `environment:` when you need them. Voice
  input needs a separate Whisper server.
- The optional Agent Browser recipe is x86_64 only.
- Hermes' Bot Desktop is shown as snapshots (every 1.5 seconds) and OpenClaw's browser as frames
  (about one a second), not as live video. OpenClaw's browser frames need the container to see
  OpenClaw's media folder.
- In `VO_OPENCLAW_BROWSER_TRANSPORT=direct` mode the page talks to the gateway through a raw
  tunnel, so Chat only can be bypassed there; the default proxy mode enforces it.
- A Hermes that listens only on its own machine takes a session token, not a password. From a
  Docker container on its own network, Hermes has to listen on an address the container can reach,
  which turns on its username and password sign-in.
- Not in this Hermes and OpenClaw rebuild: slash commands and `@` completions, rewind, branch and
  archive, and OpenClaw device pairing.
- In Docker the Codex example still uses `danger-full-access`, because Codex's own sandbox needs
  extra container privileges.
- Not in this release: an ACP provider, one Settings hub for models and providers, and signed
  device identity.

## Verification

- Automated suite (`tests/run_all.sh`): all passed. 538 Python tests (2 skipped, 49 subtests),
  7 script-style checks and 29 Node test files, none skipped.
- Hermes and OpenClaw rebuild: tests against a fake Hermes and a fake OpenClaw gateway (link,
  sign-in, reconnect and replay, event translation, settings menu, files and screen, access gates,
  routes), page tests for Agent Providers, the menus, setup and models pages, chat tests for the
  manifest, cards, pickers, queue, side panel and phone drawer, and end-to-end checks against a
  private test Hermes (chat, approvals, questions, stop, model change, restart, password sign-in,
  switch from a legacy row, Chat only).
- New browser and unit tests for this release: office canvas (fit view, phone start view, sharp
  canvas after rotation, no reasoning text, one tap = one click, editor, mini-map, furniture
  depth, lamp light, bubble placement), backend compatibility, HTTP, data and security (114
  tests, plus a login redirect test), design tokens, chat runs, and one test file per page (cron 29,
  models 25, providers 19, setup 24, widgets 18, projects 6 checks).
- Checked by hand in the running app at 1600x900, 1280x720, 412x915 and 375x667 in every theme.
