"""Office life settings (design 4): defaults, validation, public view, office time zone, save.

Stored in vo-config.json under ``officeLife``. A missing key means defaults; a stored value that
does not validate falls back to its default (``normalize``), while a POST that does not validate
is refused with the list of problems (``validate``). Unknown keys are dropped.
"""

import copy
import datetime
import os
import re

try:
    from zoneinfo import available_timezones
except ImportError:  # pragma: no cover
    def available_timezones():
        return {"UTC"}

CONFIG_KEY = "officeLife"
FEATURES = ("needsYou", "interns", "handoffs", "visitors", "alarmClock", "moods", "celebrations", "standup",
            "seasons", "tournaments", "newspaper", "reactions")
HOLIDAYS = ("newYear", "valentines", "earthDay", "halloween", "yearEndLights")
ICONS = ("cake", "star", "heart", "balloon", "flag")
FREQUENCIES = ("daily", "twice", "off")
CUSTOM_MAX = 12
CUSTOM_NAME_MAX = 24
RETENTION_MIN, RETENTION_MAX = 1, 60
# Office-wide safety cap on intern characters (one per running helper below it); 24 keeps a phone office smooth.
INTERNS_SHOWN_MIN, INTERNS_SHOWN_MAX, INTERNS_SHOWN_DEFAULT = 1, 48, 24

DEFAULTS = {
    "enabled": True,
    "calm": False,
    "timeZone": "",
    "features": {name: True for name in FEATURES},
    "standup": {"time": "09:30", "days": [1, 2, 3, 4, 5]},
    "newspaper": {"time": "18:00"},
    "seasons": {"decor": True, "fridayTreat": True, "rain": True, "birthdays": True,
                "holidays": {name: True for name in HOLIDAYS}, "custom": []},
    "tournaments": {"frequency": "daily"},
    "interns": {"maxShown": INTERNS_SHOWN_DEFAULT},
    "journal": {"retentionDays": 14},
}

_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")
_DATE_RE = re.compile(r"^(\d{2})-(\d{2})$")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]+")
_ZONES = None


def defaults():
    return copy.deepcopy(DEFAULTS)


def zones():
    global _ZONES
    if _ZONES is None:
        try:
            _ZONES = frozenset(available_timezones()) | {"UTC"}
        except Exception:
            _ZONES = frozenset({"UTC"})
    return _ZONES


def valid_zone(name):
    return isinstance(name, str) and name in zones()


def _time(value):
    match = _TIME_RE.match(str(value or "").strip()) if isinstance(value, str) else None
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def _days(value):
    if not isinstance(value, list):
        return None
    out = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or not 1 <= item <= 7:
            return None
        if item not in out:
            out.append(item)
    return sorted(out)


def _month_day(value):
    match = _DATE_RE.match(str(value or "").strip()) if isinstance(value, str) else None
    if not match:
        return None
    month, day = int(match.group(1)), int(match.group(2))
    try:
        datetime.date(2028, month, day)        # a leap year: 02-29 is a valid occasion
    except ValueError:
        return None
    return f"{month:02d}-{day:02d}"


def _custom(value, errors):
    if not isinstance(value, list):
        errors.append(("seasons.custom", "Custom occasions must be a list."))
        return None
    if len(value) > CUSTOM_MAX:
        errors.append(("seasons.custom", f"At most {CUSTOM_MAX} custom occasions."))
        return None
    out = []
    for index, row in enumerate(value):
        field = f"seasons.custom.{index}"
        if not isinstance(row, dict):
            errors.append((field, "Each occasion needs a name and a date."))
            continue
        name = _CTRL_RE.sub(" ", str(row.get("name") or "")).strip()[:CUSTOM_NAME_MAX].strip()
        date = _month_day(row.get("date"))
        icon = row.get("icon") or "star"
        if not name:
            errors.append((field + ".name", "Give the occasion a name."))
        if not date:
            errors.append((field + ".date", "Use a date like 06-15 (month-day)."))
        if icon not in ICONS:
            errors.append((field + ".icon", "Pick one of the listed icons."))
        if name and date and icon in ICONS:
            out.append({"name": name, "date": date, "icon": icon})
    return out


def _merge(base, body, errors, path=""):
    """Apply ``body`` onto a copy of ``base`` following the shape of DEFAULTS."""
    out = copy.deepcopy(base)
    shape = _shape_at(path)
    for key, value in body.items():
        if key not in shape:
            continue                                   # unknown keys are dropped
        field = f"{path}.{key}" if path else key
        expected = shape[key]
        if field == "seasons.custom":
            custom = _custom(value, errors)
            if custom is not None:
                out[key] = custom
        elif field == "timeZone":
            if not isinstance(value, str) or (value.strip() and not valid_zone(value.strip())):
                errors.append((field, "Pick a time zone from the list."))
            else:
                out[key] = value.strip()
        elif field in ("standup.time", "newspaper.time"):
            parsed = _time(value)
            if parsed is None:
                errors.append((field, "Use a time like 09:30 (24-hour)."))
            else:
                out[key] = parsed
        elif field == "standup.days":
            parsed = _days(value)
            if parsed is None:
                errors.append((field, "Days are numbers 1 (Monday) to 7 (Sunday)."))
            else:
                out[key] = parsed
        elif field == "tournaments.frequency":
            if value not in FREQUENCIES:
                errors.append((field, "Choose daily, twice a day or off."))
            else:
                out[key] = value
        elif field == "journal.retentionDays":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                errors.append((field, "Keep the history for 1 to 60 days."))
            else:
                out[key] = max(RETENTION_MIN, min(RETENTION_MAX, int(value)))
        elif field == "interns.maxShown":
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not -1e9 < value < 1e9:  # NaN/inf
                errors.append((field, "Show 1 to 48 interns at most."))
            else:
                out[key] = max(INTERNS_SHOWN_MIN, min(INTERNS_SHOWN_MAX, int(value)))
        elif isinstance(expected, dict):
            if not isinstance(value, dict):
                errors.append((field, "Expected a group of settings."))
            else:
                out[key] = _merge(out.get(key) if isinstance(out.get(key), dict) else expected, value, errors, field)
        elif isinstance(expected, bool):
            if not isinstance(value, bool):
                errors.append((field, "Expected on or off."))
            else:
                out[key] = value
    return out


def _shape_at(path):
    shape = DEFAULTS
    for part in [p for p in path.split(".") if p]:
        shape = shape.get(part) if isinstance(shape, dict) else {}
    return shape if isinstance(shape, dict) else {}


def validate(body, base=None):
    """``(settings, errors)``: ``body`` (a full or partial settings object) merged onto ``base``
    (current settings, defaults when None). ``errors`` is a list of ``{"field", "message"}``."""
    errors = []
    base = normalize(base)
    if not isinstance(body, dict):
        return base, [{"field": "", "message": "Settings must be a JSON object."}]
    merged = _merge(base, body, errors)
    return merged, [{"field": f, "message": m} for f, m in errors]


def normalize(raw):
    """Stored settings made whole: every invalid or missing value takes its default."""
    out = defaults()
    if not isinstance(raw, dict):
        return out
    for key in list(raw):
        errors = []
        merged = _merge(out, {key: raw[key]}, errors)
        if not errors:
            out = merged
        elif isinstance(raw[key], dict):
            # keep the valid parts of a group with one bad value
            for sub in raw[key]:
                sub_errors = []
                merged = _merge(out, {key: {sub: raw[key][sub]}}, sub_errors)
                if not sub_errors:
                    out = merged
    return out


def public(settings):
    """The view pages may read (there are no secrets in these settings)."""
    return copy.deepcopy(normalize(settings))


def load(config):
    """Settings from a vo-config dict."""
    return normalize((config or {}).get(CONFIG_KEY) if isinstance(config, dict) else None)


def office_tz(settings, env=None):
    """``timeZone``, else env ``VO_TIMEZONE`` / ``TZ`` when it names a known zone, else UTC."""
    env = os.environ if env is None else env
    name = str((settings or {}).get("timeZone") or "").strip()
    if valid_zone(name):
        return name
    for var in ("VO_TIMEZONE", "TZ"):
        value = str(env.get(var) or "").strip().lstrip(":")
        if valid_zone(value):
            return value
    return "UTC"


def save(config_path, settings, lock, read_json, write_json):
    """Store ``settings`` as vo-config ``officeLife`` under the vo-config file lock (read, set one
    key, atomic write). ``read_json`` raises when the file exists but cannot be read, so a broken
    config is never replaced."""
    with lock(config_path):
        existing = read_json(config_path)
        if existing is None:
            existing = {}
        existing[CONFIG_KEY] = normalize(settings)
        write_json(config_path, existing)
    return existing[CONFIG_KEY]
