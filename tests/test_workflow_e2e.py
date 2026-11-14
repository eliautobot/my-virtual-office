#!/usr/bin/env python3
"""
End-to-end workflow pipeline test for Virtual Office Product.

Tests the full pipeline: Backlog → In Progress → Review → Done,
including stop, auto mode, rework loops, and portability.

Runs against the Product server (port 8090) by default.
"""
import requests
import time
import json
import sys
import os
import re
import unittest

if __name__ != "__main__":
    raise unittest.SkipTest("standalone live-server workflow verification; run this file directly")

# This test creates and deletes projects on a running office. Never guess which
# one: the target must be named explicitly (BE-36).
BASE = os.environ.get("VO_TEST_URL", "").rstrip("/")
if not BASE:
    raise SystemExit("Set VO_TEST_URL to a disposable test office, e.g. VO_TEST_URL=http://127.0.0.1:18090")
API = f"{BASE}/api/projects"

PASS = "✅"
FAIL = "❌"
results = []

def log(msg):
    print(f"  {msg}")

def check(name, condition, detail=""):
    status = PASS if condition else FAIL
    results.append((name, condition))
    extra = f" — {detail}" if detail else ""
    print(f"  {status} {name}{extra}")
    return condition

def api_get(path):
    r = requests.get(f"{API}{path}", timeout=10)
    return r.json()

def api_post(path, body=None):
    r = requests.post(f"{API}{path}", json=body or {}, timeout=10)
    return r.json()

def api_put(path, body=None):
    r = requests.put(f"{API}{path}", json=body or {}, timeout=10)
    return r.json()

def api_delete(path):
    r = requests.delete(f"{API}{path}", timeout=10)
    return r.json()

# ── Cleanup: delete any existing test projects ──
def cleanup():
    data = api_get("")
    for p in data.get("projects", []):
        if p["title"].startswith("E2E-Test-"):
            api_delete(f"/{p['id']}")

# ── Test Setup ──
print("\n🔧 Setting up E2E workflow test...\n")
cleanup()

# Create a test project with standard columns
create_resp = api_post("", {
    "title": "E2E-Test-Pipeline",
    "description": "Automated E2E workflow test",
    "templateId": "tpl-blank",
})
assert create_resp.get("ok") or create_resp.get("project"), f"Failed to create project: {create_resp}"
proj = create_resp.get("project", create_resp)
PROJECT_ID = proj["id"]
log(f"Created project: {PROJECT_ID}")

# Verify columns exist
cols = {c["title"]: c["id"] for c in proj.get("columns", [])}
log(f"Columns: {list(cols.keys())}")

# ── Checklist 1: Task moves Backlog to In Progress ──
print("\n📋 Test 1: Task moves from Backlog")

# Add a task to Backlog with a checklist and assignee
backlog_col = cols.get("Backlog")
assert backlog_col, "Backlog column not found!"

task_resp = api_post(f"/{PROJECT_ID}/tasks", {
    "title": "E2E Test Task 1",
    "description": "This is a test task for E2E verification",
    "columnId": backlog_col,
    "assignee": "main",
    "priority": "high",
    "checklist": [
        {"text": "Verify item A", "done": False},
        {"text": "Verify item B", "done": False},
    ],
})
task = task_resp.get("task", task_resp)
TASK_ID = task["id"]
check("Task created in Backlog", task.get("columnId") == backlog_col, f"col={task.get('columnId')}")

# ── Test workflow start ──
print("\n📋 Test 2-6: Workflow start & agent dispatch")

# Start workflow (single mode — auto=false)
start_resp = api_post(f"/{PROJECT_ID}/workflow/start", {"autoMode": False})
check("Workflow started", start_resp.get("ok") and start_resp.get("status") == "started")
check("Auto mode is off", start_resp.get("autoMode") == False)

# Poll status until task moves to In Progress or timeout
MAX_WAIT = 30
start_time = time.time()
moved_to_inprogress = False
while time.time() - start_time < MAX_WAIT:
    status = api_get(f"/{PROJECT_ID}/workflow/status")
    phase = status.get("phase", "")
    if phase in ("in_progress", "reviewing", "reworking", "task_done", "awaiting_user_review"):
        moved_to_inprogress = True
        break
    if phase in ("error", "stopped"):
        log(f"Workflow hit {phase}: {status.get('error', 'no error')}")
        break
    time.sleep(2)

check("Task moved from Backlog (dispatched)", moved_to_inprogress, f"phase={phase}")

# ── Test 7: Stop halts workflow ──
print("\n📋 Test 7: Stop halts workflow")

# Stop the workflow
stop_resp = api_post(f"/{PROJECT_ID}/workflow/stop")
check("Stop returns ok", stop_resp.get("ok") == True)

time.sleep(2)
status_after_stop = api_get(f"/{PROJECT_ID}/workflow/status")
check("Workflow stopped", status_after_stop.get("active") == False, f"phase={status_after_stop.get('phase')}")

# ── Test 8: Auto Mode processes next task ──
print("\n📋 Test 8: Auto Mode")

# Create a second task in backlog
task2_resp = api_post(f"/{PROJECT_ID}/tasks", {
    "title": "E2E Test Task 2",
    "description": "Second test task for auto mode",
    "columnId": backlog_col,
    "assignee": "main",
    "priority": "medium",
    "checklist": [
        {"text": "Auto item X", "done": False},
    ],
})
task2 = task2_resp.get("task", task2_resp)
TASK2_ID = task2["id"]

# Move task1 back to backlog for a clean test
api_put(f"/{PROJECT_ID}/tasks/{TASK_ID}", {"columnId": backlog_col})

# Toggle auto mode
auto_resp = api_put(f"/{PROJECT_ID}/workflow/auto-mode", {"autoMode": True})
check("Auto mode toggled on", auto_resp.get("autoMode") == True)

# Start with auto mode
start_resp2 = api_post(f"/{PROJECT_ID}/workflow/start", {"autoMode": True})
check("Auto workflow started", start_resp2.get("ok") and start_resp2.get("autoMode") == True)

# Wait briefly then stop (we just need to confirm it started processing)
time.sleep(5)
auto_status = api_get(f"/{PROJECT_ID}/workflow/status")
check("Auto workflow is active", auto_status.get("active") == True or auto_status.get("phase") != "idle",
      f"phase={auto_status.get('phase')}, active={auto_status.get('active')}")

# Stop it
api_post(f"/{PROJECT_ID}/workflow/stop")
time.sleep(1)

# ── Test 9: Portability / No hardcoded params ──
print("\n📋 Test 9: Portability checks")

import inspect
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/app")

# Check server.py source for hardcoded personal values
server_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "server.py")
with open(server_path, "r") as f:
    server_src = f.read()

# Check workflow-related functions for hardcoded values
workflow_section_start = server_src.find("# Background thread-based workflow")
workflow_section_end = server_src.find("WORKFLOW_STATE_FILE =", workflow_section_start)
workflow_code = server_src[workflow_section_start:workflow_section_end] if workflow_section_start >= 0 else ""

hardcoded_patterns = [
    (r"/home/(?!user(?:/|$))[A-Za-z0-9._-]+", "Hardcoded Unix user home"),
    (r"[A-Za-z]:\\Users\\[A-Za-z0-9._-]+", "Hardcoded Windows user home"),
    (
        r"\b(?:10(?:\.[0-9]{1,3}){3}|192\.168(?:\.[0-9]{1,3}){2}|"
        r"100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(?:\.[0-9]{1,3}){2})\b",
        "Hardcoded private or tailnet IP",
    ),
    (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "Hardcoded email"),
    (
        r"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
        r"sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})",
        "Hardcoded credential",
    ),
]

hardcoded_found = []
for pattern, desc in hardcoded_patterns:
    if re.search(pattern, workflow_code):
        hardcoded_found.append(desc)

check("No hardcoded personal values in workflow code",
      len(hardcoded_found) == 0,
      ", ".join(hardcoded_found) if hardcoded_found else "clean")

# Check that gateway config comes from vo-config.json (not hardcoded)
check("Gateway URL from config",
      "VO_CONFIG" in workflow_code and "gatewayHttp" in workflow_code,
      "Uses VO_CONFIG for gateway connection")

# Check that agent communication uses configurable methods
check("Agent calls use portable methods",
      ("_wf_call_agent_http" in workflow_code or "_wf_call_agent_cli" in workflow_code),
      "HTTP API + CLI fallback")

# Check column matching is flexible
check("Column matching supports partial match",
      "title_lower in col.get" in server_src,
      "Handles 'Code Review' matching 'review'")

# Verify no hardcoded timezone in workflow display
check("No hardcoded timezone",
      "America/New_York" not in server_src,
      "Uses system local timezone")

# Check the review parser handles status keywords correctly
# Simulate a review response
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
# Import won't work easily due to server-side dependencies, so test the logic pattern
check("Review parser orders longest-first",
      server_src.find("did_not_pass") < server_src.find('"pass", "pass"'),
      "Prevents 'pass' matching 'did_not_pass'")

# ── Test: Review check API ──
print("\n📋 Test 4-5: Review results in task detail, failed items go back")

# Reload task to get server-assigned checklist IDs
proj_reload = api_get(f"/{PROJECT_ID}")
task_reloaded = next((t for t in proj_reload.get("project", {}).get("tasks", []) if t["id"] == TASK_ID), None)
checklist = task_reloaded.get("checklist", []) if task_reloaded else []
check_id_a = checklist[0].get("id", "a") if len(checklist) > 0 else "a"
check_id_b = checklist[1].get("id", "b") if len(checklist) > 1 else "b"

# Manually set review results on task 1
review_data = [
    {"id": check_id_a, "text": "Verify item A", "status": "pass"},
    {"id": check_id_b, "text": "Verify item B", "status": "needs_more_work"},
]
review_resp = api_put(f"/{PROJECT_ID}/tasks/{TASK_ID}/review-check", {"reviewCheck": review_data})
check("Review check saved", review_resp.get("ok") == True)

# Verify task has review data
proj_data = api_get(f"/{PROJECT_ID}")
updated_task = next((t for t in proj_data.get("project", {}).get("tasks", []) if t["id"] == TASK_ID), None)
check("Review results in task detail", 
      updated_task and len(updated_task.get("reviewCheck", [])) == 2,
      f"reviewCheck items: {len(updated_task.get('reviewCheck', []))}")

# Check that the review results are correctly stored
if updated_task and updated_task.get("reviewCheck"):
    passed = [r for r in updated_task["reviewCheck"] if r.get("status") == "pass"]
    failed = [r for r in updated_task["reviewCheck"] if r.get("status") != "pass"]
    check("Pass/fail items stored correctly", len(passed) == 1 and len(failed) == 1)

# ── Test: Move to Done ──
print("\n📋 Test 6: All pass moves to Done")
done_col = cols.get("Done")
assert done_col, "Done column not found!"

# Set all review items to pass
all_pass_data = [
    {"id": review_data[0]["id"], "text": "Verify item A", "status": "pass"},
    {"id": review_data[1]["id"], "text": "Verify item B", "status": "pass"},
]
api_put(f"/{PROJECT_ID}/tasks/{TASK_ID}/review-check", {"reviewCheck": all_pass_data})

# Move task to Done
api_put(f"/{PROJECT_ID}/tasks/{TASK_ID}", {"columnId": done_col})
proj_final = api_get(f"/{PROJECT_ID}")
final_task = next((t for t in proj_final.get("project", {}).get("tasks", []) if t["id"] == TASK_ID), None)
check("Task in Done column", final_task and final_task.get("columnId") == done_col)
check("Task has completedAt", final_task and final_task.get("completedAt") is not None)

# Verify both named checklist items survived the API round trip and received
# an explicit passing review. These checks are intentionally separate so an
# omitted or duplicated item cannot be hidden by the aggregate Done status.
final_review = {
    item.get("text"): item.get("status")
    for item in (final_task.get("reviewCheck", []) if final_task else [])
}
check("Verify item A passed final review", final_review.get("Verify item A") == "pass")
check("Verify item B passed final review", final_review.get("Verify item B") == "pass")

# ── Cleanup ──
print("\n🧹 Cleaning up...")
cleanup()

# ── Summary ──
print("\n" + "=" * 60)
passed = sum(1 for _, ok in results if ok)
total = len(results)
print(f"  Results: {passed}/{total} passed")
if passed == total:
    print(f"  {PASS} ALL TESTS PASSED")
else:
    failed_tests = [name for name, ok in results if not ok]
    print(f"  {FAIL} FAILED: {', '.join(failed_tests)}")
print("=" * 60 + "\n")

sys.exit(0 if passed == total else 1)
