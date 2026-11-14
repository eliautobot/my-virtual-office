import copy
import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
import data_owner
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


_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def is_safe_project_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_SAFE_ID.match(value))


def _fingerprint(value: Any) -> str:
    return hashlib.sha1(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


def _atomic_write(path: str, content: str):
    data_owner.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    with open(tmp, "w", encoding="utf-8") as f:
        data_owner.adopt_fd(f.fileno(), os.path.dirname(path))
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class MarkdownProjectStore:
    def __init__(self, status_dir: str):
        self.status_dir = status_dir
        self.projects_dir = os.path.join(status_dir, PROJECTS_DIRNAME)
        self.legacy_json = os.path.join(status_dir, LEGACY_PROJECTS_FILENAME)
        self.lock = threading.Lock()
        # load_all_shared(): the last parse, its file fingerprint and the write generation it saw.
        self._generation = 0
        self._shared = None
        data_owner.makedirs(self.projects_dir, exist_ok=True)

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

    SHARED_MAX_AGE_SEC = 30.0

    def tree_signature(self):
        """Fingerprint of every file of the store (path, size, mtime): about 1 ms for 400 files."""
        sig = []
        for path in (self.legacy_json,):
            try:
                st = os.stat(path)
                sig.append((path, st.st_size, st.st_mtime_ns))
            except OSError:
                pass
        for root, dirs, files in os.walk(self.projects_dir):
            dirs.sort()
            for name in sorted(files):
                try:
                    st = os.stat(os.path.join(root, name))
                except OSError:
                    continue
                sig.append((root, name, st.st_size, st.st_mtime_ns))
        return tuple(sig)

    def load_all_shared(self) -> Dict[str, Any]:
        """load_all() for READ-ONLY hot paths (perf v0.13: /agent-chat parsed the whole store on every poll).

        Returns the same parsed data while no file of the store changed (path, size, mtime), nothing was
        written through this store and the parse is under SHARED_MAX_AGE_SEC old. Callers must not
        mutate the result; callers that save use load_all().
        """
        sig = self.tree_signature()
        now = time.monotonic()
        shared = self._shared
        if shared is not None and shared[0] == sig and shared[1] == self._generation and now - shared[2] < self.SHARED_MAX_AGE_SEC:
            return shared[3]
        generation = self._generation
        data = self.load_all()
        # A load that ran its legacy migration changed the files: fingerprint them again.
        self._shared = (self.tree_signature(), generation, now, data)
        return data

    @staticmethod
    def snapshot(data: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """Fingerprints of what a caller loaded, used to save only what it changed."""
        result: Dict[str, Dict[str, Any]] = {}
        for project in (data or {}).get("projects", []) or []:
            if not isinstance(project, dict) or not project.get("id"):
                continue
            meta = {k: v for k, v in project.items() if k != "tasks"}
            tasks = {
                str(t.get("id")): _fingerprint(t)
                for t in project.get("tasks", []) or [] if isinstance(t, dict) and t.get("id")
            }
            result[str(project["id"])] = {"meta": _fingerprint(meta), "tasks": tasks}
        return result

    def save_all(self, data: Dict[str, Any], base: Optional[Dict[str, Dict[str, Any]]] = None):
        """Persist projects (BE-05).

        Never deletes the whole store. With ``base`` (the snapshot of what this caller
        loaded) only projects/tasks the caller changed are written and only the ones
        it removed are deleted, so concurrent edits to other projects or tasks survive.
        Without ``base`` every given project is written and nothing else is touched.
        """
        with self.lock:
            self._generation += 1
            index = self._project_index()
            current_ids = set()
            for project in (data or {}).get("projects", []) or []:
                if not isinstance(project, dict):
                    continue
                if not project.get("id"):
                    project["id"] = self.new_id()
                pid = str(project["id"])
                current_ids.add(pid)
                base_entry = base.get(pid) if isinstance(base, dict) else None
                self._save_project(project, base_entry, index.get(pid))
            if isinstance(base, dict):
                for pid in base:
                    if pid not in current_ids and pid in index:
                        self._remove_inside(index[pid], self.projects_dir)

    def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        data = self.load_all()
        for p in data.get("projects", []):
            if p.get("id") == project_id:
                return p
        return None

    def delete_project(self, project_id: str) -> bool:
        if not is_safe_project_id(project_id):
            return False  # BE-03: never build a path from an unchecked id
        with self.lock:
            self._generation += 1
            deleted = False
            self._migrate_legacy_if_needed()
            project_dir = self._project_index().get(project_id)
            if project_dir:
                self._remove_inside(project_dir, self.projects_dir)
                deleted = True

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

            task_root = os.path.join(self.status_dir, "project-tasks")
            task_dir = os.path.join(task_root, project_id)
            if os.path.isdir(task_dir) and self._remove_inside(task_dir, task_root):
                deleted = True

            return deleted

    @staticmethod
    def _remove_inside(path: str, root: str) -> bool:
        """rmtree ``path`` only if it really lives inside ``root``."""
        real_root = os.path.realpath(root)
        real = os.path.realpath(path)
        if real == real_root or not real.startswith(real_root + os.sep) or os.path.islink(path):
            return False
        shutil.rmtree(real, ignore_errors=True)
        return True

    def _project_index(self) -> Dict[str, str]:
        """Map project id -> its folder, recovering folders left by an interrupted save."""
        index: Dict[str, str] = {}
        try:
            entries = sorted(os.listdir(self.projects_dir))
        except FileNotFoundError:
            data_owner.makedirs(self.projects_dir, exist_ok=True)
            return index
        for entry in entries:
            project_dir = os.path.join(self.projects_dir, entry)
            project_md = os.path.join(project_dir, "project.md")
            if entry.startswith(".") or not os.path.isfile(project_md):
                continue
            try:
                with open(project_md, encoding="utf-8") as handle:
                    meta, _ = _parse_frontmatter(handle.read())
            except OSError:
                continue
            if meta.get("id"):
                index.setdefault(str(meta["id"]), project_dir)
        return index

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
        for project in data.get("projects", []):
            if isinstance(project, dict):
                self._write_project(project)
        # Never resurrect the legacy file again if the folder is emptied later.
        try:
            os.replace(self.legacy_json, self.legacy_json + ".migrated")
        except OSError:
            pass

    def _save_project(self, project: Dict[str, Any], base_entry: Optional[Dict[str, Any]], existing_dir: Optional[str]):
        target_dir = self._project_dir(project)
        if existing_dir and os.path.realpath(existing_dir) != os.path.realpath(target_dir):
            if not os.path.exists(target_dir):
                os.replace(existing_dir, target_dir)  # title changed: keep the folder, rename it
            existing_dir = target_dir if os.path.isdir(target_dir) else existing_dir
        meta = {k: v for k, v in project.items() if k != "tasks"}
        tasks = [t for t in project.get("tasks", []) or [] if isinstance(t, dict)]
        tasks_dir = os.path.join(target_dir, "tasks")
        data_owner.makedirs(tasks_dir, exist_ok=True)
        if base_entry is None or base_entry.get("meta") != _fingerprint(meta) or not os.path.isfile(os.path.join(target_dir, "project.md")):
            self._write_project_meta(target_dir, project)
        base_tasks = (base_entry or {}).get("tasks") or {}
        current_ids = set()
        for task in tasks:
            if not task.get("id"):
                task["id"] = self.new_id()
            tid = str(task["id"])
            current_ids.add(tid)
            if base_entry is not None and base_tasks.get(tid) == _fingerprint(task) and self._task_files(tasks_dir, tid):
                continue
            self._write_task_file(tasks_dir, task)
        if base_entry is not None:
            for tid in base_tasks:
                if tid not in current_ids:
                    for path in self._task_files(tasks_dir, tid):
                        try:
                            os.remove(path)
                        except FileNotFoundError:
                            pass

    @staticmethod
    def _task_files(tasks_dir: str, task_id: str) -> List[str]:
        suffix = f"--{str(task_id)[:8]}.md"
        try:
            return [os.path.join(tasks_dir, n) for n in os.listdir(tasks_dir) if n.endswith(suffix)]
        except FileNotFoundError:
            return []

    def _project_dir(self, project: Dict[str, Any]) -> str:
        slug = _slugify(project.get("title", "project"))
        pid = project.get("id") or self.new_id()
        return os.path.join(self.projects_dir, f"{slug}--{pid[:8]}")

    def _write_project(self, project: Dict[str, Any]):
        project_dir = self._project_dir(project)
        tasks_dir = os.path.join(project_dir, "tasks")
        data_owner.makedirs(tasks_dir, exist_ok=True)
        self._write_project_meta(project_dir, project)
        for task in project.get("tasks", []) or []:
            self._write_task_file(tasks_dir, task)

    def _write_project_meta(self, project_dir: str, project: Dict[str, Any]):
        project = copy.deepcopy(project)
        project.pop("tasks", None)
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

    def _write_task_file(self, tasks_dir: str, task: Dict[str, Any]):
        task = copy.deepcopy(task)
        task_id = str(task.get("id") or self.new_id())
        title_slug = _slugify(task.get("title", "task"))
        path = os.path.join(tasks_dir, f"{title_slug}--{task_id[:8]}.md")
        for stale in self._task_files(tasks_dir, task_id):
            if stale != path:  # title changed: drop the old file name
                try:
                    os.remove(stale)
                except FileNotFoundError:
                    pass
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
        # project.md keeps it under "# Project" (it was read as "## Project", so an
        # edited description never came back and the next save wrote it empty).
        description = self._extract_section(body, "Project", marker="# ")
        project = {
            "id": meta.get("id") or self.new_id(),
            "title": meta.get("title", ""),
            "description": "" if description == "_No description_" else description,
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

    def _extract_section(self, body: str, heading: str, marker: str = "## ") -> str:
        if not body:
            return ""
        lines = body.splitlines()
        target = f"{marker}{heading}"
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
            text_value = "\n".join(rest).strip()
            # Stable id across reads so a comment can be found again after a reload.
            stable = hashlib.sha1(f"{len(comments)}|{author.strip()}|{created_at.strip()}|{text_value}".encode("utf-8")).hexdigest()[:32]
            comments.append({"id": stable, "author": author.strip(), "createdAt": created_at.strip(), "text": text_value})
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
