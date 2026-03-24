#!/usr/bin/env python3
"""API Usage Collector — runs on the HOST (not in container).
Calls `openclaw status --usage --json` and writes results to /tmp/vo-data/api-usage.json.
Run via cron, systemd timer, or loop."""

import json
import os
import subprocess
import sys
import time

STATUS_DIR = os.environ.get("VO_STATUS_DIR", "/tmp/vo-data")
USAGE_FILE = os.path.join(STATUS_DIR, "api-usage.json")
os.makedirs(STATUS_DIR, exist_ok=True)


def collect():
    try:
        result = subprocess.run(
            ["openclaw", "status", "--usage", "--json"],
            capture_output=True, text=True, timeout=20
        )
        if result.returncode != 0 or not result.stdout.strip():
            return {"providers": [], "timestamp": time.time(), "error": "openclaw status failed"}

        raw = json.loads(result.stdout)
        usage = raw.get("usage", {})
        oc_providers = usage.get("providers", [])
        ts = (usage.get("updatedAt", 0) or 0) / 1000 or time.time()
        now = time.time()

        api_providers = []
        for p in oc_providers:
            windows = p.get("windows", [])
            entry = {
                "provider": p.get("provider", "unknown"),
                "displayName": p.get("displayName", p.get("provider", "Unknown")),
                "plan": p.get("plan"),
                "error": p.get("error"),
            }
            if windows:
                usage_obj = {}
                for w in windows:
                    label = (w.get("label") or "").lower()
                    used = w.get("usedPercent", 0)
                    left = 100 - used
                    reset_at = w.get("resetAt", 0)
                    time_left = format_time_left(reset_at, now) if reset_at else ""

                    if label in ("5h", "day", "daily", "24h"):
                        usage_obj["dailyPctLeft"] = left
                        usage_obj["dailyWindow"] = w.get("label", "Day")
                        usage_obj["dailyTimeLeft"] = time_left
                    elif label in ("week", "weekly"):
                        usage_obj["weeklyPctLeft"] = left
                        usage_obj["weeklyTimeLeft"] = time_left
                    elif label in ("month", "monthly"):
                        usage_obj["monthlyPctLeft"] = left
                        usage_obj["monthlyTimeLeft"] = time_left
                    else:
                        usage_obj[f"{label}PctLeft"] = left
                        usage_obj[f"{label}TimeLeft"] = time_left
                entry["usage"] = usage_obj
                entry["windows"] = windows
            api_providers.append(entry)

        return {"providers": api_providers, "timestamp": ts, "source": "openclaw-status"}

    except Exception as e:
        return {"providers": [], "timestamp": time.time(), "error": str(e)}


def format_time_left(reset_at_ms, now_s):
    diff = (reset_at_ms / 1000) - now_s
    if diff <= 0:
        return "resetting..."
    hours = int(diff // 3600)
    mins = int((diff % 3600) // 60)
    if hours > 24:
        days = hours // 24
        return f"{days}d {hours % 24}h"
    if hours > 0:
        return f"{hours}h {mins}m"
    return f"{mins}m"


def main():
    loop = "--loop" in sys.argv
    interval = 60  # seconds

    while True:
        data = collect()
        try:
            with open(USAGE_FILE, "w") as f:
                json.dump(data, f, indent=2)
            n = len(data.get("providers", []))
            err = data.get("error", "")
            print(f"{time.strftime('%H:%M:%S')} Updated {USAGE_FILE}: {n} providers" +
                  (f" (error: {err})" if err else ""))
        except Exception as e:
            print(f"Write error: {e}", file=sys.stderr)

        if not loop:
            break
        time.sleep(interval)


if __name__ == "__main__":
    main()
