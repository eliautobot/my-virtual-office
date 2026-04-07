import copy
import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

PROJECTS_DIRNAME = "projects-md"
LEGACY_PROJECTS_FILENAME = "projects.json"
COMPLEX_JSON_FIELDS = {"columns_json", "templates_json", "reviewCheck_json", "lastReviewCheck_json", "checklist_json", "tags_json", "attachments_json"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return str(uuid.uuid4())


def _slugify(value: str, fallback: str = "item") -> str:
    s = (value or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s or fallback


def _yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text == "":
        return '""'
    if re.match(r"^[A-Za-z0-9_.:/@# +\-]+$", text) and text.lower() not in {"true", "false", "null"}:
        return text
    return json.dumps(text, ensure_ascii=False)


def _dump_frontmatter(data: Dict[str, Any]) -> str:
    lines: List[str] = ["---"]
    for key, value in data.items():
        if key in COMPLEX_JSON_FIELDS:
            lines.append(f"{key}: {json.dumps(value, ensure_ascii=False, separators=(',', ':'))}")
        else:
            lines.append(f"{key}: {_yaml_scalar(value)}")
    lines.append("---")
    return "\n".join(lines)


def _parse_scalar(text: str) -> Any:
    text = text.strip()
    if text in ("null", "~"):
        return None
    if text == "true":
        return True
    if text == "false":
        return False
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(part.strip()) for part in inner.split(",")]
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        try:
            return json.loads(text)
        except Exception:
            return text[1:-1]
    if re.fullmatch(r"-?\d+", text):
        try:
            return int(text)
        except Exception:
            pass
    if re.fullmatch(r"-?\d+\.\d+", text):
        try:
            return float(text)
        except Exception:
            pass
    return text


def _parse_frontmatter(text: str) -> Tuple[Dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 5 :]
    lines = raw.splitlines()
    result: Dict[str, Any] = {}
    for line in lines:
        if not line.strip() or ":" not in line:
            continue
        key, rest = line.split(":", 1)
        key = key.strip()
        rest = rest.strip()
        if key in COMPLEX_JSON_FIELDS:
            try:
                result[key] = json.loads(rest) if rest else None
            except Exception:
                result[key] = None
        else:
            result[key] = _parse_scalar(rest)
    return result, body.lstrip("\n")


def _atomic_write(path: str, content: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o666)
    except Exception:
        pass


class MarkdownProjectStore:
    def __init__(self, status_dir: str):
        self.status_dir = status_dir
        self.projects_dir = os.path.join(status_dir, PROJECTS_DIRNAME)
        self.legacy_json = os.path.join(status_dir, LEGACY_PROJECTS_FILENAME)
        self.lock = threading.Lock()
        os.makedirs(self.projects_dir, exist_ok=True)

    def now(self) -> str:
        return _now_iso()

    def new_id(self) -> str:
        return _new_id()

    def load_all(self) -> Dict[str, Any]:
        with self.lock:
            self._migrate_legacy_if_needed()
            projects = self._read_all_projects()
            templates: List[Dict[str, Any]] = []
            for p in projects:
                if p.get("template"):
                    templates.append({
                        "id": p.get("id"),
                        "title": p.get("title", ""),
                        "description": p.get("description", ""),
                        "columns": [{"title": c.get("title"), "color": c.get("color", "#6c757d")} for c in p.get("columns", [])],
                        "taskTemplates": [
                            {
                                "title": t.get("title", ""),
                                "columnIndex": next((i for i, c in enumerate(p.get("columns", [])) if c.get("id") == t.get("columnId")), 0),
                                "priority": t.get("priority", "medium"),
                                "tags": t.get("tags", []),
                                "description": t.get("description", ""),
                            }
                            for t in p.get("tasks", [])
                        ],
                    })
            return {"projects": projects, "templates": templates}

    def save_all(self, data: Dict[str, Any]):
        with self.lock:
            self._rewrite_from_dict(data)

    def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        data = self.load_all()
        for p in data.get("projects", []):
            if p.get("id") == project_id:
                return p
        return None

    def delete_project(self, project_id: str) -> bool:
        with self.lock:
            deleted = False
            self._migrate_legacy_if_needed()
            for entry in os.listdir(self.projects_dir):
                project_dir = os.path.join(self.projects_dir, entry)
                project_md = os.path.join(project_dir, "project.md")
                if not os.path.isfile(project_md):
                    continue
                meta, _ = _parse_frontmatter(open(project_md, encoding="utf-8").read())
                if meta.get("id") == project_id:
                    shutil.rmtree(project_dir, ignore_errors=True)
                    deleted = True
                    break

            legacy = {"projects": [], "templates": []}
            if os.path.isfile(self.legacy_json):
                try:
                    with open(self.legacy_json, "r", encoding="utf-8") as f:
                        legacy = json.load(f)
                except Exception:
                    legacy = {"projects": [], "templates": []}

            before_projects = len(legacy.get("projects", []))
            before_templates = len(legacy.get("templates", []))
            legacy["projects"] = [p for p in legacy.get("projects", []) if p.get("id") != project_id]
            legacy["templates"] = [t for t in legacy.get("templates", []) if t.get("id") != project_id]
            if len(legacy["projects"]) != before_projects or len(legacy["templates"]) != before_templates:
                _atomic_write(self.legacy_json, json.dumps(legacy, ensure_ascii=False, indent=2) + "\n")
                deleted = True

            task_dir = os.path.join(self.status_dir, "project-tasks", project_id)
            if os.path.isdir(task_dir):
                shutil.rmtree(task_dir, ignore_errors=True)
                deleted = True

            md_dir = os.path.join(self.projects_dir, _slugify(project_id, fallback=project_id))
            if os.path.isdir(md_dir):
                shutil.rmtree(md_dir, ignore_errors=True)

            return deleted

    def _migrate_legacy_if_needed(self):
        if any(os.scandir(self.projects_dir)):
            return
        if not os.path.isfile(self.legacy_json):
            return
        try:
            with open(self.legacy_json, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return
        self._rewrite_from_dict(data)

    def _rewrite_from_dict(self, data: Dict[str, Any]):
        shutil.rmtree(self.projects_dir, ignore_errors=True)
        os.makedirs(self.projects_dir, exist_ok=True)
        for project in data.get("projects", []):
            self._write_project(project)

    def _project_dir(self, project: Dict[str, Any]) -> str:
        slug = _slugify(project.get("title", "project"))
        pid = project.get("id") or self.new_id()
        return os.path.join(self.projects_dir, f"{slug}--{pid[:8]}")

    def _write_project(self, project: Dict[str, Any]):
        project = copy.deepcopy(project)
        project_dir = self._project_dir(project)
        tasks_dir = os.path.join(project_dir, "tasks")
        os.makedirs(tasks_dir, exist_ok=True)
        tasks = project.pop("tasks", [])
        activity = project.pop("activity", [])
        meta = {
            "id": project.get("id"),
            "title": project.get("title", ""),
            "status": project.get("status", "active"),
            "priority": project.get("priority", "medium"),
            "createdAt": project.get("createdAt"),
            "updatedAt": project.get("updatedAt"),
            "dueDate": project.get("dueDate"),
            "createdBy": project.get("createdBy", "user"),
            "tags_json": project.get("tags", []),
            "branch": project.get("branch", ""),
            "workflowActive": project.get("workflowActive", False),
            "autoMode": project.get("autoMode", False),
            "template": project.get("template", False),
            "columns_json": project.get("columns", []),
            "templates_json": project.get("templates", []),
        }
        body_lines = [
            "# Project",
            project.get("description", "") or "_No description_",
            "",
            "## Activity",
        ]
        if activity:
            for item in activity[-200:]:
                detail = item.get("detail", "")
                by = item.get("by", "user")
                at = item.get("at", "")
                body_lines.append(f"- [{at}] ({by}) {detail}")
        else:
            body_lines.append("- No activity yet")
        _atomic_write(os.path.join(project_dir, "project.md"), _dump_frontmatter(meta) + "\n" + "\n".join(body_lines) + "\n")
        for task in tasks:
            self._write_task_file(tasks_dir, task)

    def _write_task_file(self, tasks_dir: str, task: Dict[str, Any]):
        task = copy.deepcopy(task)
        task_id = task.get("id") or self.new_id()
        title_slug = _slugify(task.get("title", "task"))
        path = os.path.join(tasks_dir, f"{title_slug}--{task_id[:8]}.md")
        comments = task.pop("comments", [])
        attachments = task.pop("attachments", [])
        review_check = task.pop("reviewCheck", None)
        last_review_check = task.pop("lastReviewCheck", None)
        meta = {
            "id": task_id,
            "title": task.get("title", ""),
            "columnId": task.get("columnId"),
            "order": task.get("order", 0),
            "priority": task.get("priority", "medium"),
            "assignee": task.get("assignee"),
            "assigneeBranch": task.get("assigneeBranch"),
            "dueDate": task.get("dueDate"),
            "tags_json": task.get("tags", []),
            "checklist_json": task.get("checklist", []),
            "attachments_json": attachments,
            "reviewCheck_json": review_check or [],
            "lastReviewCheck_json": last_review_check or [],
            "createdAt": task.get("createdAt"),
            "updatedAt": task.get("updatedAt"),
            "completedAt": task.get("completedAt"),
        }
        body_lines = [
            "## Description",
            task.get("description", "") or "_No description_",
            "",
            "## Comments",
        ]
        if comments:
            for comment in comments:
                body_lines.append(f"### {comment.get('author', 'user')} — {comment.get('createdAt', '')}")
                body_lines.append(comment.get("text", ""))
                body_lines.append("")
        else:
            body_lines.append("No comments yet")
        body_lines.extend(["", "## Attachments"])
        if attachments:
            for att in attachments:
                body_lines.append(f"- {att}")
        else:
            body_lines.append("No attachments")
        if review_check:
            body_lines.extend(["", "## Review Check"])
            for item in review_check:
                body_lines.append(f"- {item.get('status', 'pending')}: {item.get('text', '')}")
        if last_review_check:
            body_lines.extend(["", "## Last Review Check"])
            for item in last_review_check:
                body_lines.append(f"- {item.get('status', 'pending')}: {item.get('text', '')}")
        _atomic_write(path, _dump_frontmatter(meta) + "\n" + "\n".join(body_lines).rstrip() + "\n")

    def _read_all_projects(self) -> List[Dict[str, Any]]:
        projects: List[Dict[str, Any]] = []
        for entry in sorted(os.listdir(self.projects_dir)):
            project_dir = os.path.join(self.projects_dir, entry)
            project_md = os.path.join(project_dir, "project.md")
            if not os.path.isfile(project_md):
                continue
            try:
                projects.append(self._read_project_dir(project_dir))
            except Exception:
                continue
        return projects

    def _read_project_dir(self, project_dir: str) -> Dict[str, Any]:
        with open(os.path.join(project_dir, "project.md"), "r", encoding="utf-8") as f:
            meta, body = _parse_frontmatter(f.read())
        project = {
            "id": meta.get("id") or self.new_id(),
            "title": meta.get("title", ""),
            "description": self._extract_section(body, "Project"),
            "status": meta.get("status", "active"),
            "priority": meta.get("priority", "medium"),
            "createdAt": meta.get("createdAt") or self.now(),
            "updatedAt": meta.get("updatedAt") or self.now(),
            "dueDate": meta.get("dueDate"),
            "createdBy": meta.get("createdBy", "user"),
            "tags": meta.get("tags_json", []),
            "branch": meta.get("branch", ""),
            "columns": meta.get("columns_json", []),
            "workflowActive": meta.get("workflowActive", False),
            "autoMode": meta.get("autoMode", False),
            "template": meta.get("template", False),
            "templates": meta.get("templates_json", []),
            "activity": self._parse_activity(self._extract_section(body, "Activity")),
            "tasks": [],
        }
        tasks_dir = os.path.join(project_dir, "tasks")
        if os.path.isdir(tasks_dir):
            for name in sorted(os.listdir(tasks_dir)):
                if not name.endswith(".md"):
                    continue
                task = self._read_task_file(os.path.join(tasks_dir, name))
                if task:
                    project["tasks"].append(task)
        return project

    def _read_task_file(self, path: str) -> Optional[Dict[str, Any]]:
        with open(path, "r", encoding="utf-8") as f:
            meta, body = _parse_frontmatter(f.read())
        description = self._extract_section(body, "Description")
        comments = self._parse_comments(self._extract_section(body, "Comments"))
        task = {
            "id": meta.get("id") or self.new_id(),
            "title": meta.get("title", ""),
            "description": description if description and description != "_No description_" else "",
            "columnId": meta.get("columnId"),
            "order": meta.get("order", 0),
            "priority": meta.get("priority", "medium"),
            "assignee": meta.get("assignee"),
            "assigneeBranch": meta.get("assigneeBranch"),
            "dueDate": meta.get("dueDate"),
            "tags": meta.get("tags_json", []),
            "checklist": meta.get("checklist_json", []),
            "comments": comments,
            "attachments": meta.get("attachments_json", []),
            "createdAt": meta.get("createdAt") or self.now(),
            "updatedAt": meta.get("updatedAt") or self.now(),
            "completedAt": meta.get("completedAt"),
        }
        review_check = meta.get("reviewCheck_json", [])
        if review_check:
            task["reviewCheck"] = review_check
        last_review_check = meta.get("lastReviewCheck_json", [])
        if last_review_check:
            task["lastReviewCheck"] = last_review_check
        return task

    def _extract_section(self, body: str, heading: str) -> str:
        if not body:
            return ""
        lines = body.splitlines()
        target = f"## {heading}"
        collecting = False
        buf: List[str] = []
        for line in lines:
            if line.strip() == target:
                collecting = True
                continue
            if collecting and line.startswith("## "):
                break
            if collecting:
                buf.append(line)
        return "\n".join(buf).strip()

    def _parse_checklist(self, text: str) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for line in text.splitlines():
            m = re.match(r"- \[(.| )\] (.*)", line.strip())
            if m:
                items.append({"text": m.group(2).strip(), "done": m.group(1).lower() == "x"})
        return items

    def _parse_comments(self, text: str) -> List[Dict[str, Any]]:
        comments: List[Dict[str, Any]] = []
        if not text or text.strip() == "No comments yet":
            return comments
        parts = re.split(r"^### ", text, flags=re.M)
        for part in parts:
            part = part.strip()
            if not part:
                continue
            first_line, *rest = part.splitlines()
            if " — " in first_line:
                author, created_at = first_line.split(" — ", 1)
            else:
                author, created_at = first_line, ""
            comments.append({"id": self.new_id(), "author": author.strip(), "createdAt": created_at.strip(), "text": "\n".join(rest).strip()})
        return comments

    def _parse_attachments(self, text: str) -> List[str]:
        items: List[str] = []
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("- "):
                items.append(line[2:].strip())
        return items

    def _parse_review_check(self, text: str) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("- "):
                continue
            body = line[2:]
            if ": " in body:
                status, label = body.split(": ", 1)
                items.append({"id": self.new_id(), "status": status.strip(), "text": label.strip()})
        return items

    def _parse_activity(self, text: str) -> List[Dict[str, Any]]:
        activity: List[Dict[str, Any]] = []
        for line in text.splitlines():
            line = line.strip()
            m = re.match(r"- \[(.*?)\] \((.*?)\) (.*)", line)
            if m:
                activity.append({"type": "activity", "at": m.group(1), "by": m.group(2), "detail": m.group(3)})
        return activity
