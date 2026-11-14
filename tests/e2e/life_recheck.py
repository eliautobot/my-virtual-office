#!/usr/bin/env python3
"""Office life QA re-check (life-qa2) on the PRIVATE stack only (tests/tools/life-e2e.sh, LIFE_E2E_ROOT/env).

Targets the first QA's FAILs that tests/test_life_e2e.py does not pin down exactly:
  1. a serve-only office (no Hermes CLI visible to the server) shows the `hermes serve` agents with their own state
  2. project.done credits only the assignees of DONE tasks (an agent with only an open task gets nothing)
  3. one OpenClaw cron run (session.task runtime cron + the cron subscription, both orders) = one cron.fire + one cron.done
One PASS/FAIL line per check; exit 1 on any FAIL. Never point this at a real office or gateway.
Re-runs wait out each agent's 90 s alarm window first (sources.py CRON_GAP_S: one alarm clock per agent per 90 s).
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import test_life_e2e as L  # noqa: E402  (reads LIFE_E2E_ROOT/env; refuses nothing by itself, so check the URL)

RESULTS = []


def check(name, ok, evidence=""):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'} {name}: {str(evidence)[:220]}", flush=True)


def serve_only():
    health = (L.api("/api/office/providers")[1].get("providers") or {})
    rows = health if isinstance(health, list) else list(health.values()) if isinstance(health, dict) else []
    herm = next((r for r in rows if isinstance(r, dict) and r.get("id") == "hermes"), {})
    err = ((herm.get("health") or {}).get("error") or "")
    status = L.api("/status")[1]
    serve = {k: v for k, v in status.items() if k.startswith(L.HERMES) and isinstance(v, dict)}
    states = {k: (v.get("state"), v.get("source")) for k, v in serve.items()}
    check("serve-only: no Hermes CLI is visible to the server", "not found" in err.lower(), err)
    check("serve-only: every `hermes serve` agent keeps its own state (none offline, none from provider-health)",
          bool(serve) and all(s != "offline" and src != "provider-health" for s, src in states.values()),
          json.dumps(states))


def project_done():
    code, proj = L.api("/api/projects", {"title": "Re-check credit", "createdBy": "user"})
    proj = proj.get("project") or proj
    pid = proj["id"]
    cols = proj.get("columns", [])
    done_col = [c["id"] for c in cols if c.get("title", "").lower() in ("done", "completed")][0]
    stream = L.Stream()
    try:
        tids = []
        for title, who in (("Ship it", L.QUILL), ("Still open", "ops")):
            _c, t = L.api(f"/api/projects/{pid}/tasks", {"title": title, "assignee": who})
            tids.append((t.get("task") or t)["id"])
        L.api(f"/api/projects/{pid}/tasks/{tids[0]}", {"columnId": done_col, "by": "user"}, method="PUT")
        stream.wait("task.done", 10, agent=L.QUILL)
        L.api(f"/api/projects/{pid}", {"status": "completed"}, method="PUT")
        pd = stream.wait("project.done", 10)
        agents = (pd[-1].get("agents") if pd else None) or []
        check("project.done credits the done-task assignee and not the agent with only an open task",
              bool(pd) and L.QUILL in agents and "ops" not in agents, json.dumps(pd)[:200])
    finally:
        stream.close()


def wait_alarm_window(agent, gap=91.0):
    """Wait until the agent's last cron.fire in today's journal is older than CRON_GAP_S (90 s)."""
    rows = L.api("/api/office-life/journal?kinds=cron.fire")[1].get("rows") or []
    last = max([r.get("at") or 0 for r in rows if r.get("agent") == agent] or [0]) / 1000.0
    left = gap - (time.time() - last)
    if left > 0:
        print(f"(waiting {left:.0f} s for {agent}'s alarm window)", flush=True)
        time.sleep(left)


def cron_one_done(order, agent):
    # (one agent per order: sources.py CRON_GAP_S allows one alarm clock per agent per 90 s by design)
    wait_alarm_window(agent)
    job_id = f"rc-{order}-{int(time.time())}"
    job = {"id": job_id, "name": f"Re-check {order}", "agentId": agent}

    def task(status):
        L.emit("task", {"action": "upserted", "task": {"id": f"run-{job_id}", "runtime": "cron", "status": status,
                                                         "agentId": agent, "sessionKey": f"agent:{agent}:main",
                                                         "sourceId": job_id}})

    def cron(action, **extra):
        L.emit("cron", {"action": action, "jobId": job_id, "runAtMs": 4321, "job": job, **extra})

    stream = L.Stream()
    try:
        if order == "task-first":
            task("running"); cron("started"); task("succeeded"); cron("finished", status="ok")
        else:
            cron("started"); task("running"); cron("finished", status="ok"); task("succeeded")
        stream.wait("cron.done", 10, agent=agent)
        time.sleep(3)  # leave room for a second (duplicate) done frame
        # (this run only: any ref naming the job, so a "task:<id>" duplicate still counts; other runs are ignored)
        mine = [(e["type"], e.get("ref")) for e in stream.frames
                if e.get("type", "").startswith("cron.") and e.get("agent") == agent and job_id in str(e.get("ref"))]
        fires = [m for m in mine if m[0] == "cron.fire"]
        dones = [m for m in mine if m[0] == "cron.done"]
        check(f"cron ({order}): one run -> exactly 1 cron.fire + 1 cron.done, same ref",
              len(fires) == 1 and len(dones) == 1 and dones[0][1] == fires[0][1], json.dumps(mine))
    finally:
        stream.close()


def main():
    if not L.VO.startswith("http://127.0.0.1:") or L.VO.endswith(":8096") or not L.CTL:
        sys.exit(f"refusing: VO_URL {L.VO!r} / gateway ctl {L.CTL!r} is not the private stack")
    serve_only()
    project_done()
    cron_one_done("task-first", "ops")
    cron_one_done("subscription-first", "main")
    print(f"recheck: {sum(RESULTS)} PASS / {len(RESULTS) - sum(RESULTS)} FAIL", flush=True)
    sys.exit(0 if all(RESULTS) else 1)


if __name__ == "__main__":
    main()
