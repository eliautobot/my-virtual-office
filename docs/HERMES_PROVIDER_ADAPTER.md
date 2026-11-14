# Hermes Provider Adapter

> **Version 0.11:** the full connection (`hermes serve`) now runs on the integration copied from My Virtual World
> (on by default): Agent Providers and the chat window are new, see the
> [0.11.0 release notes](RELEASE-NOTES-0.11.0.md). Hermes API server connections work as described here.
> The rest of this page describes the 0.10 path, which `VO_PROVIDER_LAYER=0` keeps for this release.

Virtual Office talks to Hermes in two ways:

- **Hermes (full connection, recommended).** The office connects to `hermes serve` (the backend
  that Hermes' own desktop app and dashboard use). One connection covers every Hermes profile, and
  each profile becomes an office agent with chat, approvals, questions, model and effort pickers,
  tasks, files, the Bot Desktop screen and Hermes' own settings menu.
- **Older API server (legacy).** The office talks to Hermes' OpenAI-style API server (`/v1/runs`),
  one connection per profile. It still works as before and is labelled "Legacy (API server)". A
  legacy row can be switched to the full connection in one click (see
  [Switching an older connection](#switching-an-older-connection)).

All Hermes connections are managed on the **Agent Providers** page (`/providers.html`, opened from
**More tools > Providers** or **Settings > Connections > Manage in Agent Providers**). Hermes keeps
ownership of its profiles, tools, sessions, credentials and terminal; the office is a client.

## Connect your Hermes

1. Start the backend on the Hermes machine: `hermes serve` (or `hermes dashboard`). By default it
   listens on `http://127.0.0.1:9119`.
2. In the office open **Agent Providers > Add a connection > Hermes**. Press **Find** to look on the
   usual addresses (`127.0.0.1:9119` and `host.docker.internal:9119`), or type the address.
3. Choose how the office signs in (next section), choose the access level, press **Test** (it never
   saves), then **Connect Hermes**.
4. The connection page shows "Connected · Hermes x.y" and lists one agent per profile. They walk
   into the office at once.

The setup wizard (`/setup`) shows the same form, with a Skip link.

### Sign in with a session token

Use this when Hermes listens only on its own machine (`127.0.0.1`) and the office runs on that
machine with host networking, or reaches it through a local proxy.

Hermes makes a new session token every time it starts. To keep one token across restarts, start
Hermes with your own: `HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve`, and enter the same
token in the office.

### Sign in with username and password

Use this when Hermes listens beyond its own machine, for example when the office runs in a Docker
container that is not on the host network, or on another computer.

- Give Hermes a username and password with `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` and
  `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`.
- Hermes turns its sign-in on only when it is reachable from other machines: when it listens on a
  non-loopback address (for example `hermes serve --host 0.0.0.0`), or when its **public address**
  (`dashboard.public_url` in its settings, or `HERMES_DASHBOARD_PUBLIC_URL`) names a host other
  than `localhost`, `127.0.0.1` or `::1`. A Hermes that listens only on `127.0.0.1` with no public
  address accepts only its session token, and the office says `signin_not_engaged`.
- Hermes only answers to the host name it listens on (its DNS-rebinding guard). The address you
  type in the office must be that host, or the one declared as its public address; otherwise the
  office says `host_refused`.
- Across a network, put Hermes behind HTTPS (a reverse proxy) and use an `https://` address.

The password is used once, to sign in through Hermes' own app sign-in. The office then keeps the
sign-in tokens Hermes issues (renewed a minute before they expire) and forgets the password. The
Edit form then shows "Not needed: signed in. Type it only to sign in again."

## Access levels

Every Hermes connection (and every legacy row) has an access level, chosen in the form:

| | Full access: chat and settings | Chat only |
|---|---|---|
| Chat, stop, queued follow-ups, attachments | yes | yes |
| Model and effort per chat | yes | yes |
| Answer approvals and questions | yes | yes |
| Sessions drawer (new, rename, delete) | yes | yes |
| Side panel: Tasks, Files (browse and read) | yes | yes |
| Files: upload, new folder, delete | yes | no |
| Side panel: Screen (Bot Desktop) | yes | no |
| Hermes settings menu: read | yes | yes |
| Hermes settings menu: change | yes | no |

The server enforces this; the page only mirrors it. A refused call answers 403 `chat_only` with a
plain sentence, for example "This connection has Chat only access: Hermes' settings are not changed
from here." and the fix "Open Agent Providers, Edit the connection and choose Full access."

On a legacy row, Chat only also makes the mounted profile files read-only and refuses skill writes
for that agent.

## The Hermes settings menu

Open a connection on the Agent Providers page. Next to the **Connection** tab are Hermes' own menu
tabs:

- **Overview:** version, state, and usage for the last 7 or 30 days.
- **Agents:** profiles with their model and the default mark; **New profile** (name, description,
  clone from another profile).
- **Models:** the default model per profile. When Hermes says a model is expensive, its own
  warning is shown and needs a second confirm.
- **Tools:** toolsets on or off.
- **Skills:** skills on or off, with search.
- **Automations:** Hermes cron jobs: pause, resume, run now, remove.
- **MCP servers:** on or off.
- **Sessions:** list and delete.
- **Settings:** every setting Hermes describes in its schema, by category. The default effort lives
  here (`agent.reasoning_effort`), and so does the office hint Hermes adds for chats that come from
  the office.
- **Keys:** the names of Hermes' environment keys (set or not set) and a way to set a new value.

Rules for every change:

- Each change first shows a confirm dialog with the old and new value of every row, and whether it
  takes effect at once or at Hermes' next restart. Cancel sends nothing.
- When the office passcode is on and you are not on the office machine itself, the passcode must
  have been typed in the last 10 minutes. If not, a small "Confirm the office passcode" dialog
  appears and the change is tried once more after it. Changes are never retried by themselves.
- Settings changes carry the values you saw. If Hermes' settings changed elsewhere in the meantime,
  nothing is written and the tab says "Hermes' settings were changed elsewhere meanwhile. Reload the
  tab and try again."
- Secrets are never shown. Secret settings and keys appear as "Set: type a new value to change it"
  or "Not set"; the confirm row says "a new value (hidden)". Hermes' masked previews are not passed
  on either.
- The agent API token can never change settings, and Chat only connections show the menu read-only.
- Each change writes one line to `provider-audit.log` in the data folder (time, connection, kind,
  method; never the values).

## Switching an older connection

A legacy row shows a banner: "This connection uses Hermes' older API server. Switch to the full
Hermes connection for settings, all approval choices, questions, files and the Bot Desktop. The
agent keeps its desk, look and chats."

1. Press **Switch to the full Hermes connection**. If there is no full connection yet, the Add form
   opens filled in (name "Hermes", same host on port 9119, session token).
2. After it connects, the **Move these agents** dialog lists each legacy row with a profile picker.
   The office guesses the profile (the row's saved profile, else a profile with the same name, else
   the first model id the API server reports; `hermes-agent` means `default`) and marks the guess.
3. Press **Switch**. The agent keeps its office id, so its desk, look, chats and settings stay. The
   legacy row is switched off, not deleted, and gets a **Switch back** button that undoes the move.

The same profile is never shown twice: while a legacy API server on the same machine reaches a
profile, that profile stays hidden from the full connection until you switch.

## Reconnecting

- The office keeps one live link per connection and reconnects by itself, waiting a little longer
  after each failure (up to 15 seconds). **Reconnect** on the connection page tries at once.
- While the link is down, a running answer shows "The connection to Hermes was lost;
  reconnecting...". When the link is back, the office asks Hermes for the events it missed, so the
  answer continues without gaps or repeats, and open approvals and questions are asked again.
- If the link stays down for 2 minutes, or Hermes restarted and lost the turn, the answer ends with
  "Hermes stopped before it answered (it restarted, or the turn was cut off)". A chat Hermes no
  longer has says "Hermes does not have this chat any more".
- When the chat's own stream from the office drops, the window shows "Reconnecting to the
  office..." and catches up when it is back.

## Side panel

The panel button in the chat header opens tabs the connection offers:

- **Tasks:** subagents and Hermes automations, for this chat or for all chats of the agent. Running
  and finished lists, live status line, details (prompt, output, transcript), **Stop**, and a Steer
  box to send a running task new instructions.
- **Screen** (Full access): the agent's Bot Desktop as snapshots refreshed every 1.5 seconds while
  the tab is shown, with Start/Stop, Take over / Hand back, and a switch to show Hermes' browser on
  that screen. A Hermes without a Bot Desktop says "This Hermes has no Bot Desktop yet (update
  Hermes)." There is no live remote view in this release.
- **Files:** browse and open files on the Hermes machine (text and picture preview, Download).
  Upload, New folder and Delete need Full access.

Media files the agent makes appear under its answer through short-lived signed links; nothing in the
link reveals a file path.

## Troubleshooting

The connection page shows a state word (Connected, Connecting..., Needs attention, Offline,
Switched off), the detail and a fix. Credential problems add an **Enter the credentials** button.

| Code | What the office says | Fix |
|---|---|---|
| `offline` (`unreachable`, `closed`) | "Hermes is not answering." or "The connection to Hermes was lost; reconnecting..." | Check that `hermes serve` (or `hermes dashboard`) is running at this address. The office keeps trying by itself. |
| `auth_rejected` | "Hermes refused the session token." | Hermes makes a new token on every start unless it is started with `HERMES_DASHBOARD_SESSION_TOKEN`. Start it with yours and enter the same in Edit. |
| `signin_needed` | "Hermes asks to sign in again" | The saved sign-in expired and could not be renewed. Enter the password again (Edit). |
| `signin_not_engaged` | "This Hermes does not use its sign-in (it listens only on its own machine)" | Choose "Session token" in Edit, or make Hermes reachable from other machines (see [username and password](#sign-in-with-username-and-password)). |
| `signin_engaged` | "This Hermes asks to sign in with a username and password" | Choose "Username and password" in Edit. |
| `bad_credentials` | "Hermes refused the username or password" | Check the username and password. |
| `no_password_signin` | "This Hermes has no username-and-password sign-in" | Set `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` and `_PASSWORD` for Hermes, or use a session token. |
| `rate_limited` | "Too many sign-in attempts" | Wait a minute. |
| `not_hermes` | "No Hermes backend answered here" | Use the address `hermes serve` or `hermes dashboard` prints when it starts. |
| `host_refused` | "Hermes refused this address as its host" | Use the host Hermes listens on, or declare this address as its `dashboard.public_url`. |
| `request_refused` | "Hermes refused this connection (its request guard)." | A Hermes bound to its own machine answers only callers on that machine. From a container or another computer, start it on an address they can reach (that turns on username and password sign-in). |
| `not_configured` | "The Hermes address is not set." / "The session token is not set." | Fill in the missing field (Edit). |

## Legacy API-server details

These apply only to "Legacy (API server)" rows.

### Conversation continuity

Hermes `/v1/runs` does not bring back earlier turns by itself. Before every continuing run the
office reads the session through the authenticated Sessions API and sends bounded
`conversation_history` (user and assistant text only). Limits:

- `VO_HERMES_CONTEXT_MAX_MESSAGES` (default 120)
- `VO_HERMES_CONTEXT_MAX_MESSAGE_CHARS` (default 32,000)
- `VO_HERMES_CONTEXT_MAX_CHARS` (default 120,000)

If an existing session cannot be read, the run is refused with `session_history_unavailable`
instead of silently losing context.

### Saved configuration

Legacy rows live in `vo-config.json` under `hermes.connections` (ID, name, API URL, `API_SERVER_KEY`
as `apiKey`) and can also come from `VO_HERMES_CONNECTIONS_JSON`. Their access level and switch
state live in `agent-providers.json`. Keys stay on the server and API answers redact them.

### Mounted resource policies

The optional mounted profile folder (`resourceRoot`, default `/data/hermes`) lets the office edit
declared profile files: SOUL, identity/profile Markdown, workspace Markdown/text and nested skill
sources under `skills/<category>/<skill>/SKILL.md`. Named connections map below
`resourceRoot/profiles/<id>`; set `resourcePath` when the id differs from the profile folder.

- `read-write`: declared resources may be edited (atomic, keeps owner and mode).
- `read-only`: readable, writes refused. A Chat only legacy row is always read-only.
- `disabled`: no mounted resources.
- `inherit`: per connection, use the global policy.

Docker `:ro` always wins. Absolute paths, traversal, undeclared files, symlinks leaving the profile
folder and credential files (`config.yaml`, `auth.json`, `.env`) are refused.

### Optional Compose sidecar

Set a strong `VO_HERMES_API_KEY` in `.env`, add a legacy connection with URL `http://hermes:8642`
and the same key, then run `docker compose --profile hermes up -d`. The sidecar is pinned to
`nousresearch/hermes-agent:v2026.8.3`, keeps its data in `/opt/data` and joins only the internal
`hermes-internal` network (port 8642 is never published). Set `VO_HERMES_UID` and `VO_HERMES_GID`
to the owner of the host folder.

## Other Hermes modes

- **Local CLI profiles:** with `VO_HERMES_LOCAL_PROFILES_ENABLED=true` the office lists the
  profiles in `VO_HERMES_HOME` and can create or delete them with `hermes profile create/delete`.
  This needs a Hermes CLI (`VO_HERMES_BIN`) inside the container. Off by default.
- **Hermes Messaging Gateway Platform:** Hermes connects to the office as a messaging platform. See
  [Hermes Platform Adapter](HERMES_PLATFORM_ADAPTER.md).
- **Hermes Desktop discovery is gone.** The old `VO_HERMES_DESKTOP_*` settings and the port scan
  were removed. `POST /api/hermes/desktop/discover` answers 410 and names its replacement,
  `POST /api/agent-providers/detect` (the **Find** button).
