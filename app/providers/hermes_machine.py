"""A Hermes agent's own machine (design 2.4/2.7, phase C1; MVW 9094 server/providers/hermes/{files,screen}.js).

Files: the machine Hermes runs on, through Hermes' own managed files (its dashboard's Files: GET /api/files,
/api/files/read, POST /api/files/upload, /api/files/mkdir, DELETE /api/files): whatever Hermes itself allows there (its
locked root, its refusal of sensitive files). Reading answers at both access levels; a change only with Full access.

Screen: Hermes' Bot Desktop, one per profile, where its browser opens (headed) and its computer_use acts. Hermes'
calls on this connection: display.status / start / stop, display.thumbnail (one picture), display.observe (mints this
person's viewer id) and display.lease.acquire / release (take over, hand back). Under Chat only the screen is not
there: every screen call answers {available: False, reason} (and no picture), nothing is asked of Hermes.
"""

from __future__ import annotations

import base64
import hashlib
import re
import threading
import urllib.parse

from providers import hermes_link as hl
from providers.hermes_menu import chat_only, fail

PROFILE = re.compile(r"^[\w.-]{1,64}$")
MIME_OK = re.compile(r"^[\w.+-]+/[\w.+-]+$")
JPEG = re.compile(r"^data:image/jpeg;base64,([A-Za-z0-9+/=]+)$")
DATA_URL = re.compile(r"^data:([^;,]*)(;base64)?,(.*)$", re.S)
BY_STATUS = {400: "bad_request", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large",
             415: "unsupported"}
WRITE_MAX = 34 * 1024 * 1024        # base64 characters of one upload (Hermes' own cap is about 25 MB of file)
ENTRIES_MAX = 2000
READS = ("list", "read")
WRITES = ("write", "mkdir", "remove")


def _path(v) -> str:
    return str(v if v is not None else "")[:2000]


def _ready(link) -> None:
    wait = getattr(link, "wait_connected", None)
    if callable(wait):
        wait()


# ------------------------------------------------------------------ files
def _frest(link, method, path, *, body=None, query=None, timeout=30.0):
    try:
        return link.rest(method, path, body, None, query=query, timeout=timeout)
    except hl.HermesError as e:
        code = BY_STATUS.get(e.http_status or 0)
        if code:
            raise fail(code, e.detail, e.fix, status=e.http_status) from None
        raise


def files(link, op: str, p: dict | None = None, *, access: str = "chat") -> dict:
    """list {path} / read {path} at both levels; write {path, content, encoding?, mime?, overwrite?} / mkdir {path} /
    remove {path, recursive?} with Full access only."""
    p = p if isinstance(p, dict) else {}
    if op not in READS + WRITES:
        raise fail("unsupported", f"There is no file call {op}.", status=400)
    if op in WRITES and access != "full":
        raise chat_only("files")
    _ready(link)
    if op == "list":
        r = _frest(link, "GET", "/api/files", query={"path": _path(p["path"])} if p.get("path") else {}) or {}
        entries = [e for e in r.get("entries") or [] if isinstance(e, dict)]
        return {"path": r.get("path") or "", "parent": r.get("parent"),
                "root": r.get("locked_root") or r.get("root"), "total": len(entries),
                "entries": [{"name": e.get("name"), "path": e.get("path"), "dir": bool(e.get("is_directory")),
                             "size": e.get("size"), "modified": round(e["mtime"] * 1000) if e.get("mtime") else None,
                             "mime": e.get("mime_type")} for e in entries[:ENTRIES_MAX]]}
    if op == "read":
        if not p.get("path"):
            raise fail("bad_request", "Which file?", status=400)
        r = _frest(link, "GET", "/api/files/read", query={"path": _path(p["path"])}, timeout=60) or {}
        m = DATA_URL.match(str(r.get("data_url") or ""))
        if not m:
            raise fail("unreadable", "Hermes sent the file in a form that could not be read.", status=502)
        content = m.group(3) if m.group(2) else base64.b64encode(urllib.parse.unquote(m.group(3)).encode()).decode()
        return {"name": r.get("name"), "path": r.get("path"), "size": r.get("size"),
                "mime": r.get("mime_type") or m.group(1) or "application/octet-stream", "encoding": "base64",
                "content": content}
    if not p.get("path"):
        raise fail("bad_request", "Which file?", status=400)
    if op == "write":
        if not isinstance(p.get("content"), str):
            raise fail("bad_request", "Send the file.", status=400)
        mime = p["mime"] if isinstance(p.get("mime"), str) and MIME_OK.match(p["mime"]) else "application/octet-stream"
        data = p["content"] if p.get("encoding") == "base64" else base64.b64encode(p["content"].encode()).decode()
        if len(data) > WRITE_MAX:
            raise fail("too_large", "That file is too large to send to Hermes from here.", status=413)
        r = _frest(link, "POST", "/api/files/upload", timeout=120,
                   body={"path": _path(p["path"]), "data_url": f"data:{mime};base64,{data}",
                         "overwrite": p.get("overwrite") is not False}) or {}
        return {"ok": True, "path": r.get("path") or p["path"]}
    if op == "mkdir":
        r = _frest(link, "POST", "/api/files/mkdir", body={"path": _path(p["path"])}) or {}
        return {"ok": True, "path": r.get("path") or p["path"]}
    _frest(link, "DELETE", "/api/files", body={"path": _path(p["path"]), "recursive": p.get("recursive") is True})
    return {"ok": True}


# ------------------------------------------------------------------ screen (Bot Desktop)
def _hash(viewer_id: str) -> str:
    """The lease holder as Hermes shows it: a short hash of the viewer id (the id itself is a capability)."""
    return hashlib.sha256(str(viewer_id).encode()).hexdigest()[:12]


class Screen:
    """The Bot Desktops of one connection. Viewer ids are minted by Hermes per socket: one per person and profile,
    kept while that socket lasts, so a person's reload keeps their control and two people never share it."""

    def __init__(self, link):
        self.link = link
        self._viewers: dict[tuple[str, str], tuple[str, int]] = {}   # (profile, viewer) -> (Hermes' id, link gen)
        self._lock = threading.Lock()

    @staticmethod
    def unavailable() -> dict:
        return {"available": False, "reason": chat_only("screen").detail}

    @staticmethod
    def profile_of(profile) -> str:
        s = str(profile or "")
        if not PROFILE.match(s):
            raise fail("bad_request", "Which agent?", status=400)
        return s

    def _viewer_id(self, profile: str, viewer: str) -> str | None:
        with self._lock:
            v = self._viewers.get((profile, viewer))
        return v[0] if v and v[1] == getattr(self.link, "gen", 0) else None

    def _rpc(self, method: str, params: dict, timeout: float = 30.0):
        _ready(self.link)
        try:
            return self.link.call(method, params, timeout=timeout)
        except hl.HermesError as e:
            if e.rpc_code == -32601 or "method not found" in str(e.detail).lower():
                raise fail("unsupported", "This Hermes has no Bot Desktop yet (update Hermes).", status=400) from None
            if e.rpc_code is not None:
                raise fail("provider_error", e.detail, e.fix, status=502) from None
            raise

    def view(self, st: dict, profile: str, viewer: str) -> dict:
        st = st if isinstance(st, dict) else {}
        lease = st.get("lease") if isinstance(st.get("lease"), dict) else {}
        me = self._viewer_id(profile, viewer)
        human = lease.get("holder") == "human"
        out = {"available": True, "supported": st.get("supported") is not False,
               "installed": st.get("installed") is not False, "running": bool(st.get("running")),
               "geometry": str(st.get("geometry") or "")[:20],
               "blocker": str(st["blocker"])[:400] if st.get("blocker") else None,
               "sandbox": str(st.get("placement") or "").startswith("terminal"),
               "holder": "human" if human else "agent",
               "mine": bool(human and me and lease.get("viewer_hash") == _hash(me))}
        if st.get("installed") is False and st.get("install_command"):
            out["install"] = str(st["install_command"])[:600]
        if human and lease.get("reason"):
            out["reason"] = str(lease["reason"])[:200]
        return out

    def _on_screen(self, profile: str):
        """Whether Hermes opens its browser on its screen (its settings browser.headed and bot_desktop.auto_start)."""
        try:
            c = self.link.rest("GET", "/api/config", None, profile) or {}
        except hl.HermesError:
            return None
        return bool((c.get("browser") or {}).get("headed") is True and (c.get("bot_desktop") or {}).get("auto_start")
                    is True)

    def state(self, profile, viewer: str = "", *, access: str = "chat") -> dict:
        if access != "full":
            return self.unavailable()
        profile = self.profile_of(profile)
        try:
            st = self._rpc("display.status", {"profile": profile})
        except hl.HermesError as e:
            if e.code == "unsupported":
                return {"available": False, "reason": e.detail}
            raise
        return {**self.view(st, profile, str(viewer or "")), "browserOnScreen": self._on_screen(profile)}

    def _observe(self, profile: str, viewer: str) -> str:
        have = self._viewer_id(profile, viewer)
        r = self._rpc("display.observe", {"profile": profile, **({"viewer_id": have} if have else {})})
        if not isinstance(r, dict) or not isinstance(r.get("viewer_id"), str):
            raise fail("provider_error", "Hermes did not open its screen.", status=502)
        with self._lock:
            self._viewers[(profile, viewer)] = (r["viewer_id"], getattr(self.link, "gen", 0))
            while len(self._viewers) > 200:
                self._viewers.pop(next(iter(self._viewers)))
        return r["viewer_id"]

    def act(self, profile, op: str, p: dict | None = None, *, access: str = "chat") -> dict:
        """start, stop {force?}, lease {take: bool} (or take / release), browser {on}: the new view."""
        if access != "full":
            return self.unavailable()
        p = p if isinstance(p, dict) else {}
        profile, viewer = self.profile_of(profile), str(p.get("viewer") or "")[:120]
        if op == "lease":
            op = "take" if p.get("take") is True or p.get("action") == "take" else "release"
        if op == "start":
            return self.view(self._rpc("display.start", {"profile": profile}, timeout=40), profile, viewer)
        if op == "stop":
            params = {"profile": profile, **({"force": True} if p.get("force") is True else {})}
            return self.view(self._rpc("display.stop", params, timeout=20), profile, viewer)
        if op == "take":
            vid = self._viewer_id(profile, viewer) or self._observe(profile, viewer)
            self._rpc("display.lease.acquire", {"profile": profile, "viewer_id": vid, "reason": "Virtual Office"})
            return self.view(self._rpc("display.status", {"profile": profile}), profile, viewer)
        if op == "release":
            vid = self._viewer_id(profile, viewer)
            if not vid:
                raise fail("bad_request", "You don't have control of this screen.", status=400)
            self._rpc("display.lease.release", {"profile": profile, "viewer_id": vid})
            return self.view(self._rpc("display.status", {"profile": profile}), profile, viewer)
        if op == "browser":
            on = p.get("on") is True
            _ready(self.link)
            self.link.rest("PUT", "/api/config", {"config": {"browser": {"headed": on}, "bot_desktop": {"auto_start": on}},
                                                  "profile": profile}, profile)
            return self.state(profile, viewer, access=access)
        raise fail("bad_request", "Not something the screen does.", status=400)

    def thumb(self, profile, *, access: str = "chat") -> dict | None:
        """One picture of the screen {data: jpeg bytes, mime}, or None: not running, a person has control (Hermes
        then shows nobody what they type), or Chat only."""
        if access != "full":
            return None
        r = self._rpc("display.thumbnail", {"profile": self.profile_of(profile)}, timeout=15)
        m = JPEG.match(r.get("data_url") or "") if isinstance(r, dict) and isinstance(r.get("data_url"), str) else None
        return {"data": base64.b64decode(m.group(1)), "mime": "image/jpeg"} if m else None
