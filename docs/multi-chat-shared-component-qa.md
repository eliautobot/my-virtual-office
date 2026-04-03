# Multi-Chat Shared Component QA

Date: 2026-04-03
Target: Virtual Office Product (`8090`)

## Result

The extra chat windows are still part of the same underlying chat UI system as the main chat.

## Evidence

### Shared component / shared layout

- `app/chat.js` builds each extra window by cloning the primary `#chat-panel` DOM:
  - `buildSecondaryChatPanel(slotNum)`
  - `const panel = primaryPanel.cloneNode(true)`
- The same `ChatWindow` class is then instantiated for the main window and every secondary window.
- Shared selectors/classes are reused across all windows:
  - `.chat-header`
  - `.chat-model-bar`
  - `.chat-messages`
  - `.chat-input-row`
  - `.chat-agent-select`
  - `.chat-send-btn`, `.chat-stop-btn`, `.chat-mic-btn`, `.chat-attach-btn`
- Styling is shared through the same `app/style.css` rules. Secondary windows only add thin wrapper/layout overrides (`.chat-panel-secondary`) instead of a separate UI implementation.

### Why future main-chat UI changes will carry over

Because secondary windows are cloned from the primary panel markup and wired through the same `ChatWindow` class, any change to the shared chat markup, selectors, or base CSS will automatically affect all windows unless it is intentionally overridden by a slot-specific rule.

## UX testing notes

### Desktop stack behavior

- Main chat remains the anchor window.
- Secondary windows still slide out from the same system to the left of the main panel.
- Each window keeps its own agent/session state.

### Mobile / narrow-layout polish applied

Before this pass, the desktop side-stack behavior also carried into narrow layouts, which could make multiple secondaries feel cramped or overlapping.

Applied fix:

- On narrow layouts (`<= 900px`), opening a secondary chat now closes the other secondary windows first.
- Secondary windows now use full-width bottom-sheet behavior on narrow screens instead of desktop-style side translations.
- Header/model bar/input spacing was tightened for narrow screens so controls wrap more cleanly.

## Remaining edge cases worth future follow-up

1. If someone intentionally wants multiple secondary chats visible at once on a tablet-sized screen, the new narrow-layout rule prefers clarity over density and shows one secondary at a time.
2. Any future main chat changes that rely on unique element IDs should continue removing duplicate IDs from cloned panels, as the current implementation already does.
3. If unread badges or per-window attention indicators get added later, they should stay slot-scoped in `ChatWindow` state rather than page-global.
