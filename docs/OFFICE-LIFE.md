# Office Life

Office life makes the office react to the real work your agents do. An agent waiting for your OK
walks to the front desk with a sign, helper agents show up as interns, messages from Telegram or
email arrive with a courier, a scheduled job rings an alarm clock, finished tasks pop "+15 XP",
the team holds a morning stand-up, and a "Daily Office" newspaper sums up the day.

**No AI, no tokens.** Nothing in Office life calls a model, starts a run, sends a prompt or writes
to a provider. Every line you see (stand-up lines, the newspaper, signs, notices) is filled in from
data the office already has: runs, tool events, approvals, sessions, tasks, projects, scheduled
jobs, messages and XP. Office life never costs you API credits.

Everything can be switched off in **Settings > Office life**, one feature at a time or all at once.

## Contents

- [The features](#the-features)
- [Which providers trigger what](#which-providers-trigger-what)
- [Privacy](#privacy)
- [Settings > Office life](#settings--office-life)
- [Calm mode and reduced motion](#calm-mode-and-reduced-motion)
- [Front desk, notice board and fallbacks](#front-desk-notice-board-and-fallbacks)
- [The journal](#the-journal)
- [Routes (for developers)](#routes-for-developers)
- [Tests](#tests)

## The features

### Needs you

When an agent is blocked on an approval or a question, it stands up, walks to the front of the
office and holds up a sign: **Needs your OK**, **Has a question** or **Needs you** (a number shows
when it waits on more than one thing). Click the sign, the card it holds or the agent itself and
its chat opens on the right approval or question card.

- The sign clears the moment the request is answered anywhere: in the office, in Hermes or the
  OpenClaw UI, on Telegram, and so on. An answered sign flips to a check mark before the agent
  walks back.
- Up to 5 agents queue at the front; more wait at their desks with the sign.
- An agent that is off screen gets a small badge at the edge of the office ("Ada needs your OK",
  at most 3, then "+N more"). Clicking it moves the camera to the agent and opens the chat. Screen
  readers hear one short announcement per new request.
- The chips above the agent are hidden while the sign is up (the sign says it), so the sign never
  covers them.
- If the agent goes offline or its provider disconnects, the sign goes away.

### Interns and handoffs

**Interns.** When an agent starts helper agents (Hermes subagents and delegations, OpenClaw
`sessions_spawn` and subagents), each helper appears as a temporary intern with a lanyard and an
"INTERN" badge. It walks in from the front, sits at the free desk nearest its parent agent (desks
in the parent's room first), else stands in a ring round the parent's desk (spread out, never on a
seat or in a doorway), else takes a lounge seat, else waits near the front. It types while the
helper runs, then waves and leaves. Helpers already running when the page opens are seated at once.
Hover shows "Helper for Ada". Clicking an intern opens the parent agent's chat on the Tasks side
panel.

- Every running helper gets its own intern. The parent's name tag shows how many run ("5 helpers").
- Only an office-wide safety cap is left: "Most interns in the office" in Settings (24 by default,
  1 to 48). Past it every agent keeps a fair share and its tag says so ("30 helpers · 24 shown").
- With many interns round one desk, an INTERN badge that would cover another one is left out.
- Interns are drawings only: they are never in the roster, menus, meetings or licence counts, and
  they never take an agent's own desk.
- A helper that finishes in under a second does not show up (the count settles for 1 second first).

**Handoffs.** When one office agent sends work to another, the work travels as a folder: a paper
airplane carrying a folder flies desk to desk while the sender is busy, or the sender walks the
folder over, hands it off and walks back when it is free. The receiver never leaves its desk.
Handoffs come from OpenClaw `sessions_send` / `sessions_spawn` to another office agent and
messages between agents' sessions, from agent-to-agent (A2A) messages sent through the office, and
from a task reassigned by an agent (a reassignment by you is not a handoff). At most 3 folder
planes fly at once.

### Visitors and alarm clocks

**Visitors.** A message that reaches an agent from an outside channel arrives as a courier with a
cap and satchel who walks to the agent's desk, knocks and drops an envelope tinted with the
channel's colour. The envelope stays on the desk (up to 3 per desk) until you open that agent's
chat or 10 minutes pass. Hover shows only "Message from Telegram": never the sender, never the text.
Clicking the courier or the envelope opens the chat on that conversation.

Outside channels: Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, iMessage, Matrix,
Mattermost, Teams, Google Chat, LINE, Feishu, WeChat, IRC, Twitch, Nostr, X, Voice, Webhook and
Home Assistant. Chats from the office itself, a terminal, a desktop app, a dashboard, an API call,
a scheduled job or a heartbeat are not visitors. At most 2 couriers walk at once; extra visitors
just get the envelope.

**Alarm clocks.** When a scheduled job starts for an agent, an alarm clock on its desk rings for
2.5 seconds and an idle agent taps it. The small clock stays on the desk while the job runs (up to
15 minutes). Hover shows "Scheduled job: Morning digest" (the job's name, clipped). A job that does
not name its agent is skipped, never guessed.

### Moods

Body language from real run outcomes, worked out on the server so every open tab agrees:

| Mood | When | What you see |
|---|---|---|
| Focused | one run has been going for 15 minutes or more | headphones, leaning in to type |
| Stuck | 3 failed runs in a row within an hour (runs you cancel or stop do not count) | hand on head now and then, a small grey cloud |
| Relieved | an OK run that took 5 minutes or more | a stretch and a "phew" (8 seconds) |
| Asleep | the agent is offline | the agent in grey at its desk with a pixel "Zzz" |
| Waiting | a needs-you request is open | an hourglass icon |

The mood icon sits left of the agent's name tag. "Stuck" clears with the next OK run (a "Back on
track" celebration) or fades after 4 hours without a new failure. With moods on, the
stretch-after-a-long-run comes from the real "relieved" mood instead of chance.

The focused headphones rest on whatever is highest on the head, in every view: the hair (an afro, a bun
or a mohawk lifts the band; a buzz cut lowers it), or a cap, beanie, headband, goggles or tiara (the band
goes over it). They are not drawn with a hard hat, crown, Santa hat, witch hat, sun hat or headset, nor
with a full costume; the mood icon by the name tag still shows. The band moves with the head when the
agent dozes or looks down at a phone.

### Celebrations

- **Task done** and **XP**: "+N XP" rises above the agent with a small confetti burst (a task and
  its XP within 2 seconds show as one pop). A nearby idle agent may walk over for a high-five.
- **Project done**: a "Project done!" pennant over the agents who finished its tasks, and a cake in
  the kitchen until midnight office time. Idle agents may go for a slice on a food break (once per
  agent per day).
- **Back on track**: the agent's signature move (below) when its first OK run follows a stuck spell.
- **Signature move**: every celebration above also plays the agent's own victory move: fist pump, chair spin,
  little dance, bow, air guitar, salute, jump or slow clap (each under 2.5 seconds, standing or in the chair).
  Pick it in Agent Studio > Moves (the Play move button on the stage previews it); "Auto" picks one from the
  agent's id, the same in every browser. It never plays on its own, and not with Office Life or celebrations off.
  Calm mode or reduced motion: a still pose instead.
- At most one celebration per agent every 20 seconds (XP merges into it).

**Waves.** Click an agent and it waves back: standing or idle, it turns to you and waves; walking, a
quick wave on the move; working at a desk with its back to you or in profile, it turns in the chair, gives a
small wave and goes back to work; dozing or offline, it just stirs. The agent menu's **Wave** is the bigger
wave, with a small hand icon over the head (only the icon when its hands are busy). A wave never changes
what the agent is doing, plays at most once per agent every 1.2 seconds, only in the browser you click in,
and follows the Click reactions switch (not in edit mode). Calm mode or reduced motion: the hand icon and a
still raised hand.

### Daily stand-up

At the stand-up time (default 09:30, Monday to Friday, office time) the agents gather at the meeting
table. It is named by the office time it starts at: Morning (05:00 to 11:59), Afternoon (12:00 to 16:59),
Evening (17:00 to 21:59) or Night stand-up. Each one says one line about what it did since the last stand-up, built from the journal:

- "Finished 2 tasks: Fix login, Update docs"
- "Wrapped up project Launch"
- "Handed 2 jobs to Ops" / "Picked up 1 job from Ada"
- "Handled 3 messages from Telegram and Email"
- "Ran 4 scheduled jobs"
- "Worked through 12 runs, mostly in the terminal"
- "Hit 2 errors, all sorted" / "Hit 1 error, still on it"
- "Quiet since the last stand-up"

The two strongest facts are joined when the line stays short. Agents that are working or in a real
meeting take part remotely: their line shows above their desk with a phone icon. Offline agents are
left out; with nobody around the stand-up is skipped. Each stand-up is saved once to **Meetings >
History** (kind "standup", one response per agent) and ends 90 seconds after it starts, even across
a server restart. A tab that missed it live shows a short note, "Stand-up notes are in Meetings". On phones the
lines play in one caption bar under the top bar. **Run stand-up now** in Settings starts one at once.

### Seasons and occasions

Decor drawn into the cached office layer (no cost per frame), based on the office date:

- **Seasons** follow the hemisphere of your weather location: blossoms on plants in spring, a fan
  and sun glints by the windows in summer, orange leaves on the plants in autumn, snow on the window sills and a
  coat rack in winter. No weather location, or a location in the tropics: no seasonal decor.
- **Holidays** (each can be switched off): New Year (Dec 31 and Jan 1), Valentine's Day (Feb 14),
  Earth Day (Apr 22), Halloween (Oct 31), Year-end lights (Dec 15 to 31). A holiday also gets a
  banner over the notice board (on the top wall when there is none), after birthdays and your own
  occasions. Halloween pumpkins sit either side of the front, their candles glowing at night.
- **Your own occasions**: up to 12 yearly dates with a name and an icon (star, cake, heart, balloon
  or flag) bring balloons to the front and a banner on the notice board.
- **Friday treat**: a box of donuts in the kitchen on Fridays from 08:00 to 17:00 office time.
- **Rainy days**: umbrellas by the door when the weather feed says rain (one per agent present, up
  to 6); a boot mat when it snows.
- **Agent birthdays**: a party hat and a cake on the yearly anniversary of the day an agent was
  created, only when its provider recorded that date. Most OpenClaw and Hermes agents do not
  record one, so they get no birthday (nothing is made up).

### Break-time tournaments

When at least 2 agents have been idle for 10 minutes and the layout has a ping pong table or a dart
board, they may play a small bracket (2 to 4 players): ping pong to 3 points or darts best of 3
rounds, about 40 seconds a match. The server picks the players and decides every result fairly
(50/50) in advance, so every tab sees the same game.

- Real work always wins: a player who starts working or needs you forfeits ("won by walkover").
- The bracket and the champion (with a trophy, for the rest of the day) show on the notice board.
  Without a notice board the champion gets a toast.
- Click a player during its match to cheer: hearts appear above it in every open tab. Cheering is
  just for fun.
- Wins add trophies on the Projects leaderboard. They never add XP.
- Tournaments only start inside their window: once a day between 12:00 and 17:00, or twice
  (11:00 to 13:00 and 15:00 to 17:00), office time. Never in Calm mode.

### The Daily Office newspaper and replay

At the newspaper time (default 18:00 office time) the office prints **The Daily Office**: a
headline from the biggest fact of the day (a finished project, tasks done, a tournament champion,
messages handled, runs, or "A quiet day at the office"), one column per agent, an MVP of the day,
and stats (busiest hour, longest run, runs and errors, requests answered with the median wait,
messages by channel, scheduled jobs, handoffs, cakes, champion).

MVP points: 5 per task, 20 per project, 2 per handoff sent, 1 per message handled, 1 per OK run.

A rolled newspaper appears on the front desk and each browser gets one toast a day, "The Daily
Office is out". Open it from **More > Daily Office** or by clicking the newspaper. The window has
an archive of past days and, before today's paper is out, a "Preview so far". If the server was
down at print time, the paper is printed when it starts again the same day.

**Replay the day** (More menu) opens a bar under the office with a time slider, play and pause, and
two speeds (60x and 300x). Agents move to where they were (desk, lounge, front desk, asleep) and
the short visuals of that minute play again (handoffs, visitors, alarm clocks, celebrations). Live
scripts pause meanwhile; needs-you badges stay live. Press Esc or the close button to go back.
Replay never writes anything.

## Which providers trigger what

Each feature fires only from a real signal. A provider that cannot report something simply never
triggers that feature; nothing is guessed or faked.

| Feature | Hermes (full connection, `hermes serve`) | Hermes legacy (API server) | OpenClaw | Codex, Claude Code, OpenCode, Antigravity, built-in |
|---|---|---|---|---|
| Needs you | approval and question cards, plus "waiting" from any Hermes client (Telegram, desktop, dashboard) | approvals of runs started in the office | exec, plugin and session approvals, questions | approvals a run reports to the office (Codex does); none for the others |
| Interns | subagents and delegations | no | subagents and `sessions_spawn` | no |
| Handoffs | A2A messages and task reassignment only | A2A and tasks | `sessions_send` / `sessions_spawn` to another office agent, inter-session messages, A2A, tasks | A2A and tasks |
| Visitors | turns started from an outside platform | no | messages from outside channels | no (SMS: see below) |
| Alarm clocks | scheduled (cron) turns | no | cron job start and finish | no |
| Moods, run counts | yes | yes, for runs started in the office | yes | yes, for runs started in the office |
| Celebrations, stand-up, newspaper, tournaments, seasons | yes | yes | yes | yes |

Notes and honest gaps:

- **Office-wide signals work for everyone**: tasks moved to Done, XP, projects completed, A2A
  messages, task reassignment, idle time for tournaments and the date for seasons.
- **SMS panel**: when the SMS panel has an owner agent, incoming texts in its log arrive as SMS
  visitors for that agent, whatever its provider.
- **Runs outside the office**: for Codex, Claude Code, OpenCode and Antigravity the office only sees
  runs it started itself. Work done in their own apps or terminals does not count.
- **OpenClaw questions after a restart**: open approvals are read back from the gateway when the
  office server starts, but open questions are not (the gateway has no way to list them). A
  question that was waiting during a restart shows a sign again only if the gateway sends it again.
- **OpenClaw needs no open chat page**: the office connects to the gateway at start when Office life
  is on, so signs, interns and alarm clocks appear even with no chat window open.
- **Hermes visitors and alarm clocks** come from Hermes sessions that a platform or a schedule
  started; they are covered by recorded-fixture tests, not by a live Telegram or cron run.
- **Agents beyond the demo limit** get no Office life events (only the visible roster takes part).

## Privacy

- No message text, command, question, goal or session title is ever drawn on the canvas, written
  to the journal or printed in the newspaper.
- Labels show the channel name only ("Message from Telegram"), never who wrote.
- The journal keeps event types, agent ids, channel names, tool kinds, counts, durations, scheduled
  job names, and project and task titles (the same titles the Projects page already shows). It
  never stores chat session keys or card ids, which can contain a sender's id.

## Settings > Office life

Office life has its own **Settings > Office life** tab with its own **Save Office life** button
(it saves only what you changed). Changes reach every open tab at once, no reload needed. Only the
office owner can save (on a passcode-protected office: sign in with the passcode; agents' API
tokens cannot change it).

| Option | Default | What it does |
|---|---|---|
| Show office life | on | Master switch. Off hides every part and stops all of it on the server. The history is kept. |
| Calm mode | off | Signs and icons only: nobody walks around, no confetti, no tournaments. See below. |
| Needs you | on | Signs at the front desk for approvals and questions. |
| Interns | on | Helper agents show up as interns. |
| Most interns in the office | 24 | 1 to 48. One intern per running helper up to this number (24 keeps a phone smooth). |
| Handoffs | on | Folders carried or flown between agents. |
| Visitors | on | Couriers and envelopes for outside messages. |
| Alarm clocks | on | Desk alarm clocks for scheduled jobs. |
| Moods | on | Focused, stuck, relieved, asleep, waiting. |
| Celebrations | on | XP pops, confetti, high-fives, pennants and cake. |
| Daily stand-up | on | Time (default 09:30, 24-hour) and days (Mon to Fri). No days picked = it never runs on its own. **Run stand-up now** starts one at once. |
| Seasons and occasions | on | Sub-switches: seasonal decor, Friday treat, rainy days, agent birthdays, each of the 5 holidays, and up to 12 occasions of your own (name up to 24 characters, month-day, icon). |
| Break-time tournaments | on | How often: once a day (12:00 to 17:00), twice a day (11:00 to 13:00 and 15:00 to 17:00), or off. |
| Daily Office newspaper | on | Printed at (default 18:00). **Print today's paper now** prints it at once. The More menu items "Daily Office" and "Replay the day" follow this switch. |
| Click reactions | on | Clicking a piece of furniture plays its small reaction: a lamp switches on or off, the TV changes channel, the vending machine drops a can, and more. Purely visual, only in the browser you click in, never saved or shared. With Calm mode or reduced motion the piece just changes state, nothing shakes. Not in edit mode. |
| Office time zone | server default | The zone the stand-up, the newspaper, tournaments, seasons and the office day use. |
| Keep the day-by-day history for | 14 days | 1 to 60 days of journal. |

**Time zone.** The office zone is the one you pick here; otherwise `VO_TIMEZONE` or `TZ` from the
environment when it names a real zone; otherwise UTC. While the office is still on UTC with nothing
set, the first browser that can save settings and opens the office adopts its own zone once and
says so in a toast ("Office time zone set to Europe/Berlin (this browser)"). A browser on a
different zone later does not change it; Settings shows "This browser is on Asia/Tokyo. Times here
use the office zone, Europe/Berlin." with a button to switch.

Settings are stored in `vo-config.json` under `officeLife`. The setup wizard's save does not touch
them; they are validated in one place (unknown keys dropped, times must be `HH:MM`, days 1 to 7,
zones from the system list, at most 12 occasions).

## Calm mode and reduced motion

Calm mode, and browsers set to reduce motion, keep everything informative and drop the movement:

- Needs-you signs are held up beside the agent's chair instead of at the front.
- Interns fade in and out at their seat; visitors leave only the envelope; handoffs skip the walk.
- XP text fades in place; no confetti, shaking or bouncing; no high-five walks.
- Stand-up lines show above the agents' desks.
- Mood icons, alarm clocks, the cake and all decor stay.
- Calm mode also stops tournaments on the server. With reduced motion only, a tournament still runs
  on the notice board but nobody walks to the table.

## Front desk, notice board and fallbacks

Two new items are in the office editor's furniture palette:

- **Front Desk**: the "front of the office". Needs-you queues, arriving interns and couriers,
  rain umbrellas and the newspaper use the spot in front of it.
- **Notice Board**: a cork board for walls. It carries the tournament bracket and champion,
  occasion and birthday banners.

You do not need them. Without a front desk the office uses the walkable floor nearest the bottom
centre of the office, then the office centre. Without a notice board a whiteboard is used; with
neither, the bracket still plays and the champion is announced with a toast. The cake and donuts
go on the kitchen counter, else next to a coffee maker or vending machine; with none of those they
are skipped. Saved layouts without the new items stay valid.

## The journal

Office life keeps a small day-by-day journal on the server, in the data volume:

```
/data/office-life/
  journal/YYYY-MM-DD.jsonl         one short line per event
  journal/YYYY-MM-DD.summary.json  per-agent counters for the stand-up and the newspaper
  papers/YYYY-MM-DD.json           printed newspapers
  state.json                       last stand-up, last paper, open stand-up or tournament
```

- A day is the office-local date, so daylight saving never splits a day.
- Size caps: 4,000 lines or 1.5 MB per day. Past that only the important kinds are kept (needs,
  tasks, projects, stand-ups, tournament results, papers, state changes), up to twice the cap; the
  rest is counted as dropped. The whole folder is capped at 40 MB (oldest days go first).
- Retention: 14 days by default (1 to 60 in Settings), pruned at the day change and at start.
- Lines are only ever appended. A half-written last line after a crash is skipped when read.
- Turning Office life off keeps the journal.

## Routes (for developers)

All routes sit behind the office's normal checks (host check, same-origin for writes, the office
passcode when set). Saving settings and the two "now" buttons also need the office owner (a signed
in browser or this machine, never an agent API token).

| Route | Purpose |
|---|---|
| `GET /api/office-life/state` | settings, office day and zone, open needs, interns, moods, stand-up, tournament, today's birthdays, cake and champion, paper status; the page reads it first |
| `GET /api/office-life/stream` | server-sent events, resumes with `Last-Event-ID` or `?since=`; heartbeat on the open stream (no polling) |
| `GET /api/office-life/journal?day=&after=&kinds=&limit=` | journal rows for the replay, at most 2,000 per page with a `next` cursor; the day must be within retention |
| `GET /api/office-life/days` | days on disk, with `paper` and `standup` flags |
| `GET /api/office-life/paper?day=[&preview=1]` | a printed paper; `preview=1` builds today's so far without saving it |
| `POST /api/office-life/settings` | validate and save the changed keys, then tell every tab |
| `POST /api/office-life/standup/now` | start a stand-up now (409 when switched off or one is going on) |
| `POST /api/office-life/paper/now` | print today's paper now (409 when switched off) |
| `POST /api/office-life/cheer` `{tournament, match, agent}` | one cheer; at most 1 per second per client and 30 per match |
| `POST /api/office-life/test-event` | tests only: answers 404 unless the server runs with `VO_LIFE_TEST_INJECT=1` and the caller is on loopback |

Code: server package `app/office_life/` (settings, events, bus, journal, sources, hooks,
scheduler, builders, templates, tournament, routes) and client scripts `app/office-life/` (life.js
bootstrap and stream, director.js, sprites.js, one file per feature, settings.js, life.css,
paper.css). The page talks to the canvas through `window.VOLifeHost` in `game.js`.

## Tests

Unit and fixture tests run with the normal suite (`tests/run_all.sh`):

- Python: `test_life_core.py`, `test_life_sources.py` (Hermes and OpenClaw fixture frames),
  `test_life_scheduler.py` (moods, stand-up and paper times), `test_life_builders.py` (lines,
  headline, MVP), `test_life_fix_server.py`, `test_presence_lifecycle.py`.
- Node: `test_life_director.mjs`, `test_life_needs_crew.mjs`, `test_life_moods_party.mjs`,
  `test_life_gatherings.mjs`, `test_life_decor_paper.mjs`, `test_life_settings.mjs`,
  `test_life_canvas.mjs`. The browser ones need `playwright-core` and Chrome and skip cleanly
  without them.
- Signature moves and waves: `test_v12_moves.mjs` (work animations, moves, waves),
  `test_v12_moves_studio.mjs` (Studio > Moves, saved and reloaded), `test_v12_moves_save.py`.

**End to end on a private stack.** `tests/tools/life-e2e.sh start|stop|status|restart-server`
starts a private office server from this tree on loopback with the test injector, a temporary
home and data folder, a fake OpenClaw gateway and a private lab Hermes with a stub model. It never
points at a real office, gateway or Hermes. Then:

```bash
tests/tools/life-e2e.sh start
LIFE_E2E=1 python3 -m pytest -q tests/test_life_e2e.py
node tests/e2e/life_page.mjs desktop    # also: phone, tabs, settings, tz, paper
node tests/e2e/life_perf.mjs            # 10 min ON vs 10 min OFF performance gate
tests/tools/life-e2e.sh stop
```

`tests/test_life_e2e.py` is skipped unless `LIFE_E2E=1` and the stack answers, so the normal suite
never needs it. The checks also count model calls on the stub and inference methods on the fake
gateway before and after, to prove Office life makes none.
