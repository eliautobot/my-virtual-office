"""One way to run streaming agent CLIs (BE-15, BE-16, BE-29).

- The CLI runs in its own process group, so Stop and timeouts also end the dev
  servers and shells it started.
- A watchdog enforces the deadline even when the CLI prints nothing.
- stderr is drained on a thread, so a chatty CLI can never fill the pipe and hang.
- Killed processes are always reaped (no <defunct> children).
"""

from __future__ import annotations

import collections
import os
import re
import signal
import subprocess
import threading
import time
from typing import Iterator

MAX_ARG_BYTES = 120 * 1024  # Linux refuses a single argv string over 128 KiB (E2BIG)
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$")


def argv_message(message: str) -> str:
    """Make a chat message safe to pass as one CLI argument.

    A message that starts with "-" (a pasted bullet list) would be read as an
    option, so it gets one leading space. Oversized messages raise ValueError
    with a readable reason instead of failing with E2BIG.
    """
    text = str(message or "")
    if len(text.encode("utf-8", errors="replace")) > MAX_ARG_BYTES:
        raise ValueError("Message is too long for this agent's command line (limit about 120 KB). Attach it as a file instead.")
    if text.startswith("-"):
        text = " " + text
    return text


def safe_session_id(value: str | None) -> str:
    """Session ids reach CLI flags such as --resume; reject anything that could be a flag."""
    text = str(value or "").strip()
    if not text:
        return ""
    if not _SESSION_ID_RE.match(text):
        raise ValueError("Invalid session id")
    return text


class CliRun:
    """A started CLI process with a watchdog. Iterate ``lines()`` then call ``finish()``."""

    def __init__(self, cmd: list[str], *, cwd: str | None, env: dict[str, str] | None,
                 timeout_sec: float, stderr_limit: int = 64 * 1024, grace_sec: float = 3.0) -> None:
        self.cmd = list(cmd)
        self.timed_out = False
        self.stopped = False
        self._grace = grace_sec
        self._stderr: collections.deque[str] = collections.deque()
        self._stderr_size = 0
        self._stderr_limit = stderr_limit
        self._lock = threading.Lock()
        self.proc = subprocess.Popen(
            self.cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True, name="cli-stderr")
        self._stderr_thread.start()
        self._timer = threading.Timer(max(0.1, float(timeout_sec)), self._on_timeout)
        self._timer.daemon = True
        self._timer.start()

    # ── output ───────────────────────────────────────────────────────────
    def _drain_stderr(self) -> None:
        stream = self.proc.stderr
        if not stream:
            return
        try:
            for raw in stream:
                line = raw.rstrip("\n")[-self._stderr_limit:]
                with self._lock:
                    self._stderr.append(line)
                    self._stderr_size += len(line) + 1
                    while self._stderr_size > self._stderr_limit and len(self._stderr) > 1:
                        self._stderr_size -= len(self._stderr.popleft()) + 1
        except (OSError, ValueError):
            pass

    def lines(self) -> Iterator[str]:
        stream = self.proc.stdout
        if not stream:
            return
        try:
            for raw in stream:
                yield raw
        except (OSError, ValueError):
            return

    @property
    def stderr_text(self) -> str:
        with self._lock:
            return "\n".join(self._stderr)

    # ── stopping ─────────────────────────────────────────────────────────
    def _on_timeout(self) -> None:
        self.timed_out = True
        self.terminate()

    def _signal_group(self, sig: int) -> None:
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        except OSError:
            try:
                self.proc.send_signal(sig)
            except OSError:
                pass

    def terminate(self) -> None:
        """TERM the whole process group, then KILL it if it is still alive."""
        if self.proc.poll() is not None:
            # The CLI exited; its children may still be running in the group.
            self._signal_group(signal.SIGTERM)
            return
        self._signal_group(signal.SIGTERM)

        def _escalate() -> None:
            deadline = time.time() + self._grace
            while time.time() < deadline:
                if self.proc.poll() is not None:
                    break
                time.sleep(0.05)
            self._signal_group(signal.SIGKILL)

        threading.Thread(target=_escalate, daemon=True, name="cli-kill").start()

    def stop(self) -> None:
        self.stopped = True
        self.terminate()

    def finish(self, wait_sec: float = 10.0) -> int | None:
        """Wait for exit (killing on overrun), stop the watchdog, and reap."""
        try:
            code = self.proc.wait(timeout=wait_sec)
        except subprocess.TimeoutExpired:
            self._signal_group(signal.SIGKILL)
            try:
                code = self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                code = None
        finally:
            self._timer.cancel()
        self._stderr_thread.join(timeout=2)
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass
        return code
