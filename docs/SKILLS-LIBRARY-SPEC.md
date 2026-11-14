# Skills Library

## Overview

The Skills Library is a central shelf of reusable skill files. You can copy (apply) a library
skill to any agent whose provider supports skills. The agent gets its own independent copy that
it can change; edits do not sync back to the library.

Open it from **More tools > Skills library**, or from an agent's Desk (Skills tab).

## Data Model

- **Library location:** `<OpenClaw home>/skills-library/`. In Docker this is
  `/openclaw/skills-library`, which is `VO_OPENCLAW_PATH/skills-library` on the host (default
  `~/.openclaw/skills-library`). It is not inside the `vo-data` volume, so back it up with your
  OpenClaw home.
- **Each skill:** a folder containing `SKILL.md` (the AgentSkills / OpenClaw skill format):
  `<OpenClaw home>/skills-library/<skill-name>/SKILL.md`.
- **Agent copies:** written into the agent provider's declared skill root (each provider's
  `skillSchema`, for example `.agents/skills` for Codex or `skills` for a Hermes profile). See
  [Provider SDK](PROVIDER-SDK.md).
- **Flow:** library (master copy) -> apply to agent -> the agent owns its copy.
- Five built-in office skills are written into the library at every start (so they stay
  current): `AgentPlatform-to-AgentPlatform_Communications` (see
  [Agent Platform Communications](AGENT_PLATFORM_COMMUNICATIONS.md)),
  `VirtualOffice-Presence-and-Status`, `VirtualOffice-Browser-Control`,
  `VirtualOffice-Meetings` and `VirtualOffice-Projects-and-Tasks` (see
  [Virtual Office Agent Tools](VIRTUAL_OFFICE_AGENT_TOOLS.md)). Do not edit these in place;
  copy them under a new name.

## SKILL.md Format

```yaml
---
name: skill-name
description: One-line description of what the skill does
---

# Skill Title

Skill content (Markdown instructions for the agent)
```

## API Endpoints

### GET /api/skills-library
List all skills in the library, sorted by name.
Returns `{"skills": [{name, description, path}]}`.

### GET /api/skills-library/<name>
Read one skill. Returns `{name, description, content}`.

### POST /api/skills-library
Create or update a skill. Body: `{name, content}`. `name` becomes the folder name
(slugified); `content` is the full SKILL.md text. An existing skill with the same name is
replaced.

### DELETE /api/skills-library/<name>
Delete a skill from the library.

### POST /api/skills-library/apply
Copy a library skill to an agent. Body: `{skill, agentId, overwrite?, rootId?}`.
- Writes into the agent's provider skill root and creates the folder if needed.
- If the agent already has the skill, the answer is `{"ok": false, "exists": true, "warning": ...}`.
- Send `overwrite: true` to replace it. The old copy is backed up first.

### POST /api/skills-library/save-from-agent
Copy an agent's own skill into the library. Body: `{agentId, skill}`.

### POST /api/skills-library/upload
Upload a SKILL.md file. Body: `{filename, content}` (content is base64).

### Skill Workshop
OpenClaw agents can propose new or changed skills. The Skill Workshop shows those proposals:
- `GET /api/skills-workshop?agentId=<id>` lists proposals.
- `GET /api/skills-workshop/inspect?id=<proposal id>&agentId=<id>` shows one proposal.
- `POST /api/skills-workshop/action` with `action` = `apply`, `reject`, `quarantine` or `revise`.

## UI

- **Skills library window:** add a skill, upload a `.md` file, edit, delete, and apply a skill
  to an agent. When the agent already has the skill you are asked before it is replaced.
- **Agent Desk > Skills:** the agent's own skills, saving one back to the library, and the
  Skill Workshop proposals for that agent.

## File Structure

```
<OpenClaw home>/
└── skills-library/
    ├── example-skill/
    │   └── SKILL.md
    ├── another-skill/
    │   └── SKILL.md
    └── ...
```

## Notes

- The library folder is a normal folder on the host. You can manage the files directly; the
  UI is a convenience layer and the files are the source of truth.
- Agent copies are independent. Edits do not sync back to the library.
