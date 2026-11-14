# Design History

This folder keeps historical implementation briefs, QA notes, and architecture
specs that are still useful for understanding how My Virtual Office evolved.

These files are not current setup instructions or release checklists. Current
user documentation lives in the root `README.md` and current product docs under
`docs/`.

Before moving anything out of this folder, verify it still matches the current
code and product behavior.

Files here:

- `UNIVERSAL-AGENT-HARNESS-SPEC.md`: the early multi-provider plan. Superseded by
  `docs/PROVIDER-SDK.md` and the provider registry in `app/providers/`.
- `INTEGRATION-SPEC.md`, `MULTI-CHAT-SHARED-COMPONENT-QA.md`, `QA-CODE-QUALITY-SCAN.md`,
  `CRUD-TEST-RESULTS.md`: older integration notes and QA reports.
- `PROJECTS-FEATURE-SPEC.md` and the `TASK-*.md` briefs: the original build briefs for the
  Projects board, agent creator, office editor, furniture editor, walls and pathfinding, and
  the z-order fix.
- `MULTI-CHAT-ARCHITECTURE.md`: the original plan for multiple chat windows (shipped as
  `class ChatWindow` in `app/chat.js`).
