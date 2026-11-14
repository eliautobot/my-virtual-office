# My Virtual Office v0.9.0: Office Life

Version 0.9.0 makes the office react to the real work your agents do. Agents that need you walk
to the front desk with a sign, helper agents show up as interns, messages from outside channels
arrive with a courier, the team holds a morning stand-up, and a newspaper sums up the day.

**It uses no AI and costs no tokens.** Office life never calls a model, starts a run or sends a
prompt. Every sign, stand-up line and headline is filled in from data the office already has
(runs, tool events, approvals, tasks, projects, scheduled jobs, messages, XP). The tests count
model calls before and after to prove it.

Full guide: [Office Life](OFFICE-LIFE.md).

## Highlights

- **Needs you.** An agent blocked on an approval or a question walks to the front desk and holds
  up a sign: "Needs your OK", "Has a question" or "Needs you". Click it and the agent's chat opens
  on that exact card. The sign clears the moment you answer, wherever you answer (the office,
  Hermes, the OpenClaw UI, Telegram). Agents off screen get a badge at the edge of the office.
- **Interns and handoffs.** Helper agents (Hermes subagents and delegations, OpenClaw subagents)
  show up as interns with a lanyard, sit at a free desk while they run and leave when done. Work
  sent from one agent to another travels as a folder, flown or walked over.
- **Visitors and alarm clocks.** A message from Telegram, Discord, Slack, WhatsApp, SMS, email and
  other outside channels arrives as a courier who drops an envelope on the agent's desk. A
  scheduled job rings an alarm clock on the desk.
- **Moods.** Focused (headphones on a long run), stuck (3 failed runs in a row), relieved (a long
  job done), asleep (offline) and waiting (needs you), all from real run outcomes.
- **Celebrations.** "+N XP" pops with confetti, high-fives from a nearby agent, a "Project done!"
  pennant and a cake in the kitchen for a finished project.
- **Morning stand-up.** At a set time (09:30 Monday to Friday by default) agents gather at the
  meeting table and each says one line about what it did since the last stand-up. Each stand-up is
  saved to Meetings history.
- **Seasons and occasions.** Seasonal decor that follows your weather location's hemisphere,
  five holidays you can switch off one by one, up to 12 dates of your own, donuts on Fridays,
  umbrellas on rainy days, and office birthdays when a provider records an agent's creation date.
- **Break-time tournaments.** Agents idle for 10 minutes play ping pong or darts brackets on your
  tables. Click a player to cheer (every tab sees the hearts). Wins add trophies on the
  leaderboard, never XP. Real work always wins: a player who gets work forfeits.
- **The Daily Office.** At 18:00 by default the office prints a front page: headline, a column per
  agent, the MVP of the day and stats. Open it from **More > Daily Office**, browse past days, or
  **Replay the day** with a time slider at 60x or 300x.
- **Settings > Office life.** A switch for every feature, a master switch, a **Calm mode** (signs and
  icons only: nobody walks around, no confetti, no tournaments), stand-up days and time, newspaper
  time, seasons and holidays, your own occasions, tournament frequency, the office time zone and
  how long to keep the history. Changes reach every open tab without a reload.
- **Two new furniture items** in the office editor: a **Front Desk** and a **Notice Board**. Both are
  optional; offices without them get sensible spots automatically.

## Works with every provider, honestly

Each feature fires only from a real signal; a provider that cannot report something never
triggers it, and nothing is faked.

- **Hermes, full connection (`hermes serve`):** needs you (approval and question cards, plus
  "waiting" from any Hermes client), interns, visitors, alarm clocks, moods.
- **Hermes, legacy connection:** needs you for approvals and moods, for runs started in the office.
- **OpenClaw:** everything: approvals and questions, subagents, `sessions_send` handoffs, outside
  channels, cron jobs, moods. The office connects to the gateway at start, so this works even with
  no chat window open.
- **Codex, Claude Code, OpenCode, Antigravity, built-in:** moods and run counts for runs the
  office starts, and approvals where the run reports them (Codex does).
- **Everyone:** tasks done, XP, projects completed, agent-to-agent messages, task reassignment,
  the stand-up, the newspaper, tournaments and seasons.

## Privacy

No message text, command, question, goal or session title is ever drawn on the office, kept in the
Office life journal or printed in the newspaper. Visitor labels say only the channel ("Message
from Telegram"), never who wrote.

## Performance

Measured on an idle desktop page (1600x900) for 10 minutes with Office life on and 10 minutes off,
in alternating blocks:

- Page CPU: 0.1323 on vs 0.1336 off (1.0 % lower).
- Time per drawn frame: 3.59 ms on vs 3.42 ms off (+4.8 %, the decor and labels).
- Frames: 36.9 vs 39.0 draws per second; frame interval 16.7 ms (p50 and p95) in both.
- Server CPU: 0.24 % vs 0.23 % of one core.
- No new periodic requests: Office life uses one event stream that the page keeps open. Hidden
  tabs close it after a minute.
- The journal is bounded: 4,000 lines or 1.5 MB a day, 40 MB in total, 14 days by default.

## Bugs fixed along the way

- **OpenClaw tool activity now reaches the activity chips and Agent PC.** Live OpenClaw sends the
  tool name and arguments in a nested shape the office did not read, so chips said "Working" and
  Agent PC saw no OpenClaw tools. Both now show the real tool ("Searching: ...").
- **Hermes agents on the full connection are no longer shown offline when this machine has no
  Hermes CLI** (the usual Docker install). Their status now comes from their own connection;
  legacy Hermes agents still use the CLI check.
- **Phones: labels stay in the visible office.** Activity chips, chat bubbles and the new Office
  life signs and badges no longer hide under the dashboard sheet, the action bar or an open chat
  panel, so a tap reaches them.
- **Interns never take an agent's seat.** Desks of agents placed automatically (a little off the
  desk item) now count as taken.
- **One count per OpenClaw tool call.** A tool reported by two kinds of gateway messages is
  counted once in the day's stats.
- **One "done" per OpenClaw cron run.** A cron run reported both by the cron feed and as a task no
  longer finishes twice.
- **A finished project credits only the agents who finished its tasks**, not every assignee.
- **A run that ended in an unknown way is not counted as a failure**, so it can never make an
  agent look stuck or add errors to the stand-up.

## Known limits

- **Codex, Claude Code, OpenCode and Antigravity:** only runs the office starts are seen; work done
  in their own apps or terminals does not count. They have no interns, visitors or alarm clocks.
- **OpenClaw questions after a server restart:** open approvals are read back from the gateway, but
  open questions cannot be (the gateway has no way to list them). Such a question shows a sign
  again only if the gateway sends it again.
- **Very short helpers:** a helper agent that finishes in under a second does not show an intern.
- **Birthdays:** only for agents whose provider records a creation date. Most OpenClaw and Hermes
  agents do not, so they get none.
- **Seasons** need a weather location (Settings > General); offices in the tropics get holidays but
  no seasonal decor.
- **Time zone:** with no zone in Settings and no `VO_TIMEZONE`/`TZ`, the office starts on UTC; the
  first browser that can save settings adopts its own zone once and says so. Check **Settings >
  Office life** if your stand-up runs at the wrong hour.
- **Hermes visitors and alarm clocks** are tested with recorded Hermes sessions; a live Telegram or
  scheduled Hermes turn was not available in testing.

## Upgrading

Nothing to do: Office life is on with sensible defaults, and your saved settings and layouts stay
as they are. To turn it off, open **Settings > Office life** and switch off **Show office life**
(the history is kept), or pick **Calm mode** for signs and icons without movement. The journal
lives in `/data/office-life/` in the same `vo-data` volume as the rest of your office.

## For developers

- Server package `app/office_life/`, client scripts `app/office-life/`, routes under
  `/api/office-life/` (state, stream, journal, days, paper, settings, stand-up and paper "now",
  cheer). See [Office Life](OFFICE-LIFE.md#routes-for-developers).
- New tests: `tests/test_life_*.py` and `tests/test_life_*.mjs` run in `tests/run_all.sh`. A
  private end-to-end stack (`tests/tools/life-e2e.sh`, a fake OpenClaw gateway and a lab Hermes on
  loopback) drives `tests/test_life_e2e.py`, the page checks and the performance gate.
