"""Calls server.py makes at its own write sites (design 1.3 item 6).

server.py calls these through ``_life_hook(name, **fields)``, which never lets an error reach the
request. Every hook is thin: it turns structured office data into one OfficeEvent and publishes
it on the bus; it never reads message text. These are provider-neutral: they fire for every agent
whatever its provider, because the office itself made the change.

Contract (all agent ids are office ids or status keys; times are ISO strings or ms):
- ``task_done(agent, task_id, title, project_id, points, completed_at, by)`` a task reached a done
  column (``agent`` may be empty for an unassigned task; ``points`` 0 when none were awarded).
- ``xp_awarded(agent, points, total, reason, at)`` ``_award_points`` saved; ``reason`` is
  ``task`` (a completed task) or ``manual`` (the score award API).
- ``project_status(project_id, title, old, new, agents, by)`` a project's status changed;
  ``agents`` = the distinct assignees of its tasks.
- ``a2a_sent(sender, target, ref, conversation)`` an office agent sent another office agent a
  message through agent-platform communications (``ref`` = the request message id).
- ``task_assigned(task_id, title, project_id, old, new, by)`` a task's assignee changed;
  ``by`` is the actor the API was given (an office agent id, ``user``, ``workflow`` ...).
"""

import datetime

DONE_STATUSES = frozenset({"completed", "complete", "done"})


def _ctx():
    from . import CTX
    return CTX


def _key(ctx, office_id):
    """The status key of an office agent (a switched legacy agent keeps its own)."""
    office_id = str(office_id or "").strip()
    if not office_id or office_id.lower() in ("null", "none", "unassigned", "user", "workflow", "system"):
        return ""
    return str(ctx.call("status_key", office_id, default=office_id) or office_id)


def _ms(value):
    """ISO string, seconds or ms -> epoch ms (None when unreadable)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp() * 1000)


def _publish(ctx, event):
    event = {k: v for k, v in event.items() if v is not None}
    return ctx.bus.publish(event)


def task_done(agent=None, task_id=None, title=None, project_id=None, points=0, completed_at=None, by=None,
              **_extra):
    ctx = _ctx()
    key = _key(ctx, agent)
    if not key or not task_id:
        return None
    return _publish(ctx, {"type": "task.done", "agent": key, "provider": "office", "ref": str(task_id),
                          "taskId": str(task_id), "title": title, "projectId": project_id,
                          "points": int(points or 0) if isinstance(points, (int, float)) else 0,
                          "at": _ms(completed_at)})


def xp_awarded(agent=None, points=0, total=0, reason="task", at=None, **_extra):
    ctx = _ctx()
    key = _key(ctx, agent)
    if not key or not isinstance(points, (int, float)) or not points:
        return None
    return _publish(ctx, {"type": "xp", "agent": key, "provider": "office", "ref": str(at or "") or None,
                          "points": int(points), "total": int(total) if isinstance(total, (int, float)) else None,
                          "reason": "manual" if reason == "manual" else "task", "at": _ms(at)})


def project_status(project_id=None, title=None, old=None, new=None, agents=None, by=None, **_extra):
    if str(new or "").lower() not in DONE_STATUSES or str(old or "").lower() in DONE_STATUSES or not project_id:
        return None
    ctx = _ctx()
    keys = []
    for agent in agents if isinstance(agents, (list, tuple, set)) else []:
        key = _key(ctx, agent)
        if key and key not in keys:
            keys.append(key)
    return _publish(ctx, {"type": "project.done", "provider": "office", "ref": str(project_id), "title": title,
                          "agents": keys})


def a2a_sent(sender=None, target=None, ref=None, conversation=None, **_extra):
    ctx = _ctx()
    if not ctx.feature("handoffs"):
        return None
    sender_key, target_key = _key(ctx, sender), _key(ctx, target)
    if not sender_key or not target_key or sender_key == target_key:
        return None
    return _publish(ctx, {"type": "handoff", "agent": sender_key, "to": target_key, "via": "a2a",
                          "provider": "office", "ref": str(ref) if ref else None})


def task_assigned(task_id=None, title=None, project_id=None, old=None, new=None, by=None, **_extra):
    """A handoff only when an office agent (not the person, not a workflow) gave the task to
    another office agent."""
    ctx = _ctx()
    if not ctx.feature("handoffs"):
        return None
    actor, assignee = _key(ctx, by), _key(ctx, new)
    if not actor or not assignee or actor == assignee:
        return None
    visible = ctx.visible_keys()
    if visible is not None and actor not in visible:
        return None
    return _publish(ctx, {"type": "handoff", "agent": actor, "to": assignee, "via": "task", "provider": "office",
                          "ref": f"task:{task_id}" if task_id else None})
