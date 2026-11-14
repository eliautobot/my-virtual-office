# My Virtual Office v0.10.1: Playtest fixes

Version 0.10.1 fixes what a full playtest of 0.10.0 found, as a player and as a tester: live
updates behind proxies and in several tabs, a clear message when the office loses its server,
phone touch targets, and many small editor, chat and office details.

Your agents, layouts, projects, meetings, skills, chats and settings carry over as they are (tested
by upgrading a real 0.7.4 office in place, and rolling it back). Coming from 0.7.x, read "Breaking
changes" first.

## Breaking changes (coming from 0.7.x)

- OpenClaw: the office now connects the way current OpenClaw expects (as a backend client, with a
  one-time device approval when the office runs in Docker with its own network or on another
  computer). 0.7.x connected as OpenClaw's Control UI and switched off its device check, which
  current OpenClaw no longer allows. In Docker with the standard compose file: approve the office
  once (Agent Providers > OpenClaw shows the command).
- Settings 0.7.x wrote into `openclaw.json` (`allowInsecureAuth`, `dangerouslyDisableDeviceAuth`)
  are refused by current OpenClaw. The office offers to clean them up (with a backup) or shows the
  `openclaw doctor --fix` command. It never edits the file without asking.
- Hermes Desktop discovery is gone. Connect Hermes in Agent Providers instead (`hermes serve` or the
  Hermes API server); existing Hermes API connections carry over.
- Security: offices behind a public domain name need `VO_ALLOWED_HOSTS` (or a passcode); other web
  pages can no longer read the office API (no CORS); cross-site writes are refused; the WebSocket
  port 8091 is off by default; agents on other computers need the agent token when a passcode is set.
- Docker: the data folder is no longer opened to everyone (no more `chmod 777`); private files keep
  their owner and are readable only by it.
- If you changed the office's code: most files were rewritten, so expect merge conflicts. Your data
  files are not affected.

## OpenClaw connection and safe upgrades

- OpenClaw from Docker or another computer works again: the office pairs with OpenClaw as a device
  (OpenClaw's own one-time approval). Agent Providers shows "Waiting for approval" with the
  `openclaw devices approve <id>` command and a Copy button, then "Paired". Offices on the
  OpenClaw computer need nothing and are unchanged.
- Honest OpenClaw status: a connection that OpenClaw gave too few permissions now says "Connected,
  but OpenClaw did not give this office permission" with the reason and the fix (or "Connected ·
  limited access" when only full access is missing), in Agent Providers, the settings summary,
  chat windows, the setup wizard's gateway test and the server log, instead of a plain
  "Connected".
- Settings an older office (0.7.x) left in `openclaw.json` (`allowInsecureAuth`,
  `dangerouslyDisableDeviceAuth` and the office's `allowedOrigins` entry; current OpenClaw refuses
  the first) are reported at start, on the office page and in Agent Providers > OpenClaw, with two
  choices: "Clean it up for me" (backup first, plain JSON only) or "I will run openclaw doctor
  --fix". Nothing is edited on its own.
- Secret files in the data folder keep their owner: they are made private (0600, or 0640 when
  their group could read them) without being handed to root, so a data folder you own stays
  readable by you when Docker runs the office as root. New ones take the data folder's owner.
  The compose file explains `user:` and how to give an existing volume to your user once.
- Older OpenClaw (2026.7): the tasks panel works there too (the office sorts the task list itself
  when OpenClaw cannot), instead of an error.

## Live updates and connection

- Live updates survive reloads, several tabs and a reverse proxy: streams are counted per page, a
  closed tab frees its stream at once, and a refused stream is retried within seconds.
- When the office server stops answering, a banner says "Lost connection to the office.
  Retrying..." and the dashboard counts dim with the time they were last seen; "Back online" when
  it returns, and everything is read again.
- Faster repeat visits: every versioned file (including fonts and modules) is cached for good, and
  the page itself is compressed.

## The office

- At night the office keeps its lights on: a bright, warm room with the night in the windows,
  instead of a dark blue one. Settings > General > Night inside > Dim (moonlight) brings back
  the old look, lit only by screens, lamps and the moon. The choice is kept per browser.
- A desk still assigned to someone who is not in this office counts as free: agents without a
  desk can use it.
- Desks nobody uses show their screens off; they light up when someone sits down.
- Automatic desks: an agent without a desk of its own gets the same free desk every time the
  office opens.
- Helpers (interns) wear a small INTERN tag; helpers that are already working when you open the
  office sit at their desks right away, only new ones walk in.
- When several agents need you they stand apart at the front desk and their signs sit side by side.
- Stand-up: an agent pulled away from the table walks back, or joins by phone, so what you see
  matches the stand-up. The stand-up title sits beside the meeting table, clear of other furniture.
- The lobster and chicken costumes have their own look from behind.
- Themes: Retro Pixel gives the office a warm sepia look, by day and by night. Under Gameboy
  Classic the people keep a readable outline at every zoom (the lightest green by night, when a
  dark line would vanish).
- The Daily Office shows each agent's pixel figure next to its name instead of an emoji.

## Agents and chat

- Agent Studio Save no longer warns that the office was changed somewhere else when it was not.
- New agent: when the provider refuses, the wizard stays open with everything you entered, says
  why in plain words and offers Retry.
- Agent details: Last request shows where a request came from (Scheduled job, Subagent task,
  Heartbeat) with a short summary instead of the long internal instructions.
- Agent Studio: the desk list says Automatic desk (and which desk) for an agent without a desk of
  its own.
- Chat says "Waiting for your OK" while an approval waits and "Retrying (1/5)" while the provider
  retries.
- In a narrow chat window the model and effort chips are no longer cut: the model chip leaves out
  the provider (its tooltip keeps the full name) and the row wraps when it has to. Session rows
  are compact, with the rename pencil beside the delete button.

## Office editor

- E leaves the office editor again, as the shortcut card says. Esc steps back one level and never
  leaves the editor.
- The dashboard folds away while you edit, so the office gets the room, and comes back when you
  are done.
- Floor pieces never land on a wall: pointing at the top wall with a plant puts it on the floor
  right under the wall, and a piece cannot be dragged onto the face of any wall, in any layout.
- Deleting names what went: "Deleted label LOUNGE", "Deleted Plant".
- Room templates that do not fit where you point show where they fit (dashed outlines) and offer
  **Place at a free spot**; **Expand office to fit** now also helps when something is in the way
  (it adds a strip as big as the layout and places it there).
- The Pet tab's "Office pet" checkbox sits beside its label.

## Phones

- The first view keeps toasts off your agents: the office is framed above the sheet and the toast
  band, and toasts show one at a time, so the first tap reaches the agent.
- Every control is a 44 px touch target: map controls, editor tabs, favourite stars and search,
  the chat header, model and effort chips, composer buttons and settings checkboxes. The compact
  look stays; the extra room is an invisible margin around each control.
- The top bar shows the whole office name beside DEMO and the settings button (on narrow phones
  the DEMO badge leaves out "Upgrade").
- Screen readers hear item names in the editor ("Add Boss Desk to favorites"), never internal ids.

## Pixel icons everywhere

- The last emoji that worked as icons are pixel icons now: New Agent, the Create Agent window, the
  Unassigned branch, the Agent Studio branch list, chat session, skill and meeting delete, the
  Agent PC, workspace and browser window buttons, editor catalog cards and the whole setup wizard
  (Activate, passcode, Launch Office and every status line). An emoji you pick for an agent or a
  branch stays as you chose it.

## New version notice

- The office tells you when a new version is out: a small banner "Version X is available. See
  what's new" opens the release on GitHub. Close it and it stays hidden for a day.
- Settings > General > Version shows the version you run, whether it is up to date, a Check now
  button and a link to the new [update guide](UPDATING.md). "Tell me when a new version is out"
  turns the check off (or `VO_UPDATE_CHECK=0` for the whole server). The office only asks GitHub
  for its latest release, at most twice a day; nothing about your office is sent.
- After an update, a "What's new" window shows these notes once. It works offline.

## Docs

- [Updating](UPDATING.md): back up, update (published image, source build or plain Python), roll
  back and its limits, how the new version check works, approving the office in OpenClaw once,
  and "Upgrading from 0.7.x" (install types, what the office needs from OpenClaw, access and
  security changes, file permissions).
- README: the office editor keys (Esc never leaves the editor, E does), the demo badge (there is
  no watermark), and the theme names as Settings shows them.

## Upgrading

Pull the new image (or rebuild from source) and restart. The server gives every changed file a new
cache token, so browsers load the new version without a hard refresh.

- Office on the OpenClaw computer (plain Python, or Docker with host networking): nothing else to do.
- Office in Docker with the standard compose file (bridge network), or OpenClaw on another computer:
  approve the office in OpenClaw once. Agent Providers > OpenClaw shows the command; see
  [Updating](UPDATING.md#openclaw-in-docker-or-on-another-computer-approve-the-office-once).
- Coming from 0.7.x: read
  [Upgrading from 0.7.x](UPDATING.md#upgrading-from-07x) first (public domain names need
  `VO_ALLOWED_HOSTS`, no CORS, cross-site writes blocked, port 8091 off by default, passcode and
  agent token, Hermes Desktop replaced by Agent Providers, data folder no longer open to everyone,
  rolling back and its limits).

## For developers

- One version source: `VO_VERSION` in `app/server.py`. `GET /api/version` adds `current`;
  `GET /api/version/updates` (`?refresh=1` = Check now) answers `current`, `latest`, `newer`,
  `url`, `name`, `publishedAt`, `checkedAt`, `enabled`, `error`; `GET /api/version/notes` serves
  these notes. The setting is `features.updateCheck` in `vo-config.json`; `VO_UPDATE_REPO`
  changes the repository. The Docker image is built from `app/` only, so
  `app/release-notes/RELEASE-NOTES-<version>.md` is a copy of this file (a test keeps them equal).
  Tests: `tests/test_v101_updates.py` and `tests/test_v101_updates.mjs`.
- New tests: `tests/test_v101_ui_phone.mjs`, `tests/test_v101_ui_desktop.mjs`,
  `tests/test_v101_ui_icons.mjs`, `tests/test_v101_editor_wall.mjs` and
  `tests/test_v101_editor_templates.mjs` (with the other `test_v101_*` tests of this release).
- `canvas[data-studio-sprite]` (drawn by the Agent Studio's `drawSprites`) now takes
  `data-studio-view` (a preview view such as `card`), `data-studio-size` (CSS px) and
  `data-studio-floor="0"`.
- `OfficeLayouts.fitSpots()` lists where the layout being placed fits, `placeAtFreeSpot()` places it
  on the nearest one, and `getPlacementState().fits` counts them.
- Phones: the CSS custom property `--vo-framing-reserve` (plain px) is the band at the bottom of
  the office canvas that the phone framing keeps clear of agents.
- Editor placement: floor pieces are checked by their base line (`_floorBaseLine`) against the top
  wall and the faces of interior walls; wall pieces, counter appliances and labels keep their own
  rules.
- OpenClaw pairing: `tests/tools/lab-openclaw.sh` starts a private real OpenClaw gateway (stub
  model, loopback plus the docker0 address); `OC_LAB_E2E=1 python3 -m pytest
  tests/test_openclaw_lab_e2e.py` checks handshake, scopes, pairing and chat against it (skipped
  without the flag or without openclaw). New route action:
  `POST /api/agent-providers/device {"id": "openclaw", "action": "repair" | "forget"}` (manage
  permission, same gates as the other Agent Providers actions); the OpenClaw row of
  `GET /api/agent-providers` gains `device` (`state` off | unpaired | pending | paired,
  `deviceId`, `requestId`, `command`, `since`, `scopes`, `signer`; never the key or token);
  provider status codes `scope_missing`, `scope_limited`, `pairing_required` (state `pairing` with
  `requestId`, `command`, `lead`); `/api/gateway/test` gains `permission` (+ `missingScopes`,
  `detail`, `fix`).
- Leftover `openclaw.json` settings: `GET /api/openclaw/leftovers` (read only) and
  `POST /api/openclaw/leftovers/cleanup` (Full access; a remote caller needs the passcode confirmed
  in the last 10 minutes); rules in `app/openclaw_leftovers.py`, page part in
  `app/vo-openclaw-leftovers.js`.
- Secret files: write them with `private_files.write_private(path, data)` (temp file, keeps owner
  and group, 0600 or 0640, folder owner for a new file when running as root); `tighten(path)`
  makes an existing file private without changing its owner.
- Tests: `tests/test_v101_upgrade.py` (leftovers, private files incl. a simulated root office in a
  folder owned by someone else) and the older-OpenClaw task list in
  `tests/test_hp_openclaw_adapter.py`.
