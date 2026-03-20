#!/bin/bash
# Runs on HOST, collects API usage data and writes to shared volume for Docker container.
# Set VO_STATUS_DIR to match your Docker volume mount. Default: /tmp/vo-data
STATUS_DIR="${VO_STATUS_DIR:-/tmp/vo-data}"
OUT="$STATUS_DIR/api-usage.json"
mkdir -p "$STATUS_DIR"

python3 << 'PYEOF'
import json, time, os, urllib.request, urllib.error, subprocess, math

env = {**os.environ, "PATH": os.path.expanduser("~/.npm-global/bin") + ":" + os.environ.get("PATH", "")}
proc = subprocess.run(["openclaw", "models", "status", "--json"], capture_output=True, text=True, timeout=15, env=env)
json_data = json.loads(proc.stdout) if proc.stdout else {}

auth = json_data.get("auth", {})
oauth_providers = auth.get("oauth", {}).get("providers", [])

result = {
    "providers": [],
    "timestamp": time.time(),
    "apiHealth": {},
    "quotaBucketsAvailable": False,
}

def format_remaining_ms(ms):
    if ms is None:
        return None
    secs = max(0, int(ms / 1000))
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    if days > 0:
        return f"{days}d {hours}h"
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"

provider_map = {}
for op in oauth_providers:
    prov = op.get("provider", "")
    if prov not in ("anthropic", "openai", "openai-codex"):
        continue
    entry = {
        "provider": prov,
        "status": op.get("status", "unknown"),
        "profiles": [],
        "usageAvailable": False,
    }
    for prof in op.get("profiles", []):
        p = {
            "id": prof.get("profileId", ""),
            "type": prof.get("type", ""),
            "status": prof.get("status", ""),
        }
        if prof.get("expiresAt"):
            p["expiresAt"] = prof["expiresAt"]
            p["remainingMs"] = prof.get("remainingMs", 0)
        entry["profiles"].append(p)
    if op.get("expiresAt"):
        entry["expiresAt"] = op["expiresAt"]
        entry["remainingMs"] = op.get("remainingMs", 0)
    provider_map[prov] = entry
    result["providers"].append(entry)

# Pull live quota windows via OpenClaw's internal usage loader
try:
    node_script = r'''
import { yi as loadProviderUsageSummary } from 'openclaw/dist/reply-Bm8VrLQh.js';
const ocHome = process.env.VO_OPENCLAW_PATH || process.env.HOME + '/.openclaw';
const agentDir = ocHome + '/agents/main/agent';
const out = await loadProviderUsageSummary({ providers: ['openai-codex'], agentDir, timeoutMs: 8000 });
console.log(JSON.stringify(out));
'''
    proc_usage = subprocess.run(
        ["node", "--input-type=module", "-e", node_script],
        capture_output=True, text=True, timeout=15, env=env
    )
    usage_data = json.loads(proc_usage.stdout) if proc_usage.stdout else {}
    now_ms = int(time.time() * 1000)
    for snap in usage_data.get("providers", []):
        prov = snap.get("provider")
        entry = provider_map.get(prov)
        if not entry:
            continue
        windows = snap.get("windows") or []
        if len(windows) >= 1:
            first = windows[0]
            reset_at = first.get("resetAt")
            remaining = format_remaining_ms(reset_at - now_ms) if reset_at else None
            entry.setdefault("usage", {})["dailyWindow"] = first.get("label", "Day")
            entry["usage"]["dailyPctLeft"] = max(0, 100 - int(first.get("usedPercent", 0)))
            entry["usage"]["dailyTimeLeft"] = remaining or "--"
        if len(windows) >= 2:
            second = windows[1]
            reset_at = second.get("resetAt")
            remaining = format_remaining_ms(reset_at - now_ms) if reset_at else None
            entry.setdefault("usage", {})["weeklyPctLeft"] = max(0, 100 - int(second.get("usedPercent", 0)))
            entry["usage"]["weeklyTimeLeft"] = remaining or "--"
        if entry.get("usage"):
            entry["usageAvailable"] = True
            result["quotaBucketsAvailable"] = True
        if snap.get("plan"):
            entry["plan"] = snap.get("plan")
        if snap.get("error"):
            entry["usageError"] = snap.get("error")
except Exception as e:
    result["usageLoadError"] = str(e)

# Read auth-profiles for stats and API key health
profiles_path = os.path.expanduser("~/.openclaw/agents/main/agent/auth-profiles.json")
try:
    with open(profiles_path) as f:
        ap = json.load(f)
    result["usageStats"] = ap.get("usageStats", {})
    result["lastGood"] = ap.get("lastGood", {})

    # Help the UI choose an active Codex profile even when lastGood lacks one
    if "openai-codex" not in result["lastGood"]:
        for prof_id, prof in ap.get("profiles", {}).items():
            if prof.get("provider") == "openai-codex":
                result["lastGood"]["openai-codex"] = prof_id
                break

    # Check API key health for each provider
    for prof_id, prof in ap.get("profiles", {}).items():
        if prof.get("type") != "api_key":
            continue
        provider = prof.get("provider")
        key = prof.get("key", "")
        health = {"profileId": prof_id, "provider": provider, "status": "unknown"}

        try:
            if provider == "anthropic":
                req = urllib.request.Request(
                    "https://api.anthropic.com/v1/messages",
                    data=json.dumps({"model":"claude-sonnet-4-6","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}).encode(),
                    headers={
                        "x-api-key": key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json"
                    }
                )
                urllib.request.urlopen(req, timeout=5)
                health["status"] = "ok"
            elif provider == "openai":
                req = urllib.request.Request(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {key}"}
                )
                urllib.request.urlopen(req, timeout=5)
                health["status"] = "ok"
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode()
            except Exception:
                pass
            if e.code == 401:
                health["status"] = "invalid"
                health["message"] = "Invalid API key"
            elif e.code == 402 or "credit balance is too low" in body or "insufficient_quota" in body:
                health["status"] = "exhausted"
                health["message"] = "Budget exhausted"
            elif e.code == 429:
                health["status"] = "rate_limited"
                health["message"] = "Rate limited"
            elif "billing" in body.lower() or "quota" in body.lower() or "credit" in body.lower():
                health["status"] = "exhausted"
                health["message"] = body[:100]
            else:
                health["status"] = "error"
                health["message"] = f"HTTP {e.code}: {body[:100]}"
        except Exception as e:
            health["status"] = "error"
            health["message"] = str(e)[:100]

        result["apiHealth"][prof_id] = health

except Exception as e:
    result["error"] = str(e)

with open("/tmp/office-shared/api-usage.json", "w") as f:
    json.dump(result, f, indent=2)
PYEOF
