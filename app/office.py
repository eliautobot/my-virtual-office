#!/usr/bin/env python3
"""Virtual Office — agent status CLI.

Usage:
  python office.py <agent_key> <state> [task]
  python office.py <agent_key> --think "thinking text"
  python office.py <agent_key> --say "speech text" [--to "target name"]
  python office.py <agent_key> --clear-bubbles
  python office.py --all <state> [task]
  python office.py --show
  python office.py --meet <id> <topic> <type> agent1,agent2,...
  python office.py --end-meet <id>
  python office.py --end-all-meets

States: working, idle, meeting, break, lounge
Meeting types: 1on1, group (auto-detected if omitted)

Agent keys are now dynamic — any agent ID is accepted.
"""
import json, sys, time, uuid, os

# Load status dir from vo-config.json or env, with fallback
def _get_status_file():
    cfg_path = os.environ.get("VO_CONFIG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "vo-config.json"))
    status_dir = os.environ.get("VO_STATUS_DIR", "/tmp/vo-data")
    try:
        with open(cfg_path, "r") as f:
            cfg = json.load(f)
        status_dir = cfg.get("presence", {}).get("statusDir", status_dir)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    os.makedirs(status_dir, exist_ok=True)
    return os.path.join(status_dir, "virtual-office-status.json")

STATUS_FILE = _get_status_file()

# No more hardcoded VALID_KEYS — accept any agent ID
VALID_KEYS = None  # dynamic
VALID_STATES = ["working", "idle", "meeting", "break", "lounge"]

def load():
    try:
        with open(STATUS_FILE, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}

def save(data):
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
    print(f"\n{'Agent':<12} {'State':<10} {'Task':<25} {'Thought':<25} {'Speech'}")
    print("-" * 100)
    all_keys = sorted([k for k in data.keys() if not k.startswith("_")])
    for k in all_keys:
        e = data.get(k, {})
        thought = e.get('thought', '')[:22]
        speech = e.get('speech', '')[:22]
        target = e.get('speechTarget', '')
        sp = f"{speech} →{target}" if target else speech
        print(f"{k:<12} {e.get('state','?'):<10} {e.get('task',''):<25} {thought:<25} {sp}")

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

    if sys.argv[1] == "--show":
        show(data)
        sys.exit(0)

    if sys.argv[1] == "--all":
        state = sys.argv[2] if len(sys.argv) > 2 else "idle"
        task = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""
        if state not in VALID_STATES:
            print(f"Invalid state: {state}. Use: {VALID_STATES}")
            sys.exit(1)
        all_keys = [k for k in data.keys() if not k.startswith("_")]
        for k in all_keys:
            ensure_entry(data, k)
            data[k]["state"] = state
            data[k]["task"] = task
            data[k]["updated"] = int(time.time())
        save(data)
        print(f"✅ All agents → {state}" + (f" ({task})" if task else ""))
        sys.exit(0)

    # --- Meeting management ---
    if sys.argv[1] == "--meet":
        # --meet <id> <topic> <type> agent1,agent2,...
        # or --meet <topic> agent1,agent2,...  (auto-id, auto-type)
        args = sys.argv[2:]
        if len(args) < 2:
            print("Usage: --meet [id] <topic> [type] agent1,agent2,...")
            sys.exit(1)

        meetings = ensure_meetings(data)

        # Parse flexibly
        agent_list_str = args[-1]  # last arg is always agent list
        agent_list = [a.strip() for a in agent_list_str.split(",")]

        # Agents are dynamic — no validation against a fixed list

        if len(args) == 2:
            # --meet <topic> agents
            meet_id = str(uuid.uuid4())[:8]
            topic = args[0]
            meet_type = "1on1" if len(agent_list) == 2 else "group"
        elif len(args) == 3:
            # Could be: --meet <id> <topic> agents  OR  --meet <topic> <type> agents
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

        # Remove existing meeting with same id
        meetings[:] = [m for m in meetings if m["id"] != meet_id]

        meetings.append({
            "id": meet_id,
            "topic": topic,
            "type": meet_type,
            "agents": agent_list
        })
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
        if len(meetings) < before:
            print(f"✅ Meeting [{meet_id}] ended")
        else:
            print(f"⚠️  Meeting [{meet_id}] not found")
        sys.exit(0)

    if sys.argv[1] == "--end-all-meets":
        data["_meetings"] = []
        save(data)
        print("✅ All meetings ended")
        sys.exit(0)

    # --- Per-agent updates ---
    key = sys.argv[1]
    # Dynamic agent keys — any ID is accepted

    entry = ensure_entry(data, key)
    args = sys.argv[2:]

    did_bubble = False
    if "--think" in args:
        idx = args.index("--think")
        thought = args[idx + 1] if idx + 1 < len(args) else ""
        entry["thought"] = thought
        entry["updated"] = int(time.time())
        print(f"💭 {key} thinking: {thought}")
        did_bubble = True

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
        print(f"💬 {key}: {speech}" + (f" → {target}" if target else ""))
        did_bubble = True

    if did_bubble:
        save(data)
        sys.exit(0)

    if "--clear-bubbles" in args:
        entry["thought"] = ""
        entry["speech"] = ""
        entry["speechTarget"] = ""
        entry["updated"] = int(time.time())
        save(data)
        print(f"🧹 {key} bubbles cleared")
        sys.exit(0)

    # --input "text" --from "PersonName"
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

    # --output "text" (also sets notify=true)
    if "--output" in args:
        idx = args.index("--output")
        text = args[idx + 1] if idx + 1 < len(args) else ""
        entry["lastOutput"] = {"text": text}
        entry["notify"] = True
        entry["updated"] = int(time.time())
        save(data)
        print(f"📤 {key} output: {text[:40]}... (🔔 notify ON)")
        sys.exit(0)

    # --notify (toggle notification light)
    if "--notify" in args:
        entry["notify"] = True
        entry["updated"] = int(time.time())
        save(data)
        print(f"🔔 {key} notification ON")
        sys.exit(0)

    # --clear-notify
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
