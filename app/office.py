#!/usr/bin/env python3
"""Virtual Office — agent status & project management CLI.

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

Project Management:
  python office.py --proj list [--status active|paused|completed|archived]
  python office.py --proj create "Title" [--desc "Description"] [--priority high] [--template tpl-software]
  python office.py --proj show <project-id>
  python office.py --proj update <project-id> [--title "New Title"] [--status paused] [--priority critical]
  python office.py --proj delete <project-id>
  python office.py --proj add-task <project-id> "Task title" [--col "To Do"] [--priority high] [--assign agent-key] [--due 2026-04-15]
  python office.py --proj update-task <project-id> <task-id> [--title "New"] [--priority high] [--assign agent] [--col "Done"]
  python office.py --proj complete-task <project-id> <task-id>
  python office.py --proj delete-task <project-id> <task-id>
  python office.py --proj comment <project-id> <task-id> "Comment text" [--author agent-key]
  python office.py --proj tasks <project-id> [--col "In Progress"]
  python office.py --proj report <project-id>
  python office.py --proj scores

States: working, idle, meeting, break, lounge
Meeting types: 1on1, group (auto-detected if omitted)

Agent keys are now dynamic — any agent ID is accepted.
"""
import json, sys, time, uuid, os
from datetime import datetime, timezone, timedelta

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

# ─── PROJECT MANAGEMENT ──────────────────────────────────────────────────────

def _get_status_dir():
    """Return the status directory path."""
    cfg_path = os.environ.get("VO_CONFIG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "vo-config.json"))
    status_dir = os.environ.get("VO_STATUS_DIR", "/tmp/vo-data")
    try:
        with open(cfg_path, "r") as f:
            cfg = json.load(f)
        status_dir = cfg.get("presence", {}).get("statusDir", status_dir)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return status_dir

def _proj_file():
    return os.path.join(_get_status_dir(), "projects.json")

def _scores_file():
    return os.path.join(_get_status_dir(), "project-scores.json")

def _load_proj():
    try:
        with open(_proj_file(), "r") as f:
            d = json.load(f)
        if not isinstance(d.get("projects"), list):
            d["projects"] = []
        return d
    except (FileNotFoundError, json.JSONDecodeError):
        return {"projects": [], "templates": []}

def _save_proj(d):
    os.makedirs(os.path.dirname(_proj_file()), exist_ok=True)
    with open(_proj_file(), "w") as f:
        json.dump(d, f, indent=2)

def _load_scores():
    try:
        with open(_scores_file(), "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"agents": {}}

def _save_scores(d):
    os.makedirs(os.path.dirname(_scores_file()), exist_ok=True)
    with open(_scores_file(), "w") as f:
        json.dump(d, f, indent=2)

def _uid():
    return str(uuid.uuid4())

def _now():
    return datetime.now(timezone.utc).isoformat()

def _default_columns():
    return [
        {"id": _uid(), "title": "Backlog", "color": "#6c757d", "order": 0},
        {"id": _uid(), "title": "To Do", "color": "#0d6efd", "order": 1},
        {"id": _uid(), "title": "In Progress", "color": "#ffc107", "order": 2},
        {"id": _uid(), "title": "Review", "color": "#fd7e14", "order": 3},
        {"id": _uid(), "title": "Done", "color": "#198754", "order": 4},
    ]

_BUILTIN_TEMPLATES = {
    "tpl-software": {
        "title": "Software Development",
        "columns": [
            {"title": "Backlog", "color": "#6c757d"},
            {"title": "Sprint", "color": "#0d6efd"},
            {"title": "In Progress", "color": "#ffc107"},
            {"title": "Code Review", "color": "#fd7e14"},
            {"title": "QA", "color": "#17a2b8"},
            {"title": "Done", "color": "#198754"},
        ],
        "tasks": [
            {"title": "Set up development environment", "colIdx": 0, "priority": "high"},
            {"title": "Define acceptance criteria", "colIdx": 0, "priority": "medium"},
            {"title": "Write unit tests", "colIdx": 0, "priority": "medium"},
        ],
    },
    "tpl-marketing": {
        "title": "Marketing Campaign",
        "columns": [
            {"title": "Ideas", "color": "#6c757d"},
            {"title": "Planning", "color": "#0d6efd"},
            {"title": "Creating", "color": "#ffc107"},
            {"title": "Review", "color": "#fd7e14"},
            {"title": "Published", "color": "#198754"},
        ],
        "tasks": [],
    },
    "tpl-bugs": {
        "title": "Bug Tracking",
        "columns": [
            {"title": "Reported", "color": "#dc3545"},
            {"title": "Confirmed", "color": "#fd7e14"},
            {"title": "In Progress", "color": "#ffc107"},
            {"title": "Fixed", "color": "#0d6efd"},
            {"title": "Verified", "color": "#198754"},
        ],
        "tasks": [],
    },
    "tpl-content": {
        "title": "Content Pipeline",
        "columns": [
            {"title": "Backlog", "color": "#6c757d"},
            {"title": "Research", "color": "#17a2b8"},
            {"title": "Writing", "color": "#ffc107"},
            {"title": "Editing", "color": "#fd7e14"},
            {"title": "Published", "color": "#198754"},
        ],
        "tasks": [],
    },
}

SCORE_BASE = 10
SCORE_PRIORITY = {"critical": 15, "high": 10, "medium": 5, "low": 0}

def _award_score(agent_key, points, reason=""):
    """Award XP to an agent. Returns score info dict."""
    if not agent_key:
        return None
    sd = _load_scores()
    a = sd["agents"].get(agent_key, {"score": 0, "completed": 0, "streak": 0, "lastCompleted": None, "history": []})
    now = datetime.now(timezone.utc)
    # Streak
    last = a.get("lastCompleted")
    if last:
        try:
            last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
            if (now - last_dt) < timedelta(hours=24):
                a["streak"] = a.get("streak", 0) + 1
                points += min(a["streak"] * 5, 25)
            else:
                a["streak"] = 1
        except Exception:
            a["streak"] = 1
    else:
        a["streak"] = 1
    a["score"] = a.get("score", 0) + points
    a["completed"] = a.get("completed", 0) + 1
    a["lastCompleted"] = now.isoformat()
    hist = a.get("history", [])
    hist.append({"points": points, "reason": reason, "at": now.isoformat()})
    a["history"] = hist[-50:]
    sd["agents"][agent_key] = a
    _save_scores(sd)
    return {"agent": agent_key, "points": points, "total": a["score"], "streak": a["streak"]}

def _find_col(project, col_name):
    """Find column by name (case-insensitive partial match). Returns column dict or None."""
    cols = project.get("columns", [])
    name = col_name.lower()
    # Exact match first
    for c in cols:
        if c["title"].lower() == name:
            return c
    # Partial match
    for c in cols:
        if name in c["title"].lower():
            return c
    return None

def _is_done_col(col):
    """Check if a column is a 'done' type."""
    return col.get("title", "").lower() in ("done", "completed", "verified", "published", "fixed")

def _parse_proj_args(args):
    """Parse --key value pairs from args list. Returns (positional, options_dict)."""
    pos = []
    opts = {}
    i = 0
    while i < len(args):
        if args[i].startswith("--") and i + 1 < len(args):
            opts[args[i][2:]] = args[i + 1]
            i += 2
        else:
            pos.append(args[i])
            i += 1
    return pos, opts

def proj_cmd(args):
    """Handle --proj subcommands."""
    if not args:
        print("Usage: --proj <subcommand> ...")
        print("Subcommands: list, create, show, update, delete, add-task, update-task, complete-task, delete-task, comment, tasks, report, scores")
        sys.exit(1)

    sub = args[0]
    rest = args[1:]

    if sub == "list":
        _, opts = _parse_proj_args(rest)
        d = _load_proj()
        projects = d.get("projects", [])
        status_filter = opts.get("status", "")
        if status_filter:
            projects = [p for p in projects if p.get("status") == status_filter]
        if not projects:
            print("📋 No projects found.")
            return
        print(f"📋 {len(projects)} project(s):\n")
        for p in projects:
            tasks = p.get("tasks", [])
            done = sum(1 for t in tasks if t.get("completedAt"))
            print(f"  [{p['id'][:8]}] {p['title']}")
            print(f"    Status: {p.get('status','active')} | Priority: {p.get('priority','medium')} | Tasks: {done}/{len(tasks)}")
            if p.get("dueDate"):
                print(f"    Due: {p['dueDate'][:10]}")
            print()

    elif sub == "create":
        pos, opts = _parse_proj_args(rest)
        title = pos[0] if pos else opts.get("title", "")
        if not title:
            print("Usage: --proj create \"Project Title\" [--desc \"...\"] [--priority high] [--template tpl-software]")
            sys.exit(1)
        template_id = opts.get("template", "")
        now = _now()
        # Build columns from template or default
        if template_id and template_id in _BUILTIN_TEMPLATES:
            tpl = _BUILTIN_TEMPLATES[template_id]
            cols = [{"id": _uid(), "title": c["title"], "color": c["color"], "order": i} for i, c in enumerate(tpl["columns"])]
            tasks = []
            for tt in tpl.get("tasks", []):
                col_id = cols[tt.get("colIdx", 0)]["id"] if tt.get("colIdx", 0) < len(cols) else cols[0]["id"]
                tasks.append({
                    "id": _uid(), "title": tt["title"], "description": "", "columnId": col_id,
                    "order": 0, "priority": tt.get("priority", "medium"),
                    "assignee": None, "assigneeBranch": None, "dueDate": None,
                    "tags": [], "checklist": [], "comments": [], "attachments": [],
                    "createdAt": now, "updatedAt": now, "completedAt": None,
                })
        else:
            cols = _default_columns()
            tasks = []

        project = {
            "id": _uid(), "title": title,
            "description": opts.get("desc", ""),
            "status": "active", "priority": opts.get("priority", "medium"),
            "createdAt": now, "updatedAt": now,
            "dueDate": opts.get("due"),
            "createdBy": opts.get("by", "agent"),
            "tags": [t.strip() for t in opts.get("tags", "").split(",") if t.strip()] if opts.get("tags") else [],
            "branch": opts.get("branch", ""),
            "columns": cols, "tasks": tasks, "activity": [], "template": False,
        }
        d = _load_proj()
        d["projects"].append(project)
        _save_proj(d)
        print(f"✅ Project created: {title}")
        print(f"   ID: {project['id']}")
        print(f"   Columns: {', '.join(c['title'] for c in cols)}")
        if tasks:
            print(f"   Template tasks: {len(tasks)}")

    elif sub == "show":
        if not rest:
            print("Usage: --proj show <project-id>")
            sys.exit(1)
        pid = rest[0]
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        tasks = p.get("tasks", [])
        done = sum(1 for t in tasks if t.get("completedAt"))
        print(f"📋 {p['title']}")
        print(f"   ID: {p['id']}")
        print(f"   Status: {p.get('status')} | Priority: {p.get('priority')} | Tasks: {done}/{len(tasks)}")
        if p.get("description"):
            print(f"   Description: {p['description'][:100]}")
        if p.get("dueDate"):
            print(f"   Due: {p['dueDate'][:10]}")
        print(f"\n   Columns:")
        for col in p.get("columns", []):
            col_tasks = [t for t in tasks if t.get("columnId") == col["id"]]
            print(f"     [{col['title']}] ({len(col_tasks)} tasks)")
            for t in col_tasks:
                status = "✅" if t.get("completedAt") else "○"
                assignee = f" → {t['assignee']}" if t.get("assignee") else ""
                pri = f" [{t.get('priority','')}]" if t.get("priority") else ""
                print(f"       {status} {t['title']}{pri}{assignee}  (id:{t['id'][:8]})")

    elif sub == "update":
        if not rest:
            print("Usage: --proj update <project-id> [--title ...] [--status ...] [--priority ...]")
            sys.exit(1)
        pid = rest[0]
        _, opts = _parse_proj_args(rest[1:])
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        for field in ("title", "status", "priority", "description", "dueDate"):
            key = "desc" if field == "description" else ("due" if field == "dueDate" else field)
            if key in opts:
                p[field] = opts[key]
        p["updatedAt"] = _now()
        _save_proj(d)
        print(f"✅ Project updated: {p['title']}")

    elif sub == "delete":
        if not rest:
            print("Usage: --proj delete <project-id>")
            sys.exit(1)
        pid = rest[0]
        d = _load_proj()
        before = len(d["projects"])
        d["projects"] = [p for p in d["projects"] if not (p["id"] == pid or p["id"].startswith(pid))]
        _save_proj(d)
        print(f"✅ Project deleted" if len(d["projects"]) < before else f"❌ Project not found: {pid}")

    elif sub == "add-task":
        if len(rest) < 2:
            print("Usage: --proj add-task <project-id> \"Task title\" [--col \"To Do\"] [--priority high] [--assign agent] [--due 2026-04-15]")
            sys.exit(1)
        pid = rest[0]
        pos, opts = _parse_proj_args(rest[1:])
        title = pos[0] if pos else ""
        if not title:
            print("Task title required")
            sys.exit(1)
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        # Find column
        col_name = opts.get("col", "Backlog")
        col = _find_col(p, col_name)
        if not col:
            col = p["columns"][0] if p["columns"] else None
            if not col:
                print("❌ No columns in project")
                sys.exit(1)
        now = _now()
        due = opts.get("due")
        if due and "T" not in due:
            due = due + "T00:00:00Z"
        task = {
            "id": _uid(), "title": title, "description": opts.get("desc", ""),
            "columnId": col["id"], "order": len([t for t in p["tasks"] if t.get("columnId") == col["id"]]),
            "priority": opts.get("priority", "medium"),
            "assignee": opts.get("assign"), "assigneeBranch": None,
            "dueDate": due, "tags": [t.strip() for t in opts.get("tags", "").split(",") if t.strip()] if opts.get("tags") else [],
            "checklist": [], "comments": [], "attachments": [],
            "createdAt": now, "updatedAt": now, "completedAt": None,
        }
        p["tasks"].append(task)
        p["updatedAt"] = now
        _save_proj(d)
        print(f"✅ Task added to [{col['title']}]: {title}")
        print(f"   ID: {task['id']}")
        if task.get("assignee"):
            print(f"   Assigned: {task['assignee']}")

    elif sub == "update-task":
        if len(rest) < 2:
            print("Usage: --proj update-task <project-id> <task-id> [--title ...] [--priority ...] [--assign ...] [--col ...]")
            sys.exit(1)
        pid = rest[0]
        tid = rest[1]
        _, opts = _parse_proj_args(rest[2:])
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        task = next((t for t in p["tasks"] if t["id"] == tid or t["id"].startswith(tid)), None)
        if not task:
            print(f"❌ Task not found: {tid}")
            sys.exit(1)
        # Update fields
        if "title" in opts:
            task["title"] = opts["title"]
        if "priority" in opts:
            task["priority"] = opts["priority"]
        if "assign" in opts:
            task["assignee"] = opts["assign"]
        if "desc" in opts:
            task["description"] = opts["desc"]
        if "due" in opts:
            due = opts["due"]
            if due and "T" not in due:
                due = due + "T00:00:00Z"
            task["dueDate"] = due
        if "col" in opts:
            col = _find_col(p, opts["col"])
            if col:
                old_col_id = task.get("columnId")
                task["columnId"] = col["id"]
                # Check for completion
                if _is_done_col(col) and not task.get("completedAt"):
                    task["completedAt"] = _now()
                    if task.get("assignee"):
                        pts = SCORE_BASE + SCORE_PRIORITY.get(task.get("priority", "medium"), 0)
                        if task.get("dueDate"):
                            try:
                                due_dt = datetime.fromisoformat(task["dueDate"].replace("Z", "+00:00"))
                                if datetime.now(timezone.utc) <= due_dt:
                                    pts += 10
                            except Exception:
                                pass
                        chk_done = sum(1 for c in task.get("checklist", []) if c.get("done"))
                        pts += chk_done * 2
                        result = _award_score(task["assignee"], pts, f"Completed: {task['title']}")
                        if result:
                            print(f"🏆 {result['agent']} earned +{result['points']} XP (total: {result['total']}, streak: 🔥{result['streak']})")
                elif not _is_done_col(col) and task.get("completedAt"):
                    task["completedAt"] = None
        task["updatedAt"] = _now()
        p["updatedAt"] = _now()
        _save_proj(d)
        print(f"✅ Task updated: {task['title']}")

    elif sub == "complete-task":
        if len(rest) < 2:
            print("Usage: --proj complete-task <project-id> <task-id>")
            sys.exit(1)
        pid = rest[0]
        tid = rest[1]
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        task = next((t for t in p["tasks"] if t["id"] == tid or t["id"].startswith(tid)), None)
        if not task:
            print(f"❌ Task not found: {tid}")
            sys.exit(1)
        if task.get("completedAt"):
            print(f"⚠️ Task already completed")
            sys.exit(0)
        # Move to first done column
        done_col = next((c for c in p.get("columns", []) if _is_done_col(c)), None)
        if done_col:
            task["columnId"] = done_col["id"]
        task["completedAt"] = _now()
        task["updatedAt"] = _now()
        p["updatedAt"] = _now()
        # Score
        if task.get("assignee"):
            pts = SCORE_BASE + SCORE_PRIORITY.get(task.get("priority", "medium"), 0)
            if task.get("dueDate"):
                try:
                    due_dt = datetime.fromisoformat(task["dueDate"].replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) <= due_dt:
                        pts += 10
                except Exception:
                    pass
            chk_done = sum(1 for c in task.get("checklist", []) if c.get("done"))
            pts += chk_done * 2
            result = _award_score(task["assignee"], pts, f"Completed: {task['title']}")
            if result:
                print(f"🏆 {result['agent']} earned +{result['points']} XP (total: {result['total']}, streak: 🔥{result['streak']})")
        _save_proj(d)
        print(f"✅ Task completed: {task['title']}")

    elif sub == "delete-task":
        if len(rest) < 2:
            print("Usage: --proj delete-task <project-id> <task-id>")
            sys.exit(1)
        pid = rest[0]
        tid = rest[1]
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        before = len(p["tasks"])
        p["tasks"] = [t for t in p["tasks"] if not (t["id"] == tid or t["id"].startswith(tid))]
        p["updatedAt"] = _now()
        _save_proj(d)
        print(f"✅ Task deleted" if len(p["tasks"]) < before else f"❌ Task not found: {tid}")

    elif sub == "comment":
        if len(rest) < 3:
            print("Usage: --proj comment <project-id> <task-id> \"Comment text\" [--author agent-key]")
            sys.exit(1)
        pid = rest[0]
        tid = rest[1]
        pos, opts = _parse_proj_args(rest[2:])
        text = pos[0] if pos else ""
        if not text:
            print("Comment text required")
            sys.exit(1)
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        task = next((t for t in p["tasks"] if t["id"] == tid or t["id"].startswith(tid)), None)
        if not task:
            print(f"❌ Task not found: {tid}")
            sys.exit(1)
        if not isinstance(task.get("comments"), list):
            task["comments"] = []
        task["comments"].append({
            "id": _uid(), "author": opts.get("author", "agent"),
            "text": text, "createdAt": _now(),
        })
        task["updatedAt"] = _now()
        _save_proj(d)
        print(f"💬 Comment added to: {task['title']}")

    elif sub == "tasks":
        if not rest:
            print("Usage: --proj tasks <project-id> [--col \"In Progress\"]")
            sys.exit(1)
        pid = rest[0]
        _, opts = _parse_proj_args(rest[1:])
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        tasks = p.get("tasks", [])
        col_filter = opts.get("col", "")
        if col_filter:
            col = _find_col(p, col_filter)
            if col:
                tasks = [t for t in tasks if t.get("columnId") == col["id"]]
                print(f"📋 Tasks in [{col['title']}] — {p['title']}:\n")
            else:
                print(f"❌ Column not found: {col_filter}")
                sys.exit(1)
        else:
            print(f"📋 All tasks — {p['title']}:\n")
        if not tasks:
            print("  (no tasks)")
            return
        for t in tasks:
            status = "✅" if t.get("completedAt") else "○"
            assignee = f" → {t['assignee']}" if t.get("assignee") else ""
            pri = f" [{t.get('priority','')}]" if t.get("priority") else ""
            col = next((c["title"] for c in p.get("columns", []) if c["id"] == t.get("columnId")), "?")
            due = f" 📅{t['dueDate'][:10]}" if t.get("dueDate") else ""
            print(f"  {status} {t['title']}{pri}{assignee}{due}  ({col})  id:{t['id'][:8]}")

    elif sub == "report":
        if not rest:
            print("Usage: --proj report <project-id>")
            sys.exit(1)
        pid = rest[0]
        d = _load_proj()
        p = next((x for x in d["projects"] if x["id"] == pid or x["id"].startswith(pid)), None)
        if not p:
            print(f"❌ Project not found: {pid}")
            sys.exit(1)
        tasks = p.get("tasks", [])
        total = len(tasks)
        done = sum(1 for t in tasks if t.get("completedAt"))
        now = datetime.now(timezone.utc)
        overdue = 0
        for t in tasks:
            if t.get("dueDate") and not t.get("completedAt"):
                try:
                    due = datetime.fromisoformat(t["dueDate"].replace("Z", "+00:00"))
                    if due < now:
                        overdue += 1
                except Exception:
                    pass
        pct = round(done / total * 100) if total else 0
        print(f"📊 Report: {p['title']}")
        print(f"   Progress: {done}/{total} ({pct}%)")
        print(f"   Overdue: {overdue}")
        print(f"\n   By Column:")
        for col in p.get("columns", []):
            col_tasks = [t for t in tasks if t.get("columnId") == col["id"]]
            bar = "█" * len(col_tasks) + "░" * (max(0, 10 - len(col_tasks)))
            print(f"     {col['title']:<16} {bar} {len(col_tasks)}")
        # Agent workload
        agents = {}
        for t in tasks:
            a = t.get("assignee") or "unassigned"
            agents[a] = agents.get(a, 0) + 1
        if agents:
            print(f"\n   By Agent:")
            for a, count in sorted(agents.items(), key=lambda x: -x[1]):
                print(f"     {a:<16} {count} tasks")

    elif sub == "scores":
        sd = _load_scores()
        agents = sorted(sd.get("agents", {}).items(), key=lambda x: -x[1].get("score", 0))
        if not agents:
            print("🏆 No scores yet — complete tasks to earn XP!")
            return
        print("🏆 Leaderboard:\n")
        for i, (key, info) in enumerate(agents[:10]):
            rank = ["👑", "🥈", "🥉"][i] if i < 3 else f"#{i+1}"
            streak = f" 🔥{info['streak']}" if info.get("streak", 0) > 1 else ""
            print(f"  {rank} {key:<16} {info['score']:>5} XP  ({info.get('completed',0)} tasks){streak}")

    else:
        print(f"Unknown subcommand: {sub}")
        print("Use: list, create, show, update, delete, add-task, update-task, complete-task, delete-task, comment, tasks, report, scores")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    data = load()

    if sys.argv[1] == "--proj":
        proj_cmd(sys.argv[2:])
        sys.exit(0)

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
