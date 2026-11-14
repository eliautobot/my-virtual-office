"""Shared safety helpers for provider-owned profile file mutations."""

from __future__ import annotations

import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
import data_owner   # (folders and files made as root keep the data folder's owner)


def backup_files(workspace: str, paths: Iterable[str]) -> tuple[str, list[str]]:
    """Copy existing provider files into a workspace-local revision directory."""
    backup_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    root = os.path.join(os.path.abspath(workspace), ".vo-profile-backups", backup_id)
    copied: list[str] = []
    for index, raw_path in enumerate(paths):
        path = os.path.abspath(os.path.expanduser(str(raw_path or "")))
        if not os.path.isfile(path):
            continue
        safe_name = f"{index:02d}-{Path(path).name}"
        target = os.path.join(root, safe_name)
        data_owner.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(path, target)
        data_owner.adopt(target)
        copied.append(target)
    return (backup_id if copied else ""), copied


def directory_has_content(path: str) -> bool:
    """True when ``path`` is an existing directory with any entry in it."""
    try:
        with os.scandir(path) as entries:
            return any(True for _ in entries)
    except (FileNotFoundError, NotADirectoryError):
        return False


def path_is_inside(path: str, root: str) -> bool:
    if not path or not root:
        return False
    real_root = os.path.realpath(root)
    real = os.path.realpath(path)
    return real != real_root and real.startswith(real_root + os.sep)


def remove_agent_folder(agent_dir: str, written: Iterable[str], *, managed_root: str = "", marker: str = "") -> dict:
    """Remove an agent folder without ever deleting user files (BE-06).

    - Inside the office-managed root (standard agents) with the office marker file
      present, the whole folder is the agent's and is removed.
    - Anywhere else (a custom parent the user chose, possibly a real project), only
      the files the office wrote are removed, then directories left empty.
    """
    agent_dir = os.path.abspath(os.path.expanduser(str(agent_dir or "")))
    if not agent_dir or not os.path.isdir(agent_dir):
        return {"removed": [], "kept": False}
    has_marker = bool(marker) and os.path.isfile(os.path.join(agent_dir, marker))
    if managed_root and has_marker and path_is_inside(agent_dir, managed_root) and not os.path.islink(agent_dir):
        shutil.rmtree(agent_dir)
        return {"removed": [agent_dir], "kept": False}
    removed: list[str] = []
    dirs: set[str] = set()
    for rel in list(written or []) + ([marker] if marker else []):
        rel = str(rel or "").strip()
        if not rel or os.path.isabs(rel):
            continue
        path = os.path.abspath(os.path.join(agent_dir, rel))
        if not path_is_inside(path, agent_dir):
            continue
        if os.path.isdir(path) and not os.path.islink(path):
            dirs.add(path)  # a folder the office created; removed below only if empty
        parent = os.path.dirname(path)
        while path_is_inside(parent, agent_dir):
            dirs.add(parent)
            parent = os.path.dirname(parent)
        if os.path.isfile(path) and not os.path.islink(path):
            try:
                os.remove(path)
                removed.append(path)
            except OSError:
                pass
    for directory in sorted(dirs, key=len, reverse=True):
        try:
            os.rmdir(directory)  # only succeeds when empty
        except OSError:
            pass
    kept = True
    try:
        os.rmdir(agent_dir)
        kept = False
    except OSError:
        pass
    return {"removed": removed, "kept": kept}
