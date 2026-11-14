"""Shared script for the fake provider CLIs (tests/tools/fake-codex, fake-claude, fake-opencode, fake-agy).

Deterministic: the same message gives the same answer, thinking and tool step. Directives in the user's message choose
the script (several may be combined):
  [[tool]]      one tool step (a shell command `echo fake-tool-ok`) before the answer
  [[approval]]  Codex app-server only: the command needs the user's approval first (accept -> runs, cancel -> declined)
  [[slow]]      a slow answer: one word every FAKE_SLOW_STEP seconds (default 0.5) for FAKE_SLOW_WORDS words (default 60),
                so Stop can be tested
  [[error]]     the turn fails with "fake failure"
Every answer: "<Label> reply <n>: <the message without directives>", n = the turn number in that chat (1, 2, ...).
Thinking (where the CLI has it): "Thinking about: <message>".
State lives under the CLI's own home (CODEX_HOME, CLAUDE_CONFIG_DIR, OPENCODE_CONFIG_DIR) or $HOME/.vo-fakes: never a
real account. Every call is appended to <state>/calls.log (argv, one JSON line) so a test can see what the office ran.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time

DIRECTIVE_RE = re.compile(r"\[\[(tool|approval|slow|error)\]\]", re.I)


def directives(message: str) -> set[str]:
    return {m.group(1).lower() for m in DIRECTIVE_RE.finditer(message or "")}


def user_text(message: str) -> str:
    """The person's own words inside what the office delivers.

    The office wraps a chat message (server.py `_provider_delivery_message` and friends):
      [A2A from=user name="User" to=... isUser=true sourceApp=... sourceSurface=...]\n
      Message from User via Virtual Office Chat.\n\n<message>\n\n
      [Attached files uploaded through Virtual Office:\n- name: path\n\n]Reply directly to the user. ...
    and Codex exec / persona prompts end with "User message:\n<message>"."""
    text = message or ""
    if "User message:\n" in text:
        text = text.rsplit("User message:\n", 1)[1]
    head = text.lstrip()
    # (with the A2A line, or only "Message from <name> via <surface>." as Claude Code's path sends it)
    if (head.startswith("[A2A ") or re.match(r"Message from [^\n]* via [^\n]*\.\n\n", head)) and "\n\n" in head:
        text = head.split("\n\n", 1)[1]
        for tail in ("\n\nAttached files uploaded through Virtual Office:", "\n\nReply directly to the user."):
            if tail in text:
                text = text.split(tail, 1)[0]
    return text


def attachments(message: str) -> list[str]:
    """File names the office listed under "Attached files uploaded through Virtual Office:"."""
    m = re.search(r"Attached files uploaded through Virtual Office:\n((?:- [^\n]*\n?)+)", message or "")
    return [ln[2:].split(":", 1)[0].strip() for ln in m.group(1).splitlines()] if m else []


def clean(message: str) -> str:
    text = DIRECTIVE_RE.sub("", user_text(message))
    return " ".join(text.split())[:400]


def answer(label: str, n: int, message: str) -> str:
    files = attachments(message)
    extra = f" (files: {', '.join(files)})" if files else ""
    return f"{label} reply {n}: {clean(message) or '(empty)'}{extra}"


def thinking(message: str) -> str:
    return f"Thinking about: {clean(message) or '(empty)'}"


def words(text: str) -> list[str]:
    """The answer as stream chunks (word + following space), joined back they are the text exactly."""
    parts = re.findall(r"\S+\s*", text)
    return parts or [text]


def slow_plan() -> tuple[int, float]:
    try:
        n = int(os.environ.get("FAKE_SLOW_WORDS") or 60)
    except ValueError:
        n = 60
    try:
        step = float(os.environ.get("FAKE_SLOW_STEP") or 0.5)
    except ValueError:
        step = 0.5
    return max(1, n), max(0.01, step)


def slow_text(label: str, n: int, message: str) -> str:
    count, _ = slow_plan()
    return answer(label, n, message) + " " + " ".join(f"w{i}" for i in range(1, count + 1))


def step_delay() -> float:
    try:
        return max(0.0, float(os.environ.get("FAKE_STEP_DELAY") or 0.12))
    except ValueError:
        return 0.12


TOOL_COMMAND = "echo fake-tool-ok"
TOOL_OUTPUT = "fake-tool-ok\n"


class State:
    """A small JSON store per fake CLI (chats, counters)."""

    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(os.path.expanduser(root))
        os.makedirs(self.root, exist_ok=True)

    def path(self, *parts: str) -> str:
        p = os.path.join(self.root, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def log_call(self, argv: list[str]) -> None:
        try:
            with open(self.path("calls.log"), "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": round(time.time(), 3), "pid": os.getpid(), "argv": argv}) + "\n")
        except OSError:
            pass

    def next_id(self, prefix: str, width: int = 4) -> str:
        p = self.path("counter-" + re.sub(r"[^a-z0-9]+", "-", prefix.lower()))
        fd = os.open(p, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
            raw = os.read(fd, 64).decode() or "0"
            n = int(raw.strip() or 0) + 1
            os.lseek(fd, 0, 0)
            os.ftruncate(fd, 0)
            os.write(fd, str(n).encode())
        finally:
            os.close(fd)
        return f"{prefix}{n:0{width}d}"

    def load(self, name: str, default):
        try:
            with open(self.path(name), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return default

    def save(self, name: str, value) -> None:
        p = self.path(name)
        tmp = p + f".tmp{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f)
        os.replace(tmp, p)

    def remove(self, name: str) -> bool:
        try:
            os.remove(self.path(name))
            return True
        except OSError:
            return False


def emit(obj, stream=None, lock=None) -> None:
    out = stream or sys.stdout
    line = json.dumps(obj, separators=(",", ":")) + "\n"
    if lock:
        with lock:
            out.write(line)
            out.flush()
    else:
        out.write(line)
        out.flush()


def now_ms() -> int:
    return int(time.time() * 1000)
