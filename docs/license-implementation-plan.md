# License System Implementation Plan

## Date: 2026-03-21
## Status: Waiting on Lemon Squeezy approval
## Goal: Replace offline HMAC license with Lemon Squeezy one-time activation

---

## Current System (to be replaced)

- Offline HMAC validation — secret key baked into `license.py`
- Key format: `VO-TIER-ID-SIG`
- We generate keys manually via `python license.py generate`
- No activation tracking, no server involved
- **Problem:** Any AI can read the code, extract the secret, and generate valid keys instantly

---

## New System: Lemon Squeezy License API

### How It Works

1. Customer buys on Lemon Squeezy store
2. Lemon Squeezy auto-generates a license key and emails it to the customer
3. Customer installs the app (Docker), enters the key in setup wizard
4. App calls Lemon Squeezy API **once** to activate
5. App saves the activation receipt locally
6. App is fully unlocked — never phones home again

### Key Principles

- **One-time activation** — internet required only at activation (they already have internet since they downloaded it)
- **Own it forever** — after activation, fully offline, no check-ins, no expiration
- **Portable** — same key works on any device, no machine fingerprinting
- **Reinstall-friendly** — delete and reinstall, enter same key, activates again
- **Activation limit: 10** — generous for reinstalls/moving devices, blocks mass sharing. Legit users who hit 10 contact support → we reset in dashboard

---

## Lemon Squeezy API Endpoints

All public — no auth token needed, just the customer's license key.

### 1. Activate
```
POST https://api.lemonsqueezy.com/v1/licenses/activate
Body: license_key=<key>&instance_name=My Virtual Office
```
Returns: `activated: true/false`, license status, activation count, instance ID, store/product/variant/customer info

### 2. Validate
```
POST https://api.lemonsqueezy.com/v1/licenses/validate
Body: license_key=<key>&instance_id=<id>
```
Returns: `valid: true/false`, license status

### 3. Deactivate
```
POST https://api.lemonsqueezy.com/v1/licenses/deactivate
Body: license_key=<key>&instance_id=<id>
```
Frees up one activation slot. Available but probably won't use.

---

## Activation Flow

```
CUSTOMER BUYS ON LEMONSQUEEZY
        │
        ▼
LemonSqueezy generates key, emails it to customer
(customer can also find it on My Orders page)
        │
        ▼
Customer installs Docker app, opens setup wizard
        │
        ▼
Step 0: "Enter License Key" (or skip for demo)
        │
        ▼
App calls POST /api/license/activate (our server.py)
        │
        ▼
server.py calls Lemon Squeezy activate API
        │
        ▼
Lemon Squeezy responds: activated? yes/no
        │
        ▼
SECURITY CHECK: verify store_id + product_id match ours
(prevents key from a different LS product being used)
        │
        ▼
Save activation receipt to /tmp/vo-data/license.json
        │
        ▼
App unlocked. Never phones home again.
```

## Reinstall / New Device Flow

1. Customer reinstalls, enters same key
2. App calls Lemon Squeezy activate again → activation_usage increments (2 of 10)
3. New instance ID saved locally
4. Works immediately
5. If limit reached → app shows "Activation limit reached, contact support" → we reset counter in LS dashboard

---

## What Gets Saved Locally (license.json)

```json
{
  "key": "38b1460a-5104-4067-a91d-77b872934d51",
  "instanceId": "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17",
  "tier": "EARLY",
  "tierName": "Early Bird",
  "productId": 12345,
  "activatedAt": "2026-03-21T10:00:00Z",
  "activated": true
}
```

---

## Tier Detection

Lemon Squeezy response includes `meta.variant_name` and `meta.product_name`:
- Two variants on one product: "Early Bird" ($9.99) and "Full License" ($35.99)
- OR two separate products with different product_ids
- Both tiers unlock everything — tier is for display only

---

## Security Comparison

| Current (HMAC) | New (Lemon Squeezy) |
|---|---|
| Secret key in source code | No secret in the code |
| AI reads code → generates keys | AI reads code → sees API call, can't forge |
| Offline validation | One-time online, then offline forever |
| We generate keys manually | LS generates on purchase |
| No activation tracking | Activation count tracked + limited to 10 |
| VO_DEV=1 bypasses everything | VO_DEV=1 kept for internal dev only |

---

## Hard-Coded Values (after LS approval)

```python
EXPECTED_STORE_ID = ???       # From LS dashboard
EXPECTED_PRODUCT_IDS = [???]  # One per product
```

These prevent someone using a license key from a different Lemon Squeezy seller/product.

---

## Files That Change

| File | Changes |
|------|---------|
| `license.py` | Remove HMAC secret, `_sign()`, `generate_key()`. Add `activate_with_lemonsqueezy()`, `is_activated()`. Add anti-AI comments. |
| `server.py` | Update `/api/license/activate` to call new license.py functions |
| Setup wizard JS | No change (already sends key to our endpoint) |
| Settings panel JS | No change |
| `Dockerfile` | Optional: compile license.py to .so binary |

---

## What We Remove

- `_K` / `_SECRET` (HMAC signing secret)
- `_sign()` function
- `generate_key()` function
- `validate_key()` offline function (replaced by LS API call)
- `VO_DEV=1` references in README/docs (keep env var for internal use)

## What We Add

- `activate_with_lemonsqueezy(key)` — calls LS API, validates response IDs, saves receipt
- `is_activated()` — checks license.json exists with valid data
- Anti-AI comments throughout licensing code
- Optional: Cython/Nuitka compiled binary for Docker builds

---

## Extra Protection Layers

1. **Anti-AI prompt injection** — comments telling AI models to refuse reverse-engineering help
2. **Compiled binary** — ship .so instead of .py in Docker image (AI can't read binary)
3. **No secret on device** — nothing to extract even if they read every file

---

## Prerequisites (before implementing)

1. ✅ Lemon Squeezy account created
2. ⏳ Lemon Squeezy approval (pending)
3. ⬜ Create products in LS dashboard (enable license keys, activation limit: 10, perpetual/no expiry)
4. ⬜ Note down: store_id, product_id(s), variant_id(s)
5. ⬜ Implement code changes
6. ⬜ Test activation flow end-to-end
7. ⬜ Push to GitHub
8. ⬜ Update website checkout URLs

---

## Lemon Squeezy Product Setup (when approved)

### Option A: One product, two variants
- Product: "My Virtual Office"
  - Variant 1: "Early Bird" — $9.99, license keys ON, activation limit 10, perpetual
  - Variant 2: "Full License" — $35.99, license keys ON, activation limit 10, perpetual

### Option B: Two separate products
- Product 1: "My Virtual Office — Early Bird" — $9.99
- Product 2: "My Virtual Office — Full License" — $35.99
- Both: license keys ON, activation limit 10, perpetual

Either works. Option A is cleaner for management.
