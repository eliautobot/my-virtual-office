# Alpha Cleanup Execution Plan

## Status: COMPLETE ✅

All items verified and deployed to vo-product container on 2026-03-20.

### Phase 1: Clean Config Template ✅
- [x] vo-config.json — generic defaults, no Eli data, all features off by default

### Phase 2: Remove Hardcoded Agent References ✅
- [x] game.js — removed hardcoded appearance map (now uses seeded random generation from agent ID)
- [x] game.js — removed hardcoded identity accessories (elix bowtie, moe belt, etc)
- [x] cron.html — dynamic agent list fetched from /api/agents
- [x] cron.html — dynamic title from config
- [x] cron.html — removed hardcoded gateway token (loaded from /session-info)
- [x] cron.html — removed hardcoded delivery accounts and quick-send buttons
- [x] models.html — dynamic title from config

### Phase 3: Clean Helper Scripts ✅
- [x] update_status.py — uses STATUS_DIR env var, auto-discovers agents from status file
- [x] office-sync.sh — uses VO_OPENCLAW_PATH/VO_STATUS_DIR env vars, auto-discovers from agents dir
- [x] prime-agents.sh — uses VO_OPENCLAW_PATH env var, auto-discovers from agents dir
- [x] api-usage-collector.sh — uses VO_STATUS_DIR/VO_OPENCLAW_PATH env vars
- [x] media-cleanup.sh — uses VO_OPENCLAW_PATH env var
- [x] model-change-watcher.sh — uses VO_STATUS_DIR/VO_OPENCLAW_PATH env vars

### Phase 4: Remove Files That Shouldn't Ship ✅
- [x] .dockerignore added (excludes .bak, __pycache__, .git, vo-config.eli.json)
- [x] vo-config.eli.json excluded from Docker build via .dockerignore

### Phase 5: Add Missing Files ✅
- [x] LICENSE (MIT)
- [x] .dockerignore

### Phase 6: Server.py Cleanup ✅
- [x] Removed /home/eliubuntu fallback path
- [x] All SMS paths use STATUS_DIR
- [x] SMS credentials config-driven (not hardcoded)
- [x] Added /sms-status health endpoint
- [x] Added /browser-status health endpoint

### Phase 7: Feature Gates ✅
- [x] Browser panel — feature-gated, auto-hides when disabled, guided setup
- [x] SMS panel — feature-gated, auto-hides when disabled, guided setup
- [x] PC metrics — feature-gated (already was)
- [x] Whisper STT — feature-gated (already was)

### Phase 8: Test & Verify ✅
- [x] Python syntax check — all .py files pass
- [x] JS syntax check — all .js files pass
- [x] Bash syntax check — all .sh files pass
- [x] Deploy to vo-product container — all 17 files deployed
- [x] /setup wizard — 5 steps verified (name, agents, browser, SMS, done)
- [x] /browser-status — returns correct JSON
- [x] /sms-status — returns correct JSON
- [x] /api/agents — discovers 15 agents
- [x] /vo-config — returns config with browser/SMS fields
- [x] Zero Eli-specific references in shipping code
- [x] Zero hardcoded credentials in shipping code
