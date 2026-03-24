#!/usr/bin/env python3
"""Utility to update agent status in the Virtual Office.

Usage:
  python update_status.py <agent_key> <state> [task]
  python update_status.py <agent_key> --think "thinking text"
  python update_status.py <agent_key> --say "speech text" [--to "target name"]
  python update_status.py <agent_key> --clear-bubbles
  python update_status.py --all <state> [task]
  python update_status.py --show
  python update_status.py --meet <id> <topic> <type> agent1,agent2,...
  python update_status.py --end-meet <id>
  python update_status.py --end-all-meets

Agent keys are auto-discovered from the OpenClaw installation.
States: working, idle, meeting, break, lounge
Meeting types: 1on1, group (auto-detected if omitted)
"""
import json, sys, time, uuid, os

STATUS_DIR = os.environ.get("VO_STATUS_DIR", "/tmp/vo-data")
STATUS_FILE = os.path.join(STATUS_DIR, "virtual-office-status.json")

VALID_STATES = ["working", "idle", "meeting", "break", "lounge"]

def get_valid_keys():
    """Get agent keys from status file (auto-discovered)."""
    try:
        with open(STATUS_FILE) as f:
            data = json.load(f)
        return [k for k in data.keys() if not k.startswith("_")]
    except:
        return []

def load():
    try:
        with open(STATUS_FILE, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}

def save(data):
    os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
    with open(STATUS_FILE, "w") as f:
        json.dump(data, f, indent=2)

def ensure_entry(data, key):
    if key not in data:
        data[key] = {"state": "idle", "task": "", "thought": "", "speech": "", "speechTarget": "", "updated": 0}
    for field in ("thought", "speech", "speechTarget"):
        if field not in data[key]:
            data[key][field] = ""
    return data[key]

def ensure_meetings(data):
    if "_meetings" not in data:
        data["_meetings"] = []
    return data["_meetings"]

def show(data):
    keys = [k for k in data.keys() if not k.startswith("_")]
    print(f"\n{'Agent':<16} {'State':<10} {'Task':<25}")
    print("-" * 60)
    for k in keys:
        e = data.get(k, {})
        print(f"{k:<16} {e.get('state','?'):<10} {e.get('task',''):<25}")

    meetings = data.get("_meetings", [])
    if meetings:
        print(f"\n{'='*60}")
        print("ACTIVE MEETINGS:")
        for m in meetings:
            print(f"  [{m['id'][:8]}] {m['topic']} ({m['type']}) — {', '.join(m['agents'])}")
    print()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    data = load()
    valid_keys = get_valid_keys()

    if sys.argv[1] == "--show":
        show(data)
        sys.exit(0)

    if sys.argv[1] == "--all":
        state = sys.argv[2] if len(sys.argv) > 2 else "idle"
        task = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""
        if state not in VALID_STATES:
            print(f"Invalid state: {state}. Use: {VALID_STATES}")
            sys.exit(1)
        for k in valid_keys:
            entry = ensure_entry(data, k)
            entry["state"] = state
            entry["task"] = task
            entry["updated"] = int(time.time())
        save(data)
        print(f"✅ All agents → {state}" + (f" ({task})" if task else ""))
        sys.exit(0)

    if sys.argv[1] == "--meet":
        args = sys.argv[2:]
        if len(args) < 2:
            print("Usage: --meet [id] <topic> [type] agent1,agent2,...")
            sys.exit(1)
        meetings = ensure_meetings(data)
        agent_list_str = args[-1]
        agent_list = [a.strip() for a in agent_list_str.split(",")]
        if len(args) == 2:
            meet_id = str(uuid.uuid4())[:8]
            topic = args[0]
            meet_type = "1on1" if len(agent_list) == 2 else "group"
        elif len(args) == 3:
            if args[1] in ("1on1", "group"):
                meet_id = str(uuid.uuid4())[:8]
                topic = args[0]
                meet_type = args[1]
            else:
                meet_id = args[0]
                topic = args[1]
                meet_type = "1on1" if len(agent_list) == 2 else "group"
        else:
            meet_id = args[0]
            topic = args[1]
            meet_type = args[2] if args[2] in ("1on1", "group") else ("1on1" if len(agent_list) == 2 else "group")
        meetings[:] = [m for m in meetings if m["id"] != meet_id]
        meetings.append({"id": meet_id, "topic": topic, "type": meet_type, "agents": agent_list})
        save(data)
        print(f"🤝 Meeting [{meet_id}]: {topic} ({meet_type}) — {', '.join(agent_list)}")
        sys.exit(0)

    if sys.argv[1] == "--end-meet":
        meet_id = sys.argv[2] if len(sys.argv) > 2 else None
        if not meet_id:
            print("Usage: --end-meet <id>")
            sys.exit(1)
        meetings = ensure_meetings(data)
        before = len(meetings)
        meetings[:] = [m for m in meetings if m["id"] != meet_id]
        save(data)
        print(f"✅ Meeting [{meet_id}] ended" if len(meetings) < before else f"⚠️  Meeting [{meet_id}] not found")
        sys.exit(0)

    if sys.argv[1] == "--end-all-meets":
        data["_meetings"] = []
        save(data)
        print("✅ All meetings ended")
        sys.exit(0)

    key = sys.argv[1]
    if valid_keys and key not in valid_keys:
        # Allow creating new entries for unknown agents
        pass

    entry = ensure_entry(data, key)
    args = sys.argv[2:]

    if "--think" in args:
        idx = args.index("--think")
        entry["thought"] = args[idx + 1] if idx + 1 < len(args) else ""
        entry["updated"] = int(time.time())
        save(data)
        print(f"💭 {key} thinking: {entry['thought']}")
        sys.exit(0)

    if "--say" in args:
        idx = args.index("--say")
        speech = args[idx + 1] if idx + 1 < len(args) else ""
        target = ""
        if "--to" in args:
            tidx = args.index("--to")
            target = args[tidx + 1] if tidx + 1 < len(args) else ""
        entry["speech"] = speech
        entry["speechTarget"] = target
        entry["updated"] = int(time.time())
        save(data)
        print(f"💬 {key}: {speech}" + (f" → {target}" if target else ""))
        sys.exit(0)

    if "--clear-bubbles" in args:
        entry["thought"] = ""
        entry["speech"] = ""
        entry["speechTarget"] = ""
        entry["updated"] = int(time.time())
        save(data)
        print(f"🧹 {key} bubbles cleared")
        sys.exit(0)

    if "--input" in args:
        idx = args.index("--input")
        text = args[idx + 1] if idx + 1 < len(args) else ""
        from_name = ""
        if "--from" in args:
            fidx = args.index("--from")
            from_name = args[fidx + 1] if fidx + 1 < len(args) else ""
        entry["lastInput"] = {"from": from_name, "text": text}
        entry["updated"] = int(time.time())
        save(data)
        print(f"📥 {key} input: {text[:40]}..." + (f" (from {from_name})" if from_name else ""))
        sys.exit(0)

    if "--output" in args:
        idx = args.index("--output")
        text = args[idx + 1] if idx + 1 < len(args) else ""
        entry["lastOutput"] = {"text": text}
        entry["notify"] = True
        entry["updated"] = int(time.time())
        save(data)
        print(f"📤 {key} output: {text[:40]}... (🔔 notify ON)")
        sys.exit(0)

    if "--notify" in args:
        entry["notify"] = True
        entry["updated"] = int(time.time())
        save(data)
        print(f"🔔 {key} notification ON")
        sys.exit(0)

    if "--clear-notify" in args:
        entry["notify"] = False
        entry["updated"] = int(time.time())
        save(data)
        print(f"🔕 {key} notification cleared")
        sys.exit(0)

    state = args[0] if args else "idle"
    if state not in VALID_STATES:
        print(f"Invalid state: {state}. Use: {VALID_STATES}")
        sys.exit(1)

    task = " ".join(args[1:]) if len(args) > 1 else ""
    entry["state"] = state
    entry["task"] = task
    entry["updated"] = int(time.time())
    save(data)
    print(f"✅ {key} → {state}" + (f" ({task})" if task else ""))
