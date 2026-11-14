# Session Task Progress

Chat windows can show an agent's own task list (checklist and notes) for the session you are
looking at. The list comes straight from the agent's provider. Virtual Office does not keep its
own copy, does not guess tasks from the conversation text, and cannot write tasks.

## What you see

- The checklist appears above the composer while a session has one, and in the **Tasks**
  drawer of each chat window. Empty, loading, unsupported and denied states are explained in
  the drawer only; they never take space above the composer.
- A read-only **References** rail sits above Tasks. It lists the links found in the loaded
  conversation. It is not a saved library and stores nothing.
- The header **Session history** control is unchanged. References, Tasks and history open one
  at a time in each window. Reset, hide and switching agent or session clear the loaded
  references.

## Which session

Progress is tied to the exact session: `(connectionId, providerKind, nativeOwnerId,
nativeSessionId)` from the selected agent and the chat window. No alias stands in for a
missing connection. OpenClaw child session keys and provider session ids with colons are kept
as they are. A new chat that has not started yet has no progress. Switching, closing or hiding
a window releases its watcher at once, and late answers from an older selection are ignored.
Watchers live in memory only and are removed after the last viewer (at most 16).

## HTTP contract

`POST /api/openclaw/task-progress` on the office's own address. The path keeps the
`/api/openclaw` prefix because it uses the same browser cookie as the OpenClaw proxy. Native
ids travel in the JSON body, never in the URL.

Read:

```json
{"action":"read","identity":{"connectionId":"default","providerKind":"openclaw","nativeOwnerId":"example-agent","nativeSessionId":"agent:example-agent:main"}}
```

The values above are examples, not defaults; all four identity fields are required. The answer
uses the `vw-session-progress/v1` schema: availability, identity, a bounded native card,
capabilities, source, observed time and an optional opaque connection epoch. Run status is
separate from checklist status; after a reload the state starts as unknown instead of guessing
that work finished.

Security:

- Same rules as the OpenClaw proxy: the HttpOnly, SameSite=Strict proxy cookie, a
  constant-time secret check and a same-origin check. No permissive CORS, `no-store` and
  `nosniff` on every answer. The office passcode, when set, applies first.
- Bodies are limited to 8192 bytes. Chunked, malformed or extra fields are refused.
- Every request is checked against the current provider registry, the configured owner and
  connection, and the provider's task capability, before routing and again after the answer.
  A denial returns no data. Raw upstream errors, credentials and endpoints never reach the
  browser.
- Only `read` and `dismiss` exist. `dismiss` clears a finished plan: it needs a browser
  confirmation, a non-empty list where every step is complete, the native `expectedRevision`
  and the `connectionEpoch`. The only native write is `progressCard.put({sessionKey,
  expectedRevision})`; it never accepts plan text. The general `/api/openclaw/rpc` route still
  refuses `progressCard` get/put and arbitrary tool calls.

## Providers

- **OpenClaw:** native `progressCard.get` plus `progressCard.changed` notifications (the
  notification carries only the session key and revision). Native limits are kept: 50 steps,
  512-byte labels, one active step, 8 KiB of Markdown notes. Dismiss uses native revision
  checks. The office's Gateway connection must already be authenticated.
- **Hermes:** read-only, built from the latest complete native `todo` tool result in that
  session (matching call id and session id). One read of the newest 500 session messages, at
  most 2 MiB. Redirects are refused, and no other endpoint or credential is tried. Limits: 256
  items, 4000-character descriptions, 4096-byte ids. No native notes or revisions, and no
  promise that live, reload and compaction always agree.
- **Other providers:** not supported; nothing is invented for them.

The checklist renderer has its own sanitizer (separate from chat Markdown): it drops scripts,
media, styles, identifiers and unsafe links, limits nodes, depth and text, and keeps validated
progress bars.

## Tests

Python:

```bash
python3 -m pytest tests/test_session_progress.py tests/test_session_progress_http.py tests/test_task_security_regressions.py
```

Node:

```bash
node tests/test_session_progress.mjs
node tests/test_office_task_progress.cjs
```

`tests/run_all.sh` runs all of them. `tests/run_progress_browser.py` drives
`tests/session-progress-browser.html` in a fresh Chromium with its sandbox on; it needs a
Chromium whose sandbox works on your machine. The DOM tests run under emulation, so they are
not a substitute for checking a real browser and phone.
