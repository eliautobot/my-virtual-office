"""Virtual Office License System.

License key format: VO-{TIER}-{ID}-{SIG}
  - TIER: EARLY or FULL
  - ID: 8-char hex random identifier
  - SIG: 8-char hex HMAC signature

Validation is offline — no external server needed.
Dev mode: set VO_DEV=1 environment variable to bypass all checks.
"""
import hashlib
import hmac
import os
import json
import secrets
import time

# --- Config ---
_LICENSE_FILE = os.path.join(
    os.environ.get("VO_STATUS_DIR", "/tmp/vo-data"),
    "license.json"
)

# Signing secret — split and reassembled to discourage casual grep
_K = [0x76, 0x6f, 0x2d, 0x70, 0x69, 0x78, 0x65, 0x6c,
      0x2d, 0x6f, 0x66, 0x66, 0x69, 0x63, 0x65, 0x2d,
      0x32, 0x30, 0x32, 0x36, 0x2d, 0x73, 0x69, 0x67,
      0x6e, 0x2d, 0x6b, 0x65, 0x79, 0x2d, 0x61, 0x31]
_SECRET = bytes(_K)

TIERS = {
    "EARLY": {"name": "Early Bird", "price": "$9.99", "features": "all"},
    "FULL":  {"name": "Full License", "price": "$35.99", "features": "all"},
}

DEMO_LIMITS = {
    "maxAgents": 3,
    "browserPanel": False,
    "smsPanel": False,
    "cronManager": False,
    "whisper": False,
    "watermark": True,
}


def _sign(tier: str, key_id: str) -> str:
    """Generate HMAC signature for a tier+id pair."""
    payload = f"{tier}:{key_id.lower()}".encode()
    return hmac.new(_SECRET, payload, hashlib.sha256).hexdigest()[:8]


def generate_key(tier: str = "FULL") -> str:
    """Generate a new license key. Used by the seller/admin."""
    tier = tier.upper()
    if tier not in TIERS:
        raise ValueError(f"Unknown tier: {tier}. Must be one of {list(TIERS.keys())}")
    key_id = secrets.token_hex(4)  # 8 hex chars
    sig = _sign(tier, key_id)
    return f"VO-{tier}-{key_id}-{sig}"


def validate_key(key: str) -> dict:
    """Validate a license key. Returns {"valid": bool, "tier": str|None, "error": str|None}."""
    if not key or not isinstance(key, str):
        return {"valid": False, "tier": None, "error": "No key provided"}

    key = key.strip().upper()
    parts = key.split("-")

    # Expected: VO-TIER-ID-SIG (4 parts) or VO-EARLY-ID-SIG / VO-FULL-ID-SIG
    if len(parts) != 4 or parts[0] != "VO":
        return {"valid": False, "tier": None, "error": "Invalid key format"}

    tier = parts[1]
    key_id = parts[2]
    sig = parts[3]

    if tier not in TIERS:
        return {"valid": False, "tier": None, "error": f"Unknown tier: {tier}"}

    if len(key_id) != 8 or len(sig) != 8:
        return {"valid": False, "tier": None, "error": "Invalid key format"}

    expected_sig = _sign(tier, key_id.lower())
    if not hmac.compare_digest(sig.lower(), expected_sig.lower()):
        return {"valid": False, "tier": None, "error": "Invalid license key"}

    return {"valid": True, "tier": tier, "error": None}


def is_dev_mode() -> bool:
    """Check if dev mode is enabled (bypasses all license checks)."""
    return os.environ.get("VO_DEV", "").strip() in ("1", "true", "yes")


def get_license_status() -> dict:
    """Get current license status. Returns full status dict.

    Returns:
        {
            "licensed": bool,
            "tier": str|None,       # "EARLY", "FULL", or "DEV"
            "tierName": str,        # Human-readable tier name
            "demo": bool,           # True if running in demo mode
            "limits": dict|None,    # Demo limits if demo mode
            "activatedAt": str|None
        }
    """
    if is_dev_mode():
        return {
            "licensed": True,
            "tier": "DEV",
            "tierName": "Developer Mode",
            "demo": False,
            "limits": None,
            "activatedAt": None,
        }

    # Check saved license
    try:
        with open(_LICENSE_FILE, "r") as f:
            saved = json.load(f)
        key = saved.get("key", "")
        result = validate_key(key)
        if result["valid"]:
            tier_info = TIERS.get(result["tier"], {})
            return {
                "licensed": True,
                "tier": result["tier"],
                "tierName": tier_info.get("name", result["tier"]),
                "demo": False,
                "limits": None,
                "activatedAt": saved.get("activatedAt"),
            }
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass

    # No valid license — demo mode
    return {
        "licensed": False,
        "tier": None,
        "tierName": "Demo",
        "demo": True,
        "limits": DEMO_LIMITS,
        "activatedAt": None,
    }


def activate_license(key: str) -> dict:
    """Activate a license key. Saves to disk if valid.

    Returns: {"ok": bool, "tier": str|None, "tierName": str|None, "error": str|None}
    """
    result = validate_key(key)
    if not result["valid"]:
        return {"ok": False, "tier": None, "tierName": None, "error": result["error"]}

    tier = result["tier"]
    tier_info = TIERS.get(tier, {})

    # Save to disk
    os.makedirs(os.path.dirname(_LICENSE_FILE), exist_ok=True)
    with open(_LICENSE_FILE, "w") as f:
        json.dump({
            "key": key.strip().upper(),
            "tier": tier,
            "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, f, indent=2)

    return {
        "ok": True,
        "tier": tier,
        "tierName": tier_info.get("name", tier),
        "error": None,
    }


def deactivate_license() -> dict:
    """Remove the saved license key."""
    try:
        os.remove(_LICENSE_FILE)
    except FileNotFoundError:
        pass
    return {"ok": True}


def check_feature(feature: str) -> bool:
    """Check if a specific feature is available under the current license.

    Features gated in demo mode:
        - browserPanel, smsPanel, modelManager, cronManager, whisper

    Args:
        feature: Feature name to check

    Returns:
        True if the feature is available
    """
    status = get_license_status()
    if not status["demo"]:
        return True  # Licensed — everything unlocked
    limits = status.get("limits") or DEMO_LIMITS
    # If the feature is explicitly set to False in limits, it's gated
    if feature in limits:
        return limits[feature]
    return True  # Unknown features default to allowed


def get_agent_limit() -> int:
    """Get the maximum number of agents allowed.

    Returns:
        Max agents (0 = unlimited)
    """
    status = get_license_status()
    if not status["demo"]:
        return 0  # Unlimited
    return (status.get("limits") or DEMO_LIMITS).get("maxAgents", 3)


# --- CLI for key generation ---
if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python license.py generate [EARLY|FULL]")
        print("       python license.py validate <key>")
        print("       python license.py status")
        sys.exit(1)

    cmd = sys.argv[1].lower()

    if cmd == "generate":
        tier = sys.argv[2].upper() if len(sys.argv) > 2 else "FULL"
        key = generate_key(tier)
        print(f"Generated {tier} key: {key}")

    elif cmd == "validate":
        if len(sys.argv) < 3:
            print("Usage: python license.py validate <key>")
            sys.exit(1)
        result = validate_key(sys.argv[2])
        print(json.dumps(result, indent=2))

    elif cmd == "status":
        status = get_license_status()
        print(json.dumps(status, indent=2))

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
