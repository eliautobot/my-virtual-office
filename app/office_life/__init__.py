"""Office life: the office reacts to real provider signals (design .work/life/design.md).

One path: provider signals -> sources/hooks -> ``bus.BUS`` (dedupe, roster filter, journal) ->
the page stream. Zero model inference: nothing here calls a model, starts a run or writes to a
provider. The package never imports server.py; server.py calls ``start(**fns)`` once at boot with
the callables below and routes ``/api/office-life/*`` to ``routes.dispatch``.

Injected callables (all optional; a missing one makes its feature quiet, never an error):
``data_dir`` (str), ``read_config()`` -> vo-config dict, ``config_path()`` -> path,
``config_lock(path)`` -> lock, ``read_json(path)`` (raises when unreadable), ``write_json(path, data)``,
``roster_rows()`` -> visible roster rows ``[{key, name, providerKind, createdAt, ...}]`` (10 s cache),
``presence()`` -> ``{key: {state, updated, ...}}``, ``layout_types()`` -> set of furniture types,
``append_meeting_history(record, replace=True)``, ``record_game(agent, played, won, title)``,
``openclaw_start()``, ``openclaw_adapter()``, ``openclaw_client()``, ``sms_paths()`` -> (log, archive),
``sms_owner()`` -> office id.
"""

import atexit
import datetime
import os
import threading

from . import bus, events, journal, settings

LIFE_DIR = "office-life"


class Context:
    """The injected server callables plus the package's live objects (one per process)."""

    def __init__(self):
        self.fns = {}
        self.bus = bus.BUS
        self.journal = None
        self.settings = settings.defaults()
        self.actions = {}            # name -> callable, registered by the scheduler/builders
        self.settings_listeners = []
        self.started = False
        self._lock = threading.RLock()
        self._roster_rows = []

    def fn(self, name):
        value = self.fns.get(name)
        return value if callable(value) else None

    def call(self, name, *args, default=None, **kwargs):
        """Call an injected callable; ``default`` when it is missing or fails."""
        func = self.fn(name)
        if func is None:
            return default
        try:
            return func(*args, **kwargs)
        except Exception:
            return default

    # ── roster ──
    def roster_rows(self):
        rows = self.call("roster_rows", default=None)
        if isinstance(rows, list):
            self._roster_rows = [row for row in rows if isinstance(row, dict) and row.get("key")]
            return list(self._roster_rows)
        return None

    def visible_keys(self):
        rows = self.roster_rows()
        return None if rows is None else {str(row["key"]) for row in rows}

    def names(self):
        rows = self.roster_rows() or []
        return {str(row["key"]): str(row.get("name") or row["key"]) for row in rows}

    # ── settings and time ──
    def enabled(self):
        return bool(self.settings.get("enabled", True))

    def feature(self, name):
        return self.enabled() and bool((self.settings.get("features") or {}).get(name, True))

    def tz_name(self):
        return settings.office_tz(self.settings)

    def apply_settings(self, new_settings, publish=True):
        with self._lock:
            self.settings = settings.normalize(new_settings)
        for listener in list(self.settings_listeners):
            try:
                listener(self.settings)
            except Exception:
                pass
        if publish:
            # The resolved office zone rides along so open pages switch zones without a reload.
            self.bus.publish({"type": "settings", "settings": settings.public(self.settings), "tz": self.tz_name()})
        return self.settings

    def on_settings(self, callback):
        self.settings_listeners.append(callback)


CTX = Context()


def _parse_created(value):
    """``createdAt`` as an aware datetime: numbers < 1e12 are seconds, else ms; strings are ISO."""
    if value is None or isinstance(value, bool):
        return None
    try:
        if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().replace(".", "", 1).isdigit()):
            number = float(value)
            if number <= 0:
                return None
            seconds = number if number < 1e12 else number / 1000.0
            return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
        text = str(value).strip()
        if not text:
            return None
        parsed = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def birthdays(rows, today, tz):
    """``{agent: years}`` for roster rows whose office anniversary (createdAt month/day in the
    office time zone) is ``today`` and at least one year old. Feb 29 counts on Feb 28 in other
    years. Rows without ``createdAt`` are skipped (never guessed)."""
    out = {}
    for row in rows or []:
        created = _parse_created(row.get("createdAt"))
        if created is None:
            continue
        local = created.astimezone(tz).date()
        years = today.year - local.year
        if years < 1:
            continue
        month, day = local.month, local.day
        if (month, day) == (2, 29) and not _leap(today.year):
            month, day = 2, 28
        if (today.month, today.day) == (month, day):
            out[str(row["key"])] = years
    return out


def _leap(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def today_info():
    """``/state.today``: birthdays, cake (a project finished today), champion of the day."""
    info = {"birthdays": [], "birthdayYears": {}, "cake": False}
    jr = CTX.journal
    if jr is None:
        return info
    summary = jr.summary()
    office = summary.get("office") or {}
    if CTX.feature("celebrations"):     # Calm keeps signs, icons and decor, the cake included (design 7.4)
        info["cake"] = int(office.get("cakes") or 0) > 0
    if office.get("champion"):
        info["champion"] = office["champion"]
    seasons_cfg = CTX.settings.get("seasons") or {}
    if CTX.feature("seasons") and seasons_cfg.get("birthdays", True):
        today = datetime.date.fromisoformat(jr.today())
        years = birthdays(CTX.roster_rows() or [], today, jr.tz())
        info["birthdays"] = sorted(years)
        info["birthdayYears"] = years
    return info


def _optional(name):
    """Import an optional sibling module (sources, scheduler) built by another phase."""
    try:
        module = __import__(f"{__name__}.{name}", fromlist=[name])
    except ImportError:
        return None
    return module


def start(**fns):
    """Boot Office life once: settings, journal (prune), bus wiring, then sources and the
    scheduler when present. Safe to call again (updates the injected callables only)."""
    with CTX._lock:
        CTX.fns.update({k: v for k, v in fns.items() if v is not None})
        if CTX.started:
            return CTX
        CTX.started = True
    config = CTX.call("read_config", default={}) or {}
    CTX.settings = settings.load(config)
    data_dir = str(CTX.fns.get("data_dir") or "/data")
    CTX.journal = journal.Journal(os.path.join(data_dir, LIFE_DIR), tz_name=CTX.tz_name)
    CTX.bus.configure(journal=CTX.journal, roster=CTX.visible_keys, enabled=CTX.enabled)
    try:
        CTX.journal.prune(CTX.settings["journal"]["retentionDays"])
    except Exception:
        pass
    atexit.register(shutdown)
    for name in ("sources", "scheduler"):
        module = _optional(name)
        starter = getattr(module, "start", None) if module is not None else None
        if callable(starter):
            try:
                starter(CTX)
            except Exception as exc:  # a broken optional part never stops the office
                print(f"[office-life] {name} did not start: {type(exc).__name__}: {exc}")
    return CTX


def shutdown():
    for name in ("scheduler", "sources"):
        module = _optional(name)
        stopper = getattr(module, "stop", None) if module is not None else None
        if callable(stopper):
            try:
                stopper()
            except Exception:
                pass
    if CTX.journal is not None:
        try:
            CTX.journal.flush()
        except Exception:
            pass


__all__ = ["CTX", "start", "shutdown", "today_info", "birthdays", "bus", "events", "journal", "settings"]
