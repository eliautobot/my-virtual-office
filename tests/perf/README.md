# Perf harness

One command measures any Virtual Office tree and prints one short table (JSON result saved next to it):

    PLAYWRIGHT_CORE_PATH=... node tests/perf/run.mjs --app path/to/app [--label name] [--quick] [--minutes 10]

- Browser half (`client.mjs` + `office-server.mjs`): the tree's static files served from `--app` (ETag/304 and gzip
  like server.py) and a synthetic live-like office: 27 agents (13 OpenClaw, 6 Hermes, 4 Codex, 4 Claude Code), a
  `/status` that changes every poll when busy, `/agent-chat` (lite) with new messages, Office Life on and a real
  long-lived SSE stream. Desktop 1600x900 DPR 1 and phone 412x915 DPR 2 with a 4x CPU throttle. Measures first paint and
  interactive, long tasks, frame time p50/p95 (idle and busy), main-thread CPU (visible, hidden, busy), DOM nodes, a CPU
  profile with file:line, and (desktop, busy) JS heap, DOM and requests/bytes per minute by endpoint after `--minutes`.
  Every non-GET is refused and counted.
- Server half (`server-bench.mjs`): the tree's server.py on a private loopback port (default 18460, ws +1, fake gateway
  control 18462) with a throwaway HOME: 27 OpenClaw agents with session transcripts, the fake gateway from
  tests/test_life_e2e.py, Office Life on. Measures time and CPU per request, raw/gzip bytes, ETag/304, idle CPU, RSS
  and the CPU of one browser's polling mix.
- `--capture http://host:port` saves the office layout and Office Life state of a running office (read-only GETs) into
  `--fixtures` (default a temp folder) so the same real layout can be replayed against every tree. Agents, chat and
  status are always synthetic.
- `--quick` = 5 s samples and a 1 minute long run. `--no-client`, `--no-server`, `--no-long` skip parts.
- Limits: one Chrome at a time (closed in a finally), one private server (killed on any exit). Do not point it at a
  shared office.

`node tests/perf/check.mjs` (fast, no browser) holds the regression budgets.
