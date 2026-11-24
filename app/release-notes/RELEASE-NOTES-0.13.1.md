# My Virtual Office v0.13.1: Permissions, model and thinking

0.13.1 puts you in charge of what your Codex and Claude Code agents may do, right in their chat
window, like the native Codex and Claude apps: a **Permissions** button, a **model** picker and a
**thinking** picker next to the message box, kept per agent. It also fixes the 3D view: the paper
plane, signs on drawn walls, kitchen counters, the start of the 3D view and the game scoreboards.

**In short**

- **Permissions, per agent.** Codex: Ask first or Full access (and Read only where Codex's own
  sandbox can run). Claude Code: Read only, Plan only, Edit files or Full access. Full access asks
  you to confirm first.
- **New Codex agents ask first.** A Codex agent nobody has set starts at **Ask first**: it asks in
  the chat before it runs a command or changes files, and you approve or decline on the card.
- **Pick the model and how hard it thinks.** Codex lists its own models and the thinking levels
  each one offers; Claude Code offers Fable, Opus, Sonnet and Haiku with Low to Max.
- **Your choices stay.** They are saved in the data folder, survive updates, restarts and image
  rebuilds, and apply wherever the agent's work comes from: your chat, another agent, a project or
  a meeting.
- **3D fixes.** The office opens straight in 3D, counters look like cabinets on every connection,
  and the paper plane, wall signs and ping-pong and darts scoreboards stay in one piece.

## Before you upgrade

There are no breaking changes and no new settings to set. 0.13.1 reads and writes the same data
folder as 0.13.0; an upgrade is: back up, pull the new image (or source), restart (see
[Updating](UPDATING.md)).

- **Docker image.** `ghcr.io/eliautobot/my-virtual-office:latest` moves to 0.13.1. To pin this
  release use the tag `0.13.1` (or `0.13`). Built for x86_64 (amd64) and arm64, as before.
- **Codex now asks first by default.** Until 0.13.0 the shipped settings let Codex agents act
  without asking (`VO_CODEX_APPROVAL_POLICY=never`). The default is now `untrusted` (Ask first) in
  `docker-compose.yml`, `.env.example` and the office itself. If your own `.env` still has the old
  line `VO_CODEX_APPROVAL_POLICY=never` (copied from an older `.env.example`), your Codex agents
  keep starting at Full access: the button shows it, and one click changes it per agent. Change or
  remove that line to make Ask first the starting point for every agent.
- **Ask first and unattended work.** An agent on Ask first waits for your approval in its chat,
  also when a project or another agent gave it the work. Give an agent Full access if it must work
  on its own.
- **OpenClaw and Hermes are unchanged.** Their agents run in their own gateway, which keeps their
  permissions; they get no Permissions button.

## New features

### Agent permissions in the chat window ([in the README](https://github.com/eliautobot/my-virtual-office#agent-permissions))

Codex and Claude Code agents are the ones the office starts itself (their command-line programs),
so the office decides how much they may do on every run. You pick it per agent with the
**Permissions** button next to the message box:

| Agent | Modes | A new agent starts at |
|---|---|---|
| Codex | **Read only** (only where Codex's own sandbox can start; usually not inside Docker), **Ask first**, **Full access** | Ask first |
| Claude Code | **Read only**, **Plan only**, **Edit files**, **Full access** | Edit files |

- **Ask first** (Codex) asks on the approval card in the chat before any command or change it is
  not sure is safe; you approve or decline it there.
- **Full access** shows "Give this agent full access?" before it is set.
- **Only the office's owner** changes a mode: this machine, or a browser signed in with the office
  passcode. An agent cannot change its own or another agent's mode, not even with the agent API
  token.
- **The same mode everywhere.** The mode applies from the agent's next message, whether you wrote
  it, another agent sent it, or a project or meeting gave the agent the work.
- **Claude Code** runs without a way to ask you, so a step its mode does not allow is refused
  rather than asked about; its menu says so.
- **Where Codex's sandbox cannot start** (inside Docker without extra privileges), Read only is
  shown greyed out with the reason, and Ask first runs without the sandbox, asking before anything
  not known to be safe.

### Model and thinking pickers

- **Model.** Codex's list comes from Codex itself (its app-server), so new models appear on their
  own, with their names and descriptions. Claude Code offers Fable, Opus, Sonnet and Haiku (the
  latest of each).
- **Thinking.** The levels the chosen model offers: for Codex as Codex names them (for example Low
  to Max, and Ultra where the model has it), for Claude Code Low to Max (Claude Code versions
  without `--effort` show no thinking picker).
- **Default** keeps the agent's own model and the model's own level. Changing the model in the
  agent's settings (Agent Studio) replaces the one picked in the chat: the latest choice wins.
- In a narrow chat window the thinking and permission buttons show their icon only (💡 and ✋);
  their names are in the tooltip, and a wider or full-screen window shows them in full.

### Kept through updates

- Your choices live in `agent-permissions.json` in the data folder (private to the office, mode
  0600, owned like the folder). Updates, image rebuilds and restarts keep them, and a saved choice
  always wins over the office's settings: `VO_CODEX_APPROVAL_POLICY` and
  `VO_CLAUDE_CODE_PERMISSION_MODE` (and their fields in the Setup and Models pages, now named
  "Starting approval for new agents" and "Starting permission mode for new agents") only give the
  starting mode of an agent nobody has set yet.
- A damaged file is set aside (`agent-permissions.json.bad-<time>`), never silently replaced; a file
  the office cannot read is never overwritten (the change is refused and nothing is lost).
- Deleting an agent forgets its choices, so a new agent with the same name starts at the defaults.

## Fixes

### 3D

- **The office opens straight in 3D.** With Graphics resolving to 3D, the office no longer shows the
  classic view, then black, then a flat 3D view tilting in: it stays dark ("Loading the office..."
  after a moment) until the 3D view is ready, then opens at the 3D angle. Classic 2D and Auto
  without a graphics card start as before.
- **Counters look like cabinets on every connection.** Over a slower connection the 3D view could
  start before every model file had arrived, and furniture without its model yet kept a stand-in
  (a top on four legs: kitchen counters looked like tables). The 3D view now starts once every 3D
  file is in, and a stand-in is replaced as soon as its model arrives.
- **Kitchen counter rebuilt.** Drawers and doors with handles, shadow gaps, a recessed kick plate,
  a worktop with an edge and a tiled backsplash.
- **The paper plane keeps its shape.** It no longer stretches into streaks as it flies in the turned
  view; it flies rigid along its arc with its shadow on the floor.
- **Signs on drawn walls.** Custom text and branch signs placed on a wall you drew now hang on that
  wall in 3D instead of lying on the floor.
- **Ping-pong and darts scoreboards** stay in one piece above the table and on the dartboard's
  stand, instead of splitting into scrambled pieces.

### Chat

- **Work started by projects or other agents follows the agent's permissions.** Before, a Codex or
  Claude Code agent reached that way ran with the office-wide setting instead of its own.
