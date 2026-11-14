# Floor chat bubbles: where their data comes from (v0.12)

The chat bubbles over agents on the floor (game.js `agentChatData`, drawn on the canvas) are fed by one poll:
`pollAgentChat()` asks `GET /agent-chat?agents=<status keys>&limit=20&lite=1` every 2.5 s (ETag, 304 when nothing
changed, paused while the tab is hidden). A message with a new key (`_chatMsgKey`: id, epochMs, role, runId) opens the
bubble and types it out; an assistant message with no text yet but `thinking`, `reasoningTokens` or a running tool shows
the thinking dots (`_chatMsgInProgress`); the bubble fades/minimises as before. (The `app/agent-preview-*.mjs` and
`app/chat-bubble-layout.mjs` files are the Agent PC preview bubbles, a different feature.)

## 0.9.0 (a live office before the layer)

`_agent_chat_payload` -> per agent:
- OpenClaw: `get_agent_messages()` read the agent's newest session transcript straight from OpenClaw's state folder
  (`<homePath>/agents/<id>/sessions/sessions.json` + `<uuid>.jsonl` + `.trajectory.jsonl`): the incoming message
  (role user, with the sender for agent-to-agent turns), each assistant step (its tool calls as lines such as
  "gear exec ...", "page reading file"), thinking-only steps (dots), the final answer. Whatever channel started the
  session (Telegram, webchat, cron) it was there, because the files are the gateway's own.
- Hermes / Codex / Claude Code: the office's own provider history (`get_provider_agent_messages`).
- Communication events (agent-to-agent) merged in.

## 0.12 with the layer on (VO_PROVIDER_LAYER=1, the default)

Same `/agent-chat` code, but:
1. OpenClaw 2026.11 keeps sessions in SQLite: `agents/<id>/sessions/sessions.json` and live `<uuid>.jsonl`
   transcripts are gone (only migration archives remain). `get_agent_messages()` finds nothing for every OpenClaw agent,
   so their bubbles show only old communication events.
2. OpenClaw and Hermes chats run in the layer (Node). The office's own provider history no longer gets the turns of the
   chat window either, so Hermes (serve) bubbles show only what still reaches that history.
3. The layer's bus (read by `provider_layer_life.py`) carries `run.start / run.delta / tool.start / tool.end /
   run.end` only for runs the layer follows: the office's own chat runs, and "foreign" runs in sessions a chat page has
   open (`watch`). For every other session it carries only `agent.activity` (working or not, which session keys), so a
   run started on Telegram, the CLI or a schedule never shows its words, tools or answer anywhere in the office.
4. Nothing turns those bus events into bubble messages: presence (desk ring, task line) uses them, the bubbles do not.

## With the layer off (VO_PROVIDER_LAYER=0)

The 0.10 Python paths: same as 0.9 for Hermes/Codex/Claude Code; OpenClaw still reads the transcript files, which an
OpenClaw 2026.11 gateway no longer writes (gap 1 applies there too).

## The fix (v0.12, layer on)

- The layer follows every session its provider says is working (`agent.activity` keys), whatever started it:
  `server/chat/chat.js` `followFloor()` watches it like an open chat page does (10 min lease renewed while it works, let
  go 20 s after it stops unless a page has it open). Its runs come onto the bus as `run.start` with `outside: true`, then
  `run.input` (the person's message, read from the session's history), `run.delta`, `tool.start` / `tool.end`,
  `run.end`. The office's own runs carry `input` on `run.start`.
  - OpenClaw: a followed run gets its steps' items but not their results (`translate.js` `itemEnds`); steps taken before
    the follow began are filled in from `chat.history` (`stepsSoFar`).
  - Hermes: a floor watch may start following a turn already going on (`midway`).
- The office: `app/layer_bubbles.py` keeps the last runs of each agent (10 per agent, text capped) and shapes them as the
  0.9 transcript reader did; `_agent_chat_payload` merges them (same words from another source are dropped), for the
  agent's newest session only. `provider_layer_life.py` feeds it from the bus tap it already had.
- Outside runs are not the office's own: presence keeps them from `agent.activity` only (no double run), and Office Life
  does not count their sessions as office sessions (visitors, alarm clocks and journal rows stay).
- game.js: an agent first seen with no messages (a layer agent after the office starts) opens its bubble on its first
  message instead of keeping it minimised.

Tests: `tests/e2e/pl_bubbles.mjs` (real Chrome, lab OpenClaw + lab Hermes), `tests/test_v12_bubbles.py`.
Not covered: with the layer OFF and an OpenClaw 2026.11 gateway, OpenClaw bubbles stay empty (the legacy path still
reads transcript files, which 2026.11 no longer writes). After an office restart a layer agent's bubble is empty until
its next run (the store is in memory; 0.9 re-read the transcript).
