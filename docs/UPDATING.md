# Updating My Virtual Office

When a new version is out, the office shows a small banner ("Version X is available") and
**Settings > General > Version** says so too. This page explains how to update, how to go back,
and how the check works. Office in Docker, OpenClaw on another computer, or coming from 0.7.x?
Read [approve the office once](#openclaw-in-docker-or-on-another-computer-approve-the-office-once)
and [Upgrading from 0.7.x](#upgrading-from-07x) too.

## 1. Back up your data first

Everything the office keeps (settings, layout, license, passcode, projects, Agent PC history,
Office life) lives in its data folder: the `vo-data` Docker volume, mounted at `/data`.

Find the volume name, then copy it into a file next to you:

```bash
docker volume ls | grep vo-data
docker run --rm -v <project>_vo-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/vo-data-backup.tgz -C /data .
```

Running without Docker? Copy the folder `VO_STATUS_DIR` points at (for example
`cp -a ./vo-data ./vo-data-backup`).

Since 0.11 the data folder also holds `provider-layer/` (the OpenClaw and Hermes integration's
database) and `provider-layer.key`, the key that seals its secrets. The commands above copy both;
always keep them together: without the key the sealed secrets cannot be read.

Read the release notes of the new version before you update (`docs/RELEASE-NOTES-<version>.md`,
or the release page the banner links to). They say when something needs your attention.

## 2. Update

### Docker Compose with the published image (the default)

The compose file runs `ghcr.io/eliautobot/my-virtual-office:latest`. Pull the new image and
recreate only the office container:

```bash
cd my-virtual-office
git pull                                   # newer compose file and docs
docker compose pull virtual-office
docker compose up -d virtual-office
```

To stay on a chosen version instead of `latest`, set `VO_IMAGE` (in `.env` or on the command
line), for example `VO_IMAGE=ghcr.io/eliautobot/my-virtual-office:0.13.1`.

### Docker Compose, built from the source you checked out

```bash
cd my-virtual-office
git pull
docker build -t my-virtual-office:0.13.1 ./app
VO_IMAGE=my-virtual-office:0.13.1 docker compose up -d virtual-office
```

Use the version you pulled in the tag (it is `VO_VERSION` in `app/server.py`).

`docker compose up -d virtual-office` recreates only the office container. The `vo-data` volume,
your OpenClaw home and any Hermes sidecar are kept.

The Permissions mode you picked for each Codex and Claude Code agent (since 0.13.1, kept in
`agent-permissions.json` in the data folder) is kept too: an update never changes it. A new
version's starting mode (Ask first for Codex) only applies to agents nobody has set yet.

### Plain Python (no Docker)

```bash
cd my-virtual-office
git pull
python3 -m pip install "websockets==17.0.1"   # the version app/Dockerfile installs
# stop the running server (Ctrl+C or your service manager), then start it again:
VO_STATUS_DIR=/path/to/your/vo-data python3 app/server.py
```

Keep the same `VO_STATUS_DIR` and other `VO_*` settings you used before.

Since 0.11, OpenClaw and Hermes need Node.js 22.19 or newer (24 recommended) with `npm` on the
`PATH` (the Docker image includes Node 24). The first start installs the integration's packages
once (`npm ci --omit=dev` in `app/provider-layer`). Without Node, OpenClaw and Hermes stay off and
the office says how to fix it; every other provider keeps working.

## 3. Check that it worked

Open `http://localhost:8090/health` (your port may differ). It answers
`{"ok": true, "status": "running", "version": "..."}` with the new version, and
**Settings > General > Version** shows it too. The first time you open the office after an
update, a "What's new" window lists the changes once.

If the page looks odd right after an update, reload it once (Ctrl+Shift+R) so the browser picks
up the new files.

## OpenClaw in Docker or on another computer: approve the office once

Who needs this: offices that reach OpenClaw over a network instead of on the same computer. That
is the standard Docker Compose install (the office dials `ws://host.docker.internal:18789` over
Docker's bridge network) and any office pointed at a gateway on another machine. Offices on the
OpenClaw computer (plain Python, or Docker with `network_mode: host` and `ws://127.0.0.1:18789`)
are not affected: nothing changes, no pairing, no new file.

Why: current OpenClaw gives a connection that only shows the gateway token, no permissions at all,
unless it comes from the gateway's own computer. Older office versions then said "Connected" while
chat and the agent list were empty. The office now connects the way OpenClaw documents for other
computers: as a device that you approve once.

What to do after the update:

1. Open **Agent Providers** (Providers in the office menu). The OpenClaw connection says
   "Waiting for approval" and shows a command like `openclaw devices approve 1a2b3c4d-...` with
   a Copy button. The setup wizard's OpenClaw step shows the same card (and lists the agents once
   you approved).
2. Run that command on the OpenClaw computer (or approve the pending request in OpenClaw's
   Control UI, where the office is listed as "My Virtual Office"). `openclaw devices list` shows
   the request if you lost the command.
3. Within a few seconds the office connects by itself and Agent Providers shows "Connected ·
   OpenClaw" with OpenClaw's version. Chat, the agent list and presence work again, and so do the
   office's own OpenClaw features (New agent, the skills workshop, the gateway restart after a
   model or key change): they all use this one approved connection, so OpenClaw never shows a
   second request. The approval is kept when either side restarts.

How it works since 0.11 (the integration copied from My Virtual World, on by default):

- The office's device and OpenClaw's device token live in the integration's database,
  `provider-layer/next.db` in the data folder, sealed with `provider-layer.key` next to it. Back
  up both together (section 1): without the key the device cannot be opened and you approve the
  office again. A 0.10 `openclaw-device.json` is taken over once at the first 0.11 start, so an
  office paired with 0.10.1 stays paired; after that the file is no longer used.
- On the OpenClaw computer (a loopback address) the office signs in with the gateway token alone,
  as before: no device, nothing to approve.
- After pairing, the office forgets the gateway token or password and signs in with its own
  device token.
- The compose default `ws://host.docker.internal:18789` works. OpenClaw's client sends a token
  over plain `ws://` only to a private address, so the office dials the address behind that name
  (your saved address stays as you entered it). For a gateway on another computer use its private
  IP, a `.local` or `.ts.net` name, or `wss://`.
- OpenClaw 2026.7.x works too (chat, the model list, chat history, agent names), on the same
  computer and from Docker; 2026.7.1-2, 2026.9.6 and 2026.11.2 were tested.
- A fresh install: the gateway token you enter in the setup wizard (or the one the office reads
  from `openclaw.json`) becomes the OpenClaw connection in Agent Providers by itself, once, while
  there is none yet. If you remove that connection in Agent Providers, it stays removed.
- If the device is removed in OpenClaw (or its token expired), Agent Providers says so: press
  **Edit** and enter the gateway token again to pair anew.
- In Docker the office runs as root. When the data folder is a folder you own (a bind mount),
  `provider-layer/` and `provider-layer.key` keep your ownership like the office's other files
  (`agent-pc/`, `office-life/`, `projects-md/` and the rest), so you can back them up and manage
  them without `sudo`.

With `VO_PROVIDER_LAYER=0` the office keeps 0.10's own OpenClaw client for this release. Good to
know there:

- The device key and OpenClaw's device token are stored in `openclaw-device.json` in the office
  data folder (readable by its owner only, mode 0600). Keep it with your data backups; if it is
  deleted, approve the office again. Never share it. Nothing new to install: the office uses the
  `cryptography` package when it is there and its built-in signer otherwise.
- The approval covers the office's access level. Switching the OpenClaw connection from Chat only
  to Full access asks OpenClaw for approval again (a new request id; OpenClaw calls it a scope
  upgrade); the office shows the new command until you approve it.
- **Pair again** (Agent Providers > OpenClaw) asks again with the same key, useful after the
  device was removed in OpenClaw. **Forget this device** makes a new key; approve the new request,
  then remove the old entry in OpenClaw with `openclaw devices remove <deviceId>` (ids are in
  `openclaw devices list`).
- If the office says "Connected, but OpenClaw did not give this office permission (missing
  operator.read, ...)", OpenClaw accepted the token but gave no permissions and no approval
  request was possible (for example a gateway that does not send a connect challenge). Run the
  office on the OpenClaw computer or with Docker host networking, or update OpenClaw.
  "Connected · limited access" means only operator.admin is missing: chat works, settings and the
  agents' browser do not; approve the office with Full access or switch the connection to Chat
  only.
- The setup wizard's gateway test also prints "Permission: ..." when OpenClaw gave the office no
  permission.

## Upgrading from 0.7.x

Your data carries over: settings, layout, desks, looks, projects, tasks, meetings, skills, chat
sessions, agents and Hermes connections are read in place, and a second start changes nothing.
Back up first anyway (section 1). What else to know depends on how you run the office.

### Your install type

- **Docker Compose with the shipped file (bridge network).** Take the new compose file
  (`git pull`) and the new image (section 2). The new file adds `init: true`, log rotation and the
  access settings below; the old one still starts the office. After the first start, approve the
  office in OpenClaw once (previous section): without that, OpenClaw gives a bridge connection no
  permissions.
- **Docker with `network_mode: host`** (gateway at `ws://127.0.0.1:18789`): update as usual.
  Nothing to approve.
- **Plain Python on the OpenClaw computer:** install Node.js 22.19 or newer (for OpenClaw and
  Hermes, see section 2), then `git pull` and restart. This also fixes the connection: 0.7.x cannot connect to current OpenClaw at all.
  Pointed at a gateway on another computer: approve the office once (previous section).
- **You edited the office's own files** (`app/*.py`, `app/*.js`, `index.html`): most of them were
  rewritten since 0.7.x, so `git pull` will conflict. Save your changes first
  (`git diff > my-changes.patch`), take the new version (`git checkout -- app && git pull`), then
  bring back what you still need. Data-side changes (`vo-config.json`, `office-config.json`,
  projects, skills) carry over unchanged.

### What the office needs from OpenClaw

- The office connects as a backend client with the gateway token. It no longer needs the Control
  UI settings 0.7.x wrote into `openclaw.json` (`gateway.controlUi.allowInsecureAuth`,
  `dangerouslyDisableDeviceAuth` and the office's own `allowedOrigins` entry). Current OpenClaw
  refuses `allowInsecureAuth` ("config reload skipped (invalid config)"). When the office finds
  these settings it says so at start and on the office page (with `VO_PROVIDER_LAYER=0` also in
  **Agent Providers > OpenClaw**),
  with two choices: **Clean it up for me** (Full access and the passcode; the office keeps a
  backup `openclaw.json.vo-backup-<time>` next to the file, private to its owner, and edits plain
  JSON files only) or **I will run `openclaw doctor --fix`**. It never edits on its own.
- On the OpenClaw computer, OpenClaw 2026.7, 2026.9 and 2026.11 were tested and give the office full
  permissions with nothing to approve.
- From Docker's bridge network or another computer, OpenClaw must offer device pairing (it sends a
  connect challenge; tested with OpenClaw 2026.7.1-2, 2026.9.6 and 2026.11.2). An OpenClaw too old for that
  cannot pair, and the office says so instead of showing "Connected".
- Older OpenClaw (2026.7) does not sort task lists for the office; the office sorts them itself,
  so the tasks panel works there too. OpenClaw 2026.11 removed its background task list; the tasks
  panel says so, and subagents still report back in the chat.

### Chat and voice since 0.12

- **One chat window for every agent:** OpenClaw, Hermes, Codex, Claude Code, OpenCode,
  Antigravity and built-in agents all chat in the window that came with the integration. The chat a
  0.7.x browser had chosen is carried over once. The older chat window is only used when the
  integration is off (no Node.js, or `VO_PROVIDER_LAYER=0`).
- **Voice moved to Settings > Voice** and is free for everyone. The Whisper address of 0.7.x
  becomes a "Whisper server (this network)" listening service there, carried over once and only
  when the office used it (Whisper switched on, or `VO_WHISPER_URL` set). Browsers only allow the
  microphone on `https://` or on `localhost`; over plain `http://` to another computer's address
  the microphone button says so when pressed.

### Access and security changes since 0.7.x

- **Public domain names:** behind a reverse proxy on a public domain, list the name in
  `VO_ALLOWED_HOSTS` (comma separated, for example `VO_ALLOWED_HOSTS=office.example.com`; a
  leading dot such as `.example.com` covers its subdomains) or set a passcode. Otherwise every
  request answers 403 "This office does not answer to that host name". IP addresses,
  `localhost`, single-word names and private names such as `.local`, `.lan`, `.internal` or
  `.ts.net` always work.
- **No CORS:** other web pages can no longer read the office API from a browser (0.7.x answered
  every request with `Access-Control-Allow-Origin: *`). Scripts, agents and the office's own pages
  are not affected.
- **Cross-site writes are blocked:** a change sent by a page from another site answers 403
  `cross_site_blocked`. Requests without an `Origin` (scripts, agents) still work.
- **Port 8091 is off by default:** the office's own pages reach OpenClaw through the office server
  (`/api/openclaw/...`), so the raw gateway tunnel on `VO_WS_PORT` (8091) no longer opens. Only a
  tool that dialled `ws://<office>:8091` itself needs it: set `VO_OPENCLAW_BROWSER_TRANSPORT=direct`
  to bring back the old way.
- **Optional passcode** (setup wizard or **Settings > Security**, off by default): browsers on
  other devices sign in once; the office computer itself never needs it. Agents on other machines
  or in other containers then send the agent API token (`Authorization: Bearer <token>` or
  `X-Virtual-Office-Token: <token>`), shown in Settings > Security or fixed with
  `VO_AGENT_API_TOKEN`. With Docker's bridge network, list the bridge address in
  `VO_TRUSTED_CLIENT_IPS` (often `172.17.0.1`) so agents on the host skip it. See the README.
- **Hermes Desktop is replaced by Agent Providers:** the `VO_HERMES_DESKTOP_*` variables and the
  port scan are gone; add Hermes in Agent Providers (its **Find** button). Your existing Hermes API
  server connections keep working. `POST /api/hermes/desktop/discover` answers 410 and names
  `POST /api/agent-providers/detect`.

### File permissions in the data folder

- 0.7.x opened the data folder to everyone (`chmod 777` on `/data`, `666` on every file) at each
  container start. The office no longer does that.
- Files with secrets (`vo-config.json`, `access.json`, `agent-providers.json`,
  `provider-secrets.json`, `openclaw-device.json`, the media and proxy keys) are made private:
  mode 0600, or 0640 when the file's group could already read it. Their owner and group never
  change, so a data folder you own stays readable by you even though Docker runs the office as
  root. New secret files take the owner of the data folder.
- Since 0.12 this is checked at every start, for those files, their backups (`.bak`, `.pre-hp`,
  `.pre-pl`), `license.json`, `provider-layer.key` and `provider-layer/.principal-secret`, so a
  trip back to 0.7.x (which opens them all again) is undone by the next 0.12 start. The data
  folder itself and `provider-layer/` lose access for everyone else and write access for their
  group (0700, or 0750 when their group could already list them), when the office runs as root
  or as their owner; the log names what it made private.
- Since 0.11 the same goes for `provider-layer/` and `provider-layer.key`: in Docker with a data
  folder you own, the OpenClaw and Hermes integration runs as that folder's owner, so its
  database and key are yours to back up (keep them together). Files an earlier 0.11 start
  made as root are given back to the folder's owner at the next start. One exception: when an
  older office left its own files readable by root only, the first 0.11 start (the one that
  takes over 0.10's connections) runs the integration as root and gives its files back when it
  stops.
- Since 0.11 the office's other folders and files in a data folder you own are yours too
  (`agent-pc/`, `office-life/`, `projects-md/`, `layouts/`, `presence-snapshot.json` and the
  rest): what the office makes there takes the owner of the folder it is made in, so you can
  move, edit or delete them without `sudo`. Folders and files there owned by root (an earlier
  start's, or a folder Docker made as root for a bind mount) are given back at start (its log
  says how many). Secret files directly in the data folder
  that an older office made as root keep their owner, as above. A data folder owned by root
  (Docker's default named volume) stays as it is. Files written by the agent programs the office
  starts (Codex, Claude Code, OpenCode, Antigravity) in their folders there are still made as
  root while they run; the next start gives them back.
- Tools on the host that wrote into a root-owned Docker data folder only because it was open to
  everyone (for example `office.py` run on the host) need the right owner now. Either run the
  container as your own user (`user:` in `docker-compose.yml`, `PUID`/`PGID` in `.env`) and give
  the existing volume to that user once, with the office stopped:

  ```bash
  docker volume ls | grep vo-data
  docker run --rm -v <project>_vo-data:/data alpine chown -R 1000:1000 /data
  ```

  (use your own `id -u`:`id -g`), or run those tools inside the container
  (`docker exec virtual-office ...`).

## Rolling back

Point `VO_IMAGE` at the older version and recreate the office container:

```bash
VO_IMAGE=ghcr.io/eliautobot/my-virtual-office:0.7.4 docker compose up -d virtual-office
```

Without Docker: `git checkout v0.7.4` (or the tag you came from) and start `app/server.py`
again.

Checking out an older git tag alone does not change a running Docker image. If the older version
has trouble with data written by the newer one, stop the office and restore your backup:

```bash
docker compose stop virtual-office
docker run --rm -v <project>_vo-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/vo-data-backup.tgz -C /data
docker compose up -d virtual-office
```

This puts every backed-up file back as it was. Files the newer version added stay, and the older
version ignores them.

Limits of going back:

- **From 0.12 to 0.11 or older:** looks, moves and the pet are saved as they are, but an older
  build only knows its own lists. There a new hair style may show as no hair, a new pet kind shows
  as the lobster, and new tops, neckwear, costumes, hats, moves, the pet bed and the food bowl may
  not show. Back on 0.12 they are all there again, unless you changed that agent's look (or the
  pet) in the older build.
- **From 0.11 to a 0.10.x build** (0.8 to 0.10.1 were not published as GitHub releases): 0.11 leaves
  the 0.10 files in place (`agent-providers.json`, `provider-secrets.json`, `openclaw-device.json`;
  `.pre-pl` copies too), so 0.10 finds its OpenClaw and Hermes connections and its pairing again.
  Connections added or changed in 0.11 live only in `provider-layer/` and are not seen by 0.10. To
  try 0.10's path without going back, start 0.11 with `VO_PROVIDER_LAYER=0`.
- **To 0.10.0 or older:** `openclaw-device.json` is ignored (harmless to keep) and those versions
  cannot pair, so from Docker's bridge network they show "Connected" again without permissions.
  The approved device stays listed in OpenClaw until you remove it
  (`openclaw devices remove <deviceId>`).
- **To 0.7.x:** it reads the upgraded data (furniture and Hermes `serve` connections it does not
  know are skipped), but it has no passcode, so the office is open to everyone who can reach its
  port again, and its Docker entrypoint opens the data folder to everyone again. It cannot
  connect to current OpenClaw at all; with an older OpenClaw it relies on the `openclaw.json`
  settings described in "What the office needs from OpenClaw". If you removed them, the backup
  `openclaw.json.vo-backup-<time>` next to `openclaw.json` has them.

## How the update check works

- While the office is open in a browser, the office server asks GitHub for the latest release of
  `eliautobot/my-virtual-office` about twice a day
  (`GET https://api.github.com/repos/<repo>/releases/latest`).
  It sends nothing about your office: just that request with a `My-Virtual-Office/<version>`
  user agent. Drafts and prereleases are never offered.
- The answer is kept for 12 hours, a failed check for 1 hour, so an offline office or a GitHub
  rate limit does not cause repeated requests. **Check now** in Settings asks again, at most once
  a minute.
- Closing the banner hides it for that version for 24 hours in that browser.
- Turn the check off in **Settings > General > Version** ("Tell me when a new version is out"),
  or for the whole server with the environment variable `VO_UPDATE_CHECK=0`. Then no request is
  made at all.
- `VO_UPDATE_REPO=owner/name` checks a fork's releases instead.
