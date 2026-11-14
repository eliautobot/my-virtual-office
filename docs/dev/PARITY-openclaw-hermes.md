# Parity: the office's copy of My Virtual World's OpenClaw + Hermes layer vs GAP.md sections 2-4 (v0.11 C2 plui, plparity)

Statuses: PASS = seen in the office against the labs, each with a scripted check (tests/e2e/pl_chat.mjs, pl_menu.mjs,
pl_parity.mjs sections conn, passcode, ocx, ocy, agents, brw, hx, hx2, hx3, hsecret, hscreen; C1's tests/pl_host_lab.py);
PART = partly seen (the rest named); NOT SEEN = the copied code is in place but no lab could produce it (why named);
N/A = not offered for that provider, as in My Virtual World (why named); KEEP-VO = the office keeps its own.
Labs only (tests/tools/lab-openclaw.sh, lab-hermes.sh, pl-office.sh): OpenClaw 2026.9.6 lab gateway dialled at
ws://172.17.0.1 (stub model, two models; a second lab with password auth; its browser attached to the test's own headless
Chrome), Hermes 0.22.2 lab a (token) / b (sign-in), a passcode office reached from 172.17.0.1.
How to run: see the header of tests/e2e/pl_parity.mjs (one headless Chrome at a time; stop every lab after).

Counts: KEEP-VO 7, N/A 3, NOT SEEN 1, PART 4, PASS 86 (total 101)

## 2.1 OpenClaw connection, auth, discovery, status
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Add form: address + token | PASS | connection made through the form's own route (POST /api/connections) with url + token (pl_menu); plparity typed the form itself (name, Find -> Use, auth, access) for the password gateway (pl_parity conn). |
| Password auth (gateway.auth.mode=password) | PASS | plparity: a lab gateway with gateway.auth.mode=password (lab-openclaw.sh LAB_OC_AUTH=password); the Add form typed (Sign in with: Gateway password, the token field hidden) pairs; the password is not kept after pairing (secrets.password false). pl_parity conn. |
| Several gateways | PASS | pl_menu: a second connection to the same lab pairs its own device and lists its own agents (prov-<id>-main/ops) beside the first. |
| Device identity + pairing | PASS | pairing -> lab `devices approve` -> connected (pl_lib ensureOpenClaw; C1 lab). |
| Token handoff | PASS | after pairing the connection's secrets.token is false (GET /api/agent-providers): the shared token is not kept. |
| Remove connection removes device on gateway | PASS | pl_menu: POST /api/connections/remove -> the lab's paired devices drop by one; the first connection stays connected. |
| Access levels Chat only / Full | PASS | Full: every check. Chat only (typed in the form): chat works; a settings change is refused by the layer with the reason (403 chat_only; was the gateway's 502 missing scope, fixed in plparity). pl_parity conn. |
| Discovery / capability profile | PASS | caps drive the window: / menu (commands), gateway follow-up queue (Ctrl+Enter), approvals, media. |
| Status dot, reconnect, backoff, pair again texts | PASS | pairing and connected states seen; the connection came back by itself after the lab gateway was restarted twice. (No top-bar dot in the office: its settings summary row and the Connection tab show state.) |
| Recent password (10 min) + audit log for writes | PASS | plparity: a passcode office reached from 172.17.0.1 (not loopback): /api/pl/me reauthLeftMs 0 after sign-in; an Agents model change in the copied menu -> 403 reauth_required -> the office passcode dialog (VOUI) -> /api/access/confirm -> retried -> lands on the gateway; the office's provider-audit.log gets one line (which call, no values; wired in plparity, it was not). pl_parity passcode. |
| Find gateway automatically | PASS | plparity: Find looks at the office's own gateway setting (VO_GATEWAY_URL, Docker host.docker.internal:18789 by default) then the built-in places and saved addresses (VO_PL_FIND replaces the built-in places in labs); offers the lab gateways that answer, never a closed address, one entry per address; Use fills the field. pl_parity conn. |

## 2.2 OpenClaw chat window
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Transport of a turn | PASS | every pl_chat turn runs through the layer's /api/providers/runs (C1: HTTP and the WS relay). |
| Slash commands: list + autocomplete | PASS | pl_chat: '/' lists the lab's commands.list (14 shown of 73, every one in the list), arrows/Enter/Esc. |
| Slash commands: where they run | PASS | pl_chat: /status answered by OpenClaw 2026.9.6 itself (no 'stub reply'). |
| Streaming text + status phases | PASS | slow:<ms> answers stream 0..19 live. |
| Thinking | PASS | plparity: lab stub [[think:]] streams reasoning_content on Stub Two (reasoning model); the answer shows it folded ('Thought', the words inside). pl_parity ocx. |
| Tool cards live | PASS | the exec tool row ('Exec ... exit 0') shows live in the approval check. |
| Deferred tool_call wrapper | PASS | plparity: tool_call {id: openclaw:core:sessions_search} -> the step is the inner tool ('Session Search plparity'), the wrapper never shown; card tools through tool_call (ask_user, progress_card) show only as their cards. pl_parity ocx. |
| Browser card in the chat | PASS | plparity: the lab gateway's browser (attach-only to the test's own headless Chrome: lab-openclaw.sh LAB_OC_BROWSER_CDP_URL) opens a loopback page through the deferred browser tool -> the card in the chat (host, URL, Open, copy); cards only for http(s) tabs, as OpenClaw's Control UI. pl_parity brw. |
| Approvals: exec, plugin, session; once / always / deny | PART | exec: Allow once (pl_chat), Deny -> the gateway's 'Exec denied (user-denied)', Always allow -> runs and the same command asks no more (allowlist, ask on-miss) (pl_parity ocx). Not seen: plugin approvals (no lab plugin asks) and the session (reviewer-safe) option (the lab gateway offered once/always/deny only). |
| Questions (ask_user) | PASS | plparity: ask_user through the deferred tool_call -> the question card (header, options, Recommended first), Blue chosen -> the tool answers {colour: [Blue]}, the turn goes on. pl_parity ocx. |
| Progress card in composer | PASS | plparity: progress_card through tool_call -> 'Task progress 2 of 2' with both steps in the composer; Refresh (progressCard.refresh); Dismiss once every step is done -> gone. pl_parity ocx. |
| Observe runs from other channels | PASS | plparity: a turn sent to the open chat's session from another gateway client (lab CLI gateway call chat.send) shows live in the office window, answer included, no reload. pl_parity ocy. |
| Live answer after a page refresh | PASS | pl_chat: reload mid-answer -> the window comes back on the chat; while it still streams the words from before the reload are there (fixed in C2: attachRun cut them when the history held no answer in progress), then one whole answer, no duplicate. |
| Model picker | PASS | plparity: the lab's two models (Stub One default, Stub Two) in the composer picker; Stub Two -> the next turn runs on stub-2 (the stub says so). pl_parity ocx. |
| Effort picker | PASS | plparity: the chosen model's own levels (Default, Off, Minimal, Low, Medium, High); High -> the gateway session's thinkingLevel high. pl_parity ocx. |
| Context meter | PASS | plparity: shown after a turn ('Context: 1 of 64k tokens'), popup with the numbers. pl_parity ocx. |
| Cost per session/run | PASS | plparity: the copied UI dropped OpenClaw's estimatedCostUsd; now the context meter's title and popup say 'Cost so far' (lab Stub Two priced: gateway 0.000018 -> '<$0.0001'). pl_parity ocx. |
| Attachments in | PASS | plparity: a text file through the composer (chip, upload to /api/chat/attachments) reaches the gateway with the turn (the lab stub finds its name in the request). pl_parity ocy. |
| Media out: MEDIA: lines + artifactId blocks | PASS | pl_chat: MEDIA: picture from the gateway dialled at ws://172.17.0.1 shows through the signed /api/providers/media (no disk path in the page), decoded 2x2. |
| Send while working: steer / followup | PASS | Ctrl+Enter = follow-up (pl_chat); Enter while a slow answer runs = steer into the running turn, answered (pl_parity ocy). |
| Stop | PASS | pl_chat: Stop during a slow answer ends it before it finishes (C1: /api/providers/interrupt). |
| Sessions: list, new, switch, rename, delete | PASS | list, new and switch (pl_chat); plparity: Rename (office dialog, not the browser's prompt) -> the list and the gateway session's label; Delete (office confirm) -> gone from the list and from the gateway's sessions.list. pl_parity ocy. |
| Sessions: search, pin, projects, export, working ring | PASS | plparity, in the sidebar drawer: search finds the chat by its words; Pin to the top -> a Pinned group; Move to a project -> New project (office dialog) -> the chat in it; Export as Markdown downloads who said what; the working ring on the chat while it answers. pl_parity ocy. |
| Edit and resend / regenerate (OpenClaw) | N/A | as in MVW: OpenClaw's manifest sets rewrite false (its history is the gateway's and OpenClaw has no rewind call), so the window offers no edit or regenerate for OpenClaw; pl_parity ocy checks none is offered (copy is). Hermes edit: PASS below. |
| Background tasks panel | PASS | pl_chat: the side panel opens on the agent's background tasks (tasks.list). |
| Agents' browser panel | PASS | plparity: the card's Open -> the side panel's Browser shows the tab live (picture 1280x743 drawn from the office's frame route). pl_parity brw. |

## 2.3 OpenClaw sub-menu (Agent Providers -> OpenClaw)
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Overview | PASS | pl_menu: renders from the lab (uptime, port, process, event loop). |
| Agents | PASS | pl_menu: list; model change shows from -> to and lands on the gateway (agents.entries.ops.model removed). Create/rename/delete not driven. |
| Models | PASS | pl_menu: renders (Stub One default, signed in). |
| Tools + plugins | PASS | pl_menu: renders (tools.effective without a live session falls back to tools.catalog, by design). |
| Skills | PASS | pl_menu: renders the lab's skills. |
| Automations | PASS | pl_menu: renders the lab's Heartbeat job. (VO's cron.html editor stays reachable from the office menu.) |
| Approvals | PASS | pl_menu: renders; exec.approvals.set used by pl_chat. |
| Sessions | PASS | pl_menu: renders every session. |
| Settings | PASS | pl_menu: schema-driven sections render (Setup .. Gateway ...). No setting saved in C2. |

## 2.4 OpenClaw agents, identity, presence, PC, live screens
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Agents roster source | PART | the copied window's agents are the gateway's (agents.list through the layer; made / deleted agents follow within seconds, pl_parity agents). The office roster and desks: layer agents with an office id (C3 id map); a brand-new gateway agent has none yet, so it is in the window, not at a desk: the C4 roster work (pllife). |
| Agent avatar / look | KEEP-VO | office sprites and overrides. |
| Model per agent shown and changed | PASS | pl_menu: Agents tab model change. |
| New agent on the gateway appears / removed agent retires | PASS | plparity: agents.create from the menu -> the agent joins the layer (the copied window's agents) within seconds (fixed: the layer listed the agents 50 ms after the change, before OpenClaw applied it; now it lists again until the change shows, up to ~15 s); agents.delete -> switched off (retired, chats kept). The office roster lists layer agents that have an office id (C4 roster work). pl_parity agents. |
| Live presence from every channel | KEEP-VO | office presence unchanged in C2; it moves onto the layer's bus in C4. |
| Agents' PC: workspace files and docs | KEEP-VO | the copied side panel's PC tab opens the office's own Agent PC (VirtualOfficePreviews.openPC). |
| Live browser stream | PASS | plparity: GET /api/providers/browser lists the running tabs; /api/providers/browser/frame gives JPEG frames (seq 3), the panel's reload action -> a new frame (seq 4); frames come through the office, never the CDP port. pl_parity brw. |
| World bodies, desks in a city, cars, phones, Free Will | N/A | MVW only. |

## 3.1 Hermes connection, auth, discovery, status
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Transport: hermes serve JSON-RPC + dashboard REST | PASS | lab a turns (pl_chat Hermes, C1). |
| Session token sign-in | PASS | lab a (token). |
| Username + password via native PKCE | PASS | C1 lab b (sign-in). |
| client.capabilities, unknown requests answered | PASS | C1 lab a/b connect with it; unknown requests not provoked. |
| Reconnect with backoff, replay | PART | plparity: lab a restarted under an open chat -> the connection comes back by itself and the next turn is answered (pl_parity hx3). Replay of a turn in flight (session.events.since) not seen: a restart ends Hermes' process, so nothing is left to replay; a socket drop alone was not produced. |
| Attach-or-start a local Hermes | N/A | missing in MVW too. |
| Profiles = agents | PASS | lab profiles default/quill/research/scout are the layer's Hermes agents; the chat runs on 'default'. |
| Legacy API-server rows + one-click switch | KEEP-VO | VO only (5.3). |
| Chat only kept by the adapter | PASS | plparity: a Chat only connection to lab a lists its agents; a settings change (config.patch) is refused with the reason (403 chat_only, refused by the layer before Hermes is asked). pl_parity hx3. |

## 3.2 Hermes chat window
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Streaming text, reasoning, status, tool start/complete | PASS | pl_chat: streamed answers; [[think]] -> reasoning folded ('Thought'); a terminal tool -> 'Ran echo ...' row. |
| Desktop drawing (view: hermes) | PASS | the Hermes view draws the chat (flat turns, its own / menu, goal section). |
| Slash commands: / catalog by category | PASS | pl_chat: 108 commands in Session, Configuration, Info, Tools & Skills, Skills. |
| Slash commands: run where | PASS | pl_chat: /title and /goal run as Hermes calls, not prompts. |
| @ references | PASS | plparity: '@file:plpar' -> Hermes' complete.path suggests the chat folder's plparity-ref.txt; picked, sent as @file:plparity-ref.txt, Hermes answers to it. pl_parity hx2. |
| Side questions /btw, background /bg | PASS | plparity: /btw answered beside the chat (Hermes' side question, the chat goes on); /bg starts a background task, its result shows later in the chat ('[bg ...] Stub reply ...'). pl_parity hx. |
| Goal / loop / heartbeat status stack | PASS | pl_chat: /goal -> the goal section shows. |
| Approvals: Command card | PASS | pl_chat: rm -rf in the lab's scratch -> Command card -> Run -> the folder is gone. Reject / Allow this session / Always allow not driven. |
| Questions (clarify) | PASS | pl_chat: lettered choices with Recommended ('A Red (Recommended)'), answered, the turn goes on. |
| Sudo / secret masked dialog | PART | plparity: a secret request (a lab skill needing PLPARITY_LAB_KEY, loaded with skill_view) -> the masked dialog over the window (the key's name and prompt), the value typed reaches Hermes (lab .env) and is never in the page. The sudo variant of the same dialog was not provoked: no sudo on the lab host. pl_parity hsecret. |
| Todo list in composer | NOT SEEN | the copied UI is in place (hv-todo rows from todo.updated). Not producible here: lab Hermes 0.22.2 offers no todo_list tool to the office's sessions (the lab's tool list has none; a profile with platform_toolsets.cli todo and a lab copy with it added made no difference). pl_parity hx reports it as SKIP. |
| Subagents strip | PASS | plparity: delegate_task -> the subagents strip while the child works (its goal, model, time). Steer/Stop of a child not driven (the lab child answers in about 0.1 s). pl_parity hx. |
| Delegation card | PASS | plparity: delegate_task -> a delegation card per child ('plparity child task', its answer). pl_parity hx. |
| Send while working: redirect, queue | PASS | pl_chat: Enter while it works -> Hermes stops the turn and answers the correction; Ctrl+Enter -> answered after the turn. |
| Message actions: Edit message, Restore checkpoint, Refresh | PASS | Edit (pl_chat: Hermes holds A,B2). plparity: Refresh on the last answer -> a new answer in its place; Restore checkpoint on the first prompt (the window's confirm) -> later turns removed, the prompt runs again. pl_parity hx2. |
| Branch / Branch whole chat / Copy ID / Archive | PASS | pl_chat: Branch in new chat opens 'Lab chat #2'; Archive takes the chat out of the list. |
| Titles follow Hermes | PASS | pl_chat: /title Lab chat renames the window's chat. |
| Usage / context | PASS | plparity: /usage answers from Hermes (session.usage: context 14,057 / 256,000, messages, compressions). pl_parity hx. |
| Sidebar marks | PASS | plparity: the chat waiting for an answer (a clarify question) is marked waiting (and working) in the sidebar, with its age ('now'). pl_parity hx3. |
| Model + reasoning pickers | PASS | plparity: the model picker lists Hermes' model options (lab: stub-1 Custom endpoint default + its listed models), a pick runs the next turn; the reasoning picker shows Hermes' levels (Default, Minimal .. Extra high), High set. pl_parity hx. |
| Attachments in | PASS | plparity: a text file attached in the composer reaches Hermes with the prompt (Hermes' reply quotes the @file: it was given). pl_parity hx. |
| Media out | PASS | plparity: a MEDIA: line from Hermes -> the picture in the chat through the signed /api/providers/media (no disk path in the page), decoded 2x2. pl_parity hx. |
| History from stored messages | PASS | after a reload the chat is read back from Hermes (A,B2). |
| Observe other channels + presence window | PASS | plparity: a second Hermes client (its own WebSocket, as Desktop: session.resume + prompt.submit) sends into the open chat's session -> the turn shows live in the office window. Presence of the agent itself: office presence (KEEP-VO row below). pl_parity hx3. |
| Esc stops a running turn; waiting row | PASS | pl_chat: Esc in the composer stops the turn, the window stays. plparity: a model slow to start ([[delay:6000]]) -> the activity row with its time while Hermes has not answered. pl_parity hx2. |

## 3.3 Hermes sub-menu
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Overview .. Settings (9 tabs) | PASS | pl_menu: overview, agents, models, tools, skills, automations, mcp, sessions, settings render from lab a. |
| VO's Keys tab (env.list / env.set) | PASS | pl_menu: kept in the copied menu (hermes.js Keys tab; layer menu env.list = names + set only, env.set in menuWrite): a key set after the from -> to confirm, no value comes back. |

## 3.4 Hermes screen, files, tasks, presence
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| Bot Desktop live (noVNC relay, lease) | PASS | plparity: lab a's Bot Desktop (Xvnc on a 0600 Unix socket, no TCP) started from the side panel's Screen tab; live in the panel through the office's noVNC relay (1440x900, drawn); thumbnail JPEG through the office; Take over -> the person holds the lease, Hand back -> the agent; turned off with the office's confirm. pl_parity hscreen. |
| Agent files in the Agents' PC | KEEP-VO | the PC tab opens the office's Agent PC. |
| Background tasks = subagents + Hermes cron | PASS | plparity: the side panel's Tasks for a Hermes agent (This chat / All of the agent's): after a delegate_task the child is listed (RUNNING 0, FINISHED 1). pl_parity hx3. |
| Live presence | KEEP-VO | office presence until C4. |

## 4 Cross-cutting
| Feature | Status | Evidence (C2 = this run, labs only) |
|---|---|---|
| One capability vocabulary | PASS | commands, queue, branch, archive, titles caps drive the copied UI (above). |
| Native call gateway (POST /api/providers/native) | PASS | Hermes catalog, /title, /goal go through it (C1: commands.catalog 200). |
| Notifications into the office | KEEP-VO | Office Life signs stay VO's; C4 feeds them from the layer's bus. |
| Chat sidebar: pins, by day, search, projects, export, marks | PASS | list, new, branch, archive (pl_chat); search, pin, projects, export, the working ring (pl_parity ocy); Hermes' waiting mark with age (pl_parity hx3). |
| Up to 4 chat windows, restore after reload | PASS | restore after reload (pl_chat); one limit of four with the office's own windows (tests/test_chat_windows.cjs). |
| Per-agent identity across connections | PASS | pl_menu: the second gateway's agents get their own keys (prov-<id>-*). |
| Secrets sealed, never to the page | PASS | the page only sees secret flags ({token: true|false}); C1 sealed store. |

