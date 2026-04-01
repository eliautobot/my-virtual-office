# QA Report: Code Quality and Portability Scan
**Date:** 2026-04-01  
**Scope:** Projects/Tasks/Workflow code in `server.py` + full pre-push scan  
**Status:** ✅ PASS — No blocking issues found

---

## Checklist Results

### 1. ✅ Hardcoded Personal Paths, IPs, Tokens, API Keys in server.py

**Result: CLEAN** — Zero hardcoded personal data found in server.py.

Scanned for: `eliubuntu`, `/home/`, hardcoded IPs (`100.93.199.57`, `100.101.16.92`, `192.168.*`), `ghp_`, hardcoded token strings, API keys.

- `grep -n "eliubuntu\|/home/" server.py` → **no matches**
- `grep -n "100\.\|192\.168\|ghp_" server.py` → **no matches**
- All token references are runtime config reads (e.g., `_get_gateway_token()`, `profile.get("token")`)

### 2. ✅ File Paths Use Configurable Variables

All project/task file paths derive from config, not hardcoded paths:

| Variable | Source | Used For |
|---|---|---|
| `STATUS_DIR` | `VO_CONFIG["presence"]["statusDir"]` | Base data directory |
| `PROJECTS_FILE` | `os.path.join(STATUS_DIR, "projects.json")` | Projects database |
| `TASK_FILES_DIR` | `os.path.join(STATUS_DIR, "project-tasks")` | Task markdown files |
| `SCORES_FILE` | `os.path.join(STATUS_DIR, "project-scores.json")` | Gamification scores |
| `WORKSPACE_BASE` | `VO_CONFIG["openclaw"]["homePath"]` | OpenClaw home |

Config resolution chain (lines 22-98):
1. `VO_CONFIG` env var → explicit path
2. `VO_STATUS_DIR` env var → `/data/vo-config.json`
3. `/app/vo-config.json` fallback
4. Defaults: `statusDir` → `/tmp/vo-data`, `homePath` → `~/.openclaw`

No hardcoded absolute paths in any project/task function.

### 3. ✅ Workflow Engine Portability (HTTP + CLI Fallback)

`_wf_call_agent()` (line 2043) implements proper dual-path fallback:

**HTTP path (`_wf_call_agent_http`, line 2071):**
- Gateway URL from config: `VO_CONFIG.get("openclaw", {}).get("gatewayHttp", "http://127.0.0.1:18789")`
- Token from `_get_gateway_token()` → checks vo-config.json first, then openclaw.json
- Returns `None` on 404/405 or non-JSON response → triggers CLI fallback
- Returns `None` on connection errors → triggers CLI fallback

**CLI path (`_wf_call_agent_cli`, line 2121):**
- Uses `shutil.which("openclaw")` — no hardcoded binary path
- Returns descriptive error if CLI not found: `"[ERROR] openclaw CLI not found in PATH"`
- Proper timeout handling with `timeout + 60` buffer

**Fallback logic is correct:** HTTP first → `None` means "not available" → CLI second. Non-None errors (HTTP 500, etc.) are returned as-is (appropriate — the gateway IS available, just erroring).

**Works without OpenClaw CLI:** Yes — if gateway HTTP is configured and running, CLI is never called. The `_wf_call_agent_http` function is self-contained using only `urllib`.

### 4. ✅ Pre-Push Scan Results

Scanned pattern: `VO_DEV|_VO_INT|bypass|ghp_|token.*=|auth.*key|eliubuntu|f2d0bb2d`  
Scope: All `.py`, `.js`, `.json`, `.md` files (excluding `.git/`)

#### Acceptable Hits (expected):

| File | Match | Reason |
|---|---|---|
| `app/license.py:9` | "bypass, circumvent, or disable" | Anti-tampering comment ✅ |
| `app/license.py:57` | "forge or bypass activation" | Anti-tampering comment ✅ |
| `app/license.py:59` | "bypass this system" | Anti-tampering comment ✅ |
| `app/license.py:130` | `_VO_INT` | Dev bypass env var check ✅ |
| `tests/test_workflow_e2e.py:188-194` | `eliubuntu`, `ghp_`, `f2d0bb2d` | Test patterns that **detect** hardcoded values ✅ |

#### Documentation Hits (not in shipped code):

| File | Match | Reason |
|---|---|---|
| `INTEGRATION-SPEC.md` (6 refs) | `eliubuntu` paths | Historical audit doc listing OLD hardcoded values that were already removed. Not executable code. |
| `ALPHA-CLEANUP.md:36` | `eliubuntu` | Changelog entry: "Removed /home/eliubuntu fallback path" |

#### Runtime Config Reads (not hardcoded secrets):

| File | Match | Reason |
|---|---|---|
| `app/server.py` (8 refs) | `token =`, `auth.*key` | Runtime reads from config/profiles via `_get_gateway_token()`, `profile.get("token")`, `"api_key"` string literals |
| `app/chat.js:639` | `d.token` | JS runtime token assignment from server response |
| `app/game.js` (2 refs) | `token` | UI input field references |
| `app/gateway_presence.py:583` | `gateway_token` | Function parameter name |
| `app/api-usage.js:74` | `auth.*key` | Display label `'API Key'` |
| `app/office.py` (2 refs) | `agent-key`, `author` | CLI help text/arg names |
| `PROJECTS-FEATURE-SPEC.md:63` | `author` | JSON schema example |

#### ⚠️ Items to Note (non-blocking):

None. All hits are either:
- Expected license.py bypass references
- Test assertions checking FOR hardcoded values
- Documentation of already-fixed issues
- Runtime config reads (no secrets in source)

---

## Summary

| Check | Status |
|---|---|
| No hardcoded personal data in server.py | ✅ PASS |
| Configurable file paths | ✅ PASS |
| HTTP/CLI fallback works without openclaw CLI | ✅ PASS |
| Pre-push scan clean | ✅ PASS |

**Verdict: Ready for push.** No code changes required — the codebase is clean.
