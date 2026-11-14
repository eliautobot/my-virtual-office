"""Is a newer My Virtual Office out? (v0.10.1)

Asks GitHub for the latest release of VO_UPDATE_REPO (default eliautobot/my-virtual-office) and
compares its tag with the running version. Only a plain GET with a User-Agent is sent; nothing about
this office leaves the machine. Drafts and prereleases never count as an update.

An answer is kept in memory for 12 hours and a failed check for 1 hour, so an offline machine or a
GitHub rate limit is not asked again on every page load. "Check now" skips the cache but is held to
once a minute. VO_UPDATE_CHECK=0 (or the Settings switch) turns the check off: no request is made and
the answer says latest = current.
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

DEFAULT_REPO = "eliautobot/my-virtual-office"
API_URL = "https://api.github.com/repos/{repo}/releases/latest"
TIMEOUT_S = 3
OK_TTL_S = 12 * 3600
FAIL_TTL_S = 3600
CHECK_NOW_GAP_S = 60
MAX_BODY_BYTES = 2_000_000

_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
_SEMVER_RE = re.compile(
    r"^\s*[vV]?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$"
)
_OFF_WORDS = {"0", "false", "no", "off", "disabled"}


def parse_version(text):
    """'v0.10.1' -> ((0, 10, 1), ('rc', 1)) or None. A missing patch counts as 0."""
    m = _SEMVER_RE.match(str(text or ""))
    if not m:
        return None
    core = (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))
    pre = tuple(int(p) if p.isdigit() else p for p in m.group(4).split(".")) if m.group(4) else ()
    return core, pre


def _pre_key(pre):
    # Semver: a release outranks its prereleases; numeric ids sort before text ids.
    if not pre:
        return (1,)
    return (0,) + tuple((0, p, "") if isinstance(p, int) else (1, 0, p) for p in pre)


def compare_versions(a, b):
    """-1, 0 or 1 like cmp(a, b); None when either is not a version."""
    pa, pb = parse_version(a), parse_version(b)
    if pa is None or pb is None:
        return None
    ka, kb = (pa[0], _pre_key(pa[1])), (pb[0], _pre_key(pb[1]))
    return (ka > kb) - (ka < kb)


def clean_tag(tag):
    """The tag without its 'v' (what the UI shows)."""
    tag = str(tag or "").strip()
    return tag[1:] if tag[:1] in ("v", "V") and parse_version(tag) else tag


def env_enabled(env=None):
    env = os.environ if env is None else env
    return str(env.get("VO_UPDATE_CHECK", "1")).strip().lower() not in _OFF_WORDS


def repo_from_env(env=None):
    env = os.environ if env is None else env
    return str(env.get("VO_UPDATE_REPO") or "").strip() or DEFAULT_REPO


def _iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _reason(exc):
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (403, 429):
            return "GitHub rate limit, trying again later"
        if exc.code == 404:
            return "no published release found"
        return f"GitHub answered {exc.code}"
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return "offline or GitHub did not answer"
    if isinstance(exc, ValueError):
        return "unexpected answer from GitHub"
    return "unexpected error"


def fetch_latest(repo, current, timeout=TIMEOUT_S):
    """GET releases/latest. Returns the decoded JSON object; raises on any failure."""
    req = urllib.request.Request(
        API_URL.format(repo=repo),
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"My-Virtual-Office/{current}",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read(MAX_BODY_BYTES + 1)
    if len(raw) > MAX_BODY_BYTES:
        raise ValueError("answer too large")
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("not an object")
    return data


class UpdateChecker:
    """One per server. Thread-safe; at most one request to GitHub at a time."""

    def __init__(self, current, fetch=None, clock=None, env=None):
        self.current = str(current)
        self._fetch = fetch or fetch_latest
        self._clock = clock or time.time
        self._env = env
        self._lock = threading.Lock()
        self._cache = None        # (expires_at, result)
        self._last_attempt = 0.0

    def _base(self, repo):
        valid = bool(_REPO_RE.match(repo))
        return {
            "ok": True,
            "current": self.current,
            "latest": self.current,
            "newer": False,
            "url": f"https://github.com/{repo}/releases" if valid else None,
            "releasesUrl": f"https://github.com/{repo}/releases" if valid else None,
            "howToUrl": f"https://github.com/{repo}/blob/HEAD/docs/UPDATING.md" if valid else None,
            "name": None,
            "publishedAt": None,
            "checkedAt": None,
            "enabled": True,
            "error": None,
        }

    def _from_release(self, repo, data, now):
        out = self._base(repo)
        out["checkedAt"] = _iso(now)
        if data.get("draft") or data.get("prerelease"):
            # releases/latest never names one of these; if it does, it is not an update.
            return out
        tag = str(data.get("tag_name") or "").strip()
        latest = clean_tag(tag)
        cmp = compare_versions(latest, self.current)
        if cmp is None:
            out["error"] = "the latest release has no version number"
            return out
        page = str(data.get("html_url") or "")
        if not page.startswith(f"https://github.com/{repo}/"):
            page = f"https://github.com/{repo}/releases/tag/{urllib.parse.quote(tag)}"
        out.update({
            "latest": latest,
            "newer": cmp > 0,
            "url": page,
            "name": str(data.get("name") or "").strip()[:200] or None,
            "publishedAt": str(data.get("published_at") or "") or None,
        })
        return out

    def status(self, setting_enabled=True, refresh=False):
        repo = repo_from_env(self._env)
        if not env_enabled(self._env) or not setting_enabled:
            out = self._base(repo)
            out["enabled"] = False
            out["disabledBy"] = "env" if not env_enabled(self._env) else "setting"
            return out
        if not _REPO_RE.match(repo):
            out = self._base(repo)
            out["error"] = "VO_UPDATE_REPO is not owner/name"
            return out
        with self._lock:
            now = self._clock()
            cached = self._cache
            if cached and cached[2] == repo:
                fresh = now < cached[0]
                if refresh and now - self._last_attempt < CHECK_NOW_GAP_S:
                    out = dict(cached[1])
                    out["limited"] = True
                    out["retryAfter"] = int(CHECK_NOW_GAP_S - (now - self._last_attempt)) + 1
                    return out
                if fresh and not refresh:
                    return dict(cached[1])
            self._last_attempt = now
            try:
                result = self._from_release(repo, self._fetch(repo, self.current), now)
                ttl = OK_TTL_S
            except Exception as exc:  # any failure: say why, keep it for an hour
                result = self._base(repo)
                result["checkedAt"] = _iso(now)
                result["error"] = _reason(exc)
                ttl = FAIL_TTL_S
            self._cache = (now + ttl, result, repo)
            return dict(result)

