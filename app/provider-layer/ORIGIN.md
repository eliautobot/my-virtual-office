# Origin of app/provider-layer

Copied from My Virtual World commit 620b23ce on 2026-11-09, adapted for My Virtual Office; maintained here.

This is history only, not a sync rule: the files below are My Virtual Office's own code from now on and are edited
here freely. The only change in the first (pristine) commit was line 1 of every file: My Virtual World's licence line
became My Virtual Office's AGPL-3.0 notice. Every later change is a My Virtual Office adaptation (see git log).

Copied, keeping My Virtual World's relative layout:

- server/providers/openclaw/* and server/providers/hermes/* (the two adapters)
- server/providers/: host.js, host-main.mjs, bus.js, registry.js, manifest.js, media-lines.js, models.js,
  screen-relay.js, mock.js (tests only)
- server/: connections.js, agent-providers.js, agents.js, secrets.js, secret-holders.js, auth/permissions.js, db.js,
  sqlite.js
- server/chat/: chat.js, sessions.js, transcript.js, attachments.js, references.js, projects.js, provider-media.js
- client/js/core/: util.js, icons.js, agent-view.js
- client/js/ui/: agent-providers.js, providers/openclaw.js, providers/hermes.js, providers/hermes-chat.js, chat-md.js,
  chat-rail.js, provider-browser.js, provider-screen.js, chat.js, chat-window.js, chat-dock.js
- client/css/: chat.css, agent-providers.css

Written for My Virtual Office (not copied): server/provider-routes.mjs (the provider, connection and chat route block
of My Virtual World's routes.js, adapted), vo-host.mjs (composition), vo-router.mjs (request rules) and the small
modules that replace My Virtual World-only imports.

npm packages, at the versions My Virtual World pins: @openclaw/gateway-client 2026.10.4, @openclaw/gateway-protocol
2026.10.4, typebox 1.3.34, ipaddr.js 2.5.0, ws 8.21.3 (all MIT); @novnc/novnc 1.7.0 (MPL-2.0, served unmodified).

Changes to copied files for OpenClaw 2026.11 (v0.11 rel1102; OpenClaw 2026.11 removed its task ledger: the gateway
offers no tasks.list/get/history/cancel/dismiss/retry and sends no `task` events; found by comparing the hello of a
2026.9.6 and a 2026.11.2 gateway):

- server/providers/openclaw/tasks.js: a gateway that does not offer tasks.list answers an empty task list with
  `unavailable` (why) instead of the 501 "This agent platform does not do that" (feature detection, as the adapter
  already does for browser.request, progressCard.* and others).
- server/chat/chat.js: tasks() passes `unavailable` through (a string, at most 300 characters).
- client/js/ui/chat-dock.js: the side panel's Tasks tab shows that line ("No background task list.") and hides the
  This chat / All choice when the list is unavailable.
- server/providers/openclaw/translate.js + chat.js (context meter): OpenClaw 2026.11 leaves a new session's
  totalTokens unset (totalTokensFresh false) after its first turn and knows it from the second, so the meter stayed
  hidden after a chat's first answer; history() now falls back to the transcript's own usage (the latest assistant
  message's prompt tokens, the assistant messages' cost) only when the row has no total (new usageFromTranscript).
- server/providers/openclaw/translate.js (deferred tools): OpenClaw 2026.11 renamed the deferred-tool wrapper
  tool_call to dispatch_action (dist TOOL_CALL_RAW_TOOL_NAME; the same { id, args }); WRAPPER became WRAPPERS with
  both names, so a wrapped call still shows as the tool it calls and a wrapped ask_user/progress_card as its card.
- server/providers/openclaw/link.js (gateway restarts): a request the gateway refused before running it because it is
  restarting, suspending or still starting (UNAVAILABLE, retryable: true, retryAfterMs, details.reason
  gateway-restarting / gateway-suspending / startup-sidecars; OpenClaw 2026.9.6 and 2026.11.2 alike) is asked again
  once the gateway is back, for up to AGAIN_MS (20 s); before, the page got a 503 (2026.9.6 restarts itself to take some
  config changes: changing an agent's model twice in a row met it). A reading (models.list ...) the gateway answered
  "Model catalog is not ready. Retry after Gateway startup or refresh finishes." (the catalog rebuilt after such a
  restart; a plain error) is asked again the same way; a write or chat.send never. tests/test_pl_link_restart.mjs.

Changes to copied files for the office's own providers in the same chat window (unify, kind `office`: the office's
Codex, Claude Code, OpenCode, Antigravity, Hermes API and extension agents, run by the office server and spoken to in
process by server/office-bridge.mjs, which is the office's own file; wiring in vo-host.mjs; tests/test_pl_office_bridge.mjs):

- server/providers/manifest.js: a manifest `office` ("This office": internal, agentCaps, live; the capabilities its
  agents may have, no queue, no rewrite) and `isInternalKind`.
- server/connections.js: a connection of an internal kind is never listed (visible), found for a change, test or share
  (need: 404), addable or made by hand (create: bad_kind); `isInternal`, and `ensureInternal` makes its one connection
  (installation-wide, shared with the members as vo-migrate.mjs shares the office's others).
- server/agents.js: `setExt(id, key, value)` writes one part of a record's ext_json (the provider's per-agent extras;
  ext_json was reserved and empty).
- server/agent-providers.js: `inproc` kinds (as Chat's): their calls (connect, agents ...) go to the in-process handler,
  not the helper; syncAgents takes a listed agent's own `role` (the office's Agent Studio is its record) and keeps its
  `ext` as ext_json[kind]. OpenClaw and Hermes list neither, so nothing changes for them.
- server/chat/chat.js: `capsOf(agent, connection, manifest)`: a kind with agentCaps narrows its capabilities to the
  agent's own (ext_json[kind].caps); canChat answers those, and the chat-list sync and the video/audio attachment check
  use them. Every other kind: its manifest's capabilities, as before.
- server/chat/chat.js (unify integration): a send the provider refuses as `busy` (409) removes the user message it had
  written and writes no "failed" line (the window queues it and sends it again).
- server/chat/chat.js (unify integration): PUBLIC event fields + `raw` (a step's arguments as JSON text, bus-clipped)
  so vo-mount's vo:agent-tool-preview gives the office's Agent PC the arguments as an object, as the office window did.
- server/provider-routes.mjs: /api/providers and /api/agent-providers list no internal kind.

Changes to copied files for one chat window for every agent (unify, 0.12: the office's other providers — Codex, Claude
Code, OpenCode, Antigravity, a Hermes API server, extensions — are agents of the layer's internal kind `office`, so the
copied window hosts every agent; the office-only modules vo-mount.mjs, office-voice.js and pl-office.css carry the rest):

- client/js/ui/chat.js (window manager): `open(null)` reopens the agent and chat this browser used last
  (`app.lastUsed`, vo-mount's `vo.chat.last`) before the account's most recent chat; `another(from)` is the header's
  "+" (a new window beside the others, on an agent no window shows yet, its picker open); `canOpen` counts the office's
  own windows toward the four; `app.chat` also offers `another`, `holder` and `unread`; the manager reports its windows
  and unread answers to `app.windowsChanged` (the office's dock badge and chat-open state).
- client/js/ui/chat-window.js: a "+" header button (`.cw-plus`, disabled at four windows); a pick or a send tells
  `app.used` (vo.chat.last and the office's `vo:chat-opened-agent`; restored windows stay quiet); `show()` takes a
  provider's session key (a string) and finds that chat in the agent's list; kind `office`: the model chip is read-only
  (the agent's own model: session, history, the agent row's `provider.model`, else the model the latest answer named;
  no menu) and effort is hidden (pickers for those providers come later); `caps.sessions === false` (one conversation:
  Antigravity) hides the Sidebar and New chat (`.cw-one-chat`). The picker still switches the agent in place across
  kinds (one chat is never in two windows); ⧉, Ctrl/⌘ or middle click and "+" are the only ways to another window. A
  window already showing the agent, brought forward (Chat, a desk, the picker), counts as opened too (`app.used`). A send
  refused 409 `busy` (an agent with no caps.queue answering in another chat: Codex takes one turn per agent) waits in the
  window's queue ("sent when <agent> is free") and is tried again every 4 s until it goes.

## Voice (unify, uV-voice, 2026-11-13)

Copied from My Virtual World (its working tree of 2026-11-13; line 1 became the office's notice):
server/voice/voice.js, text.js, audio.js, routes.js; server/providers/voice.js (the voice adapter, loaded by the helper
like the OpenClaw and Hermes adapters); client/js/ui/voice.js, voice-core.js, chat-voice.js (the chat window's 🎤 / 🔊 /
🎧), voice-settings.js (Settings → Voice, the agent's voice); tests/unit/voice-providers.test.mjs and
tests/helpers/audio.mjs (as tests/test_pl_voice_providers.mjs, tests/helpers/pl-voice-audio.mjs); tests/unit/voice-audio,
voice-cache, voice-pick and voice-window (as tests/test_pl_voice_{audio,cache,pick,window}.mjs).
The office's changes:
- manifest.js VOICE_PROVIDERS gains `whisper` (a Whisper server on this network: POST <address>/transcribe, the office's
  own app/whisper-server.py; listens only, no key); providers/voice.js answers it (same address rules as `custom`);
  connections.js optionalIf takes a list of values (the API key is optional for custom and whisper).
- server/voice/voice.js: an account's prefs also keep `autoRead` (Settings → Voice: read every answer aloud).
- server/voice/routes.js: the spoken audio goes back as `body` (the office's router), not `pre.body`.
- client/js/ui/voice.js: no Sound settings in the office, voices play at full volume (was audio/mixer.js level()).
- client/js/ui/voice-settings.js: the office's words (the office's voice, Agent Studio → Voice), its installation settings
  through GET/POST /api/voice/settings (vo-voice.mjs; My Virtual World: /api/settings voice.*), admin = settings.secrets,
  the Whisper server in "Add a voice service", "read every answer aloud", a service added for everyone may be used by
  its owner at once, Remove asks in the office's own dialog (VOUI.confirm).
Office files: vo-voice.mjs (the voice.* settings, /api/voice/settings, the one-time adoption of the office's Whisper
server), client/js/ui/office-voice.js (wraps chat-voice.js: buttons only where they can work, auto read),
client/js/ui/office-voice-settings.js (draws Settings → Voice and the Agent Studio's Voice tab: voPL.mountVoice /
mountAgentVoice), client/css/pl-voice.css.

## Presence and helpers (v13 presence, 2026-11-13)

The office's changes to copied files:
- server/providers/openclaw/activity.js: an agent's agent.activity `task` takes the title of one of its own sessions
  only, never of a `agent:<id>:subagent:<uuid>` session (a helper it spawned: its label is the helper's job; the office
  says "Waiting on 2 helpers", app/provider_layer_life.py); an ACP child (`agent:<id>:acp:<uuid>`) is a helper too.
- server/providers/openclaw/tasks.js: a gateway with no task ledger (OpenClaw 2026.11: no tasks.*, no `task` events) but
  sessions.list lists the chat's helpers from their sessions instead of answering NO_LEDGER: `children()` asks
  sessions.list {agentId, spawnedBy: <chat>} (an older gateway that refuses the filter: the agent's sessions by
  activity, filtered here), `sessionTask(row)` makes each subagent/ACP session a task (`id: "session:<child key>"`,
  title = its label, status from hasActiveRun/status, runtime subagent|acp, startedAt/endedAt, sessionKey = its parent),
  `onSession()` turns sessions.changed of a helper session into `session.task` upserts for the open chats of its agent
  (once per status/title/end change; the parent from the last listing when the row omits it); get/history/cancel of
  such a task read sessions.list, chat.history of the child session and chat.abort of it. NO_LEDGER stays for a gateway
  with neither tasks.list nor sessions.list. tests/test_pl_openclaw_2026_11.mjs: the NO_LEDGER case is that gateway now;
  tests/test_pl_v13_helper_tasks.mjs is the office's.

## Mobile chat (0.12.0 mobilechat, 2026-11-13)

The office's changes to copied files (the phone layout itself is the office's own pl-office.css §7, <= 640 px):
- client/css/chat.css: the "N running tasks" row (`.cw-tchip`) is at most the window's width (`max-width:
  min(var(--cw-col), 100%)`, border-box) and its count (`b`) never wraps, so the task title gives way with an ellipsis;
  it ran past the right edge of a phone (780 px wide, the column's width).
- client/js/ui/chat-window.js: the progress card keeps the person's open/closed choice. A turn starting or ending no
  longer opens it (`paintCard`: `c.auto = !narrow()` at each new run re-opened it each time a message was sent once the
  person, or the "reading back" fold, had closed it — a window just opened on a long chat folds it so as it scrolls
  its history to the end). The choice
  is kept in localStorage `mvw.chat.cards` ("<agent>|<session>" -> true/false, the last 100 chats; `cardChoice`,
  `keepCardChoice`), read when a chat's card state is first made, so closing the window or reloading keeps it;
  dismissing the card forgets it. tests/test_rel_mobile_chat.mjs.

## The message rail keeps to the conversation (0.12.0 cardfix, 2026-11-13)

The office's changes to copied files:
- client/css/chat.css: `.cw-rail` is placed in `.cw-main`'s conversation grid row (`grid-row: 2 / 3; grid-column:
  1 / 2`, both lines: for an absolute grid item an `auto` end line is the container's edge) and is at most that row's
  height less 12 px (`calc(100% - 12px)`, was 56% of the whole column). Centred on the whole column (title bar,
  conversation and composer) it fell over the composer on a short window: on the phone's default half-height sheet the
  open progress card's chevron lay under its ticks, so a tap there opened the rail and the card stayed open.
- client/js/ui/chat-rail.js (`open()`): the list, centred on the rail, is as tall as fits above and below the rail's
  middle inside `.cw-main` (`2 * min(mid - top, bottom - mid) - 24`, 96-340 px; was the column's height - 24, right only
  while the rail sat at the column's middle). tests/test_rel_mobile_chat.mjs (half sheet, full sheet, desktop).

## Heartbeat turns end (0.12.0 presence3, 2026-11-13)

The office's changes to copied files:
- server/providers/openclaw/activity.js (LinkActivity): a session held running is let go when the gateway's own listing
  says it no longer runs. OpenClaw 2026.11's scheduled heartbeat (cron job "Heartbeat (main)", main's session) sends
  sessions.changed hasActiveRun true while it runs and, at its end, a change with phase "end" that still says
  hasActiveRun true / status running, then `heartbeat` and `cron` (action finished) events: never a change with
  hasActiveRun false (an ordinary turn sends one, reason agent.input.settled), so the agent read working until a
  restart. Now: a phase-"end" change that still says running, a `heartbeat` event, a `cron` finished event or a keyless
  removal notice has the held rows checked against sessions.list (`check()`, 1.5 s later), and while any session is
  held running it is checked every 30 s anyway (`checkSoon`, cheap: one sessions.list, none while nothing runs): a held
  row the listing shows not running (or no longer lists, the listing being complete) ends, a running one it lists and
  the feed missed starts; a row the feed changed after the request went out is left to the feed. A row without a
  boolean hasActiveRun is read by its status (`rowActive`: running/queued/... vs done/failed/killed/...); a removal
  (`reason: "delete"`, reset, archive, `deleted`/`removed`) runs nothing. Constructor options recheckMs/reconcileMs
  (tests). tests/test_pl_rel_heartbeat_activity.mjs (recorded lab shapes), tests/e2e/pl_rel_heartbeat.sh.
