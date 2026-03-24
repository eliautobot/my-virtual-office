# Virtual Office Presence

Update your presence in the Virtual Office so the live office visualization reflects what you're doing.

## When to use

- **Starting work:** Set your status to working with a task description
- **Finishing work:** Set your status back to idle
- **Starting a meeting:** Create a meeting with participants
- **Ending a meeting:** End the meeting by ID

## How to update presence

Use `exec` to call the Virtual Office API. The server URL is configured in your environment.

### Set working
```bash
curl -s -X POST http://localhost:8090/api/presence/YOUR_AGENT_ID \
  -H "Content-Type: application/json" \
  -d '{"state": "working", "task": "DESCRIPTION OF WHAT YOU ARE DOING"}'
```

Replace `YOUR_AGENT_ID` with your agent ID (e.g. the value after `agent:` in your session key).
Replace `DESCRIPTION` with a short description of your current task.

### Set idle
```bash
curl -s -X POST http://localhost:8090/api/presence/YOUR_AGENT_ID \
  -H "Content-Type: application/json" \
  -d '{"state": "idle"}'
```

### Set break
```bash
curl -s -X POST http://localhost:8090/api/presence/YOUR_AGENT_ID \
  -H "Content-Type: application/json" \
  -d '{"state": "break"}'
```

## When to update

- **Before starting any task** → set working with task description
- **After completing a task** → set idle
- **When delegating to another agent** → set working with "Delegating to [agent]"
- **When waiting for a response** → stay working (don't go idle mid-task)

## Rules

- Keep task descriptions short (under 50 characters)
- Always set idle when you're done — don't leave yourself as "working" forever
- If you're unsure, don't update — the office can infer state from your activity
- This is optional — if the skill isn't available or the server is unreachable, just skip it

## Examples

```bash
# Working on email
curl -s -X POST http://localhost:8090/api/presence/pq-mike \
  -H "Content-Type: application/json" \
  -d '{"state": "working", "task": "Reviewing inbox"}'

# Done
curl -s -X POST http://localhost:8090/api/presence/pq-mike \
  -H "Content-Type: application/json" \
  -d '{"state": "idle"}'
```
