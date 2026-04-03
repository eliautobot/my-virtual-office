# Multi-Chat Window Architecture

Status: approved architecture plan for the existing Virtual Office chat UI
Scope: keep one shared chat system while allowing the main chat plus up to 3 additional slide-out windows

## 1) Window model

Use one `ChatWindowManager` with **4 total slots**:

- `primary` — the existing main chat window
- `secondary-1`
- `secondary-2`
- `secondary-3`

Rules:

- `primary` always exists and owns the current chat toggle button behavior.
- Secondary windows are optional and only created when opened.
- Max open windows at one time = **4** total (`primary` + 3 secondary).
- Secondary windows are ordered left-to-right by slot number so layout is deterministic.
- Closing a secondary window destroys only that slot instance state for layout/UI, not the underlying session history.

## 2) Per-window state model

Each slot stores its own selected chat target and UI state.

```js
const chatWindows = {
  primary: {
    slotId: 'primary',
    kind: 'primary',
    isOpen: false,
    selectedAgentKey: 'main',
    sessionKey: 'agent:main:main',
    draft: '',
    attachments: [],
    pendingRunId: null,
    streamingMessageId: null,
    modelName: '—',
    contextWindow: 0,
    contextUsed: 0,
    unread: 0,
    layoutMode: 'docked-right',
  },
  'secondary-1': null,
  'secondary-2': null,
  'secondary-3': null,
};
```

Notes:

- `selectedAgentKey` and `sessionKey` are stored **per window**, not globally.
- Draft text, queued attachments, streaming state, model info, and unread count are also per window.
- Session history is still sourced from OpenClaw by `sessionKey`; the window just points at which session it is rendering.
- If two windows intentionally point to the same `sessionKey`, both should render the same conversation stream but keep separate local draft/layout state.

## 3) Shared UI/component logic

Do **not** fork chat logic into 4 copies.

Build one reusable system:

- `createChatWindow(slotId, containerEl)`
- `renderChatWindow(slotState)`
- `bindChatWindowEvents(slotState, elements)`
- `loadChatHistory(slotState)`
- `connectChatStream(slotState)`
- `sendChatMessage(slotState)`
- `resetChatSession(slotState)`
- `destroyChatWindow(slotId)`

Implementation rule:

- Replace current singletons like `chatPanel`, `chatMessages`, `chatInput`, `chatStatus`, `SESSION_KEY`, and `currentAgentKey` with a **slot-scoped state object**.
- Keep one shared template for markup and one shared CSS block.
- Use `data-chat-slot="primary|secondary-1|secondary-2|secondary-3"` on each window root.
- Event handlers resolve the slot from the closest `[data-chat-slot]` root instead of using global DOM ids.

Recommended split:

- `chat.js` owns `ChatWindowManager`, shared rendering, websocket/RPC helpers, and slot lifecycle.
- HTML contains one host container, not four hardcoded full chat panels.
- CSS styles `.chat-panel` universally and uses modifiers like `.chat-panel--primary` / `.chat-panel--secondary` only for placement differences.

## 4) Session + connection strategy

Use **shared transport, isolated window state**.

- One gateway token fetch.
- One websocket connection manager per page.
- Window instances subscribe/unsubscribe by `sessionKey`.
- RPC helpers stay shared, but message routing includes `slotId` + `sessionKey`.
- Streaming callbacks map by `runId -> slotId` so partial responses land in the correct window.

That avoids 4 separate websocket stacks while keeping each chat view independent.

## 5) Secondary window creation rules

When a secondary window opens:

1. Find the requested slot (`secondary-1`, `secondary-2`, `secondary-3`).
2. If empty, create window state using either:
   - cloned target from the primary window, or
   - explicit agent/session selected by the user.
3. Mount the shared chat template into the slot container.
4. Load history for that slot's `sessionKey`.
5. Register stream/unread listeners for that slot.

When a secondary window closes:

1. Stop slot-specific listeners.
2. Preserve nothing except server-backed chat history.
3. Remove DOM for that secondary slot.
4. Reflow remaining secondary windows without renumbering occupied slots.

## 6) Buttons 1, 2, and 3: toggle behavior

Treat buttons `1`, `2`, and `3` as dedicated toggles for `secondary-1`, `secondary-2`, and `secondary-3`.

### Button rules

- Button `1` toggles `secondary-1`
- Button `2` toggles `secondary-2`
- Button `3` toggles `secondary-3`

### Open behavior

- If the slot is closed, clicking its button opens that exact slot.
- Default target on open = current target from `primary`.
- If the slot had a previously selected agent in the same page lifetime and is only hidden, restore it.

### Close behavior

- If the slot is open, clicking its button closes it.
- Closing one secondary slot does **not** close or retarget any other slot.

### Max-window behavior

- Hard cap is always 4 total windows.
- Because buttons map to fixed slots, no extra overflow logic is needed beyond preventing any 4th secondary from existing.
- If all 3 secondary windows are already open, button clicks only act as close toggles for their own slots.
- The primary window is outside the `1/2/3` cap and cannot be replaced by a secondary slot.

### Recommended button states

- inactive = slot closed
- active = slot open
- attention dot = slot has unread activity while not focused

## 7) Focus and layout behavior

- Primary chat remains the anchor window and keeps current dock/snap behavior.
- Secondary windows slide out as stacked columns to the left of the primary chat area.
- Focused window gets the active input caret and top z-index.
- Unfocused windows continue streaming and updating unread counters.
- Mobile fallback: only one chat window visible at a time; buttons `1/2/3` switch which secondary slot is shown.

## 8) Migration from current code

Current code has page-global variables for one chat instance. Migrate in this order:

1. Extract a `slotState` object.
2. Convert DOM lookups from ids to slot-root queries.
3. Replace global `SESSION_KEY` / `currentAgentKey` with slot properties.
4. Move message rendering/helpers to shared slot-aware functions.
5. Add a top-level `ChatWindowManager` registry.
6. Add secondary-slot buttons and slot containers.
7. Keep current primary behavior unchanged while secondary slots are added incrementally.

## 9) Acceptance criteria

This architecture is correct when all of the following are true:

- Main chat plus 3 secondary windows can exist as one system.
- Each window remembers its own selected agent/session state.
- All windows are rendered by the same shared chat template and JS logic.
- Buttons `1`, `2`, and `3` are fixed slot toggles with deterministic open/close behavior.
- No copy-pasted per-window chat code is required.
