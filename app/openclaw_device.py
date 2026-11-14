"""OpenClaw device identity and one-time pairing for the office's Gateway connections.

OpenClaw gives a token-only operator client its scopes only on a direct loopback connection. From a Docker bridge
network or another computer the office therefore connects the documented way (OpenClaw docs gateway/protocol/
handshake.md and auth.md, "Device identity and pairing"): an Ed25519 key kept in the data folder, the
``connect.challenge`` nonce signed in ``connect.params.device`` (signature payload v3), and a one-time approval on the
OpenClaw computer (``openclaw devices approve <requestId>``). hello-ok then grants the approved scopes and a device
token, stored next to the key.

The device is used only when needed: a gateway address that is not loopback, or a gateway that gave a token-only
handshake fewer scopes than the office needs (then the office retries once with the device and keeps doing so).
Only the main connection asks for pairing (with the scopes of the connection's access level); the office's other,
short connections add the device once it is paired, so they never open a narrower pairing request.

``<data>/openclaw-device.json`` (0600, keeps its owner) holds the private key and the device token; neither is ever
logged or returned by an API. ``cryptography`` signs when it is installed, else the bundled RFC 8032 code
(ed25519_ref.py), so a plain python install needs nothing extra.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import threading
import time
from typing import Any
from urllib.parse import urlsplit

try:  # the fast, constant-time signer when it is installed
    from cryptography.hazmat.primitives import serialization as _serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as _CryptoKey
except Exception:  # pragma: no cover - depends on the install
    _CryptoKey = None

import ed25519_ref
import private_files

FILE_NAME = "openclaw-device.json"
PLATFORM = "server"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _public_key(seed: bytes) -> bytes:
    if _CryptoKey is not None:
        return _CryptoKey.from_private_bytes(seed).public_key().public_bytes(
            _serialization.Encoding.Raw, _serialization.PublicFormat.Raw)
    return ed25519_ref.public_key(seed)


def _sign(seed: bytes, data: bytes) -> bytes:
    if _CryptoKey is not None:
        return _CryptoKey.from_private_bytes(seed).sign(data)
    return ed25519_ref.sign(seed, data)


def signer_name() -> str:
    return "cryptography" if _CryptoKey is not None else "builtin"


def _auth_text(value: Any) -> str:
    """OpenClaw's normalizeDeviceMetadataForAuth: trimmed, ASCII A-Z lowered, "" for anything else."""
    if not isinstance(value, str):
        return ""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in value.strip())


def is_loopback_url(url: Any) -> bool:
    try:
        host = (urlsplit(str(url or "")).hostname or "").strip().lower()
    except ValueError:
        return False
    if host in ("localhost", "ip6-localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def gateway_key(url: Any) -> str:
    try:
        parts = urlsplit(str(url or ""))
        port = parts.port or (443 if parts.scheme in ("wss", "https") else 80)
        return f"{(parts.hostname or '').lower()}:{port}"
    except ValueError:
        return ""


def approve_command(request_id: Any) -> str:
    request_id = str(request_id or "").strip()
    return f"openclaw devices approve {request_id}" if request_id else "openclaw devices list"


def pairing_status(device: dict[str, Any] | None) -> dict[str, Any] | None:
    """Provider status words while the office waits for its one-time approval; None when it does not."""
    if not isinstance(device, dict) or device.get("state") != "pending":
        return None
    command = approve_command(device.get("requestId"))
    return {"state": "pairing", "code": "pairing_required", "requestId": str(device.get("requestId") or ""),
            "command": command,
            "lead": "Approve this office once on the OpenClaw computer (or in OpenClaw's Control UI):",
            "detail": f"Waiting for approval: run `{command}` on the OpenClaw computer (or approve the office in "
                      "OpenClaw's Control UI).",
            "fix": "OpenClaw asks once before it lets in an office that runs on another computer or in a Docker "
                   "container. The office connects by itself as soon as it is approved."}


def _write_private(path: str, payload: dict[str, Any]) -> None:
    """Atomic private write that keeps the file's owner (or takes the data folder's owner when created as root);
    the office's one secret-file writer (private_files.write_private)."""
    private_files.write_private(path, json.dumps(payload, indent=2, sort_keys=True))


class OpenClawDevice:
    """The office's device identity and its pairing with one OpenClaw gateway (thread-safe)."""

    def __init__(self, data_dir: str, logger=None) -> None:
        self._path = os.path.join(str(data_dir), FILE_NAME)
        self._lock = threading.RLock()
        self._logger = logger or (lambda _message: None)
        self._record: dict[str, Any] | None = None
        self._url = ""

    # ---- storage -----------------------------------------------------------------------------------------------
    def _load(self) -> dict[str, Any]:
        if self._record is None:
            try:
                with open(self._path, encoding="utf-8") as handle:
                    record = json.load(handle)
                seed = _unb64url(str(record.get("privateKey") or ""))
                if len(seed) != 32 or _b64url(_public_key(seed)) != record.get("publicKey"):
                    raise ValueError("the stored key does not match")
                self._record = record
            except FileNotFoundError:
                self._record = {}
            except (OSError, ValueError, TypeError, AttributeError) as exc:
                self._logger(f"[openclaw-device] {FILE_NAME} unreadable ({type(exc).__name__}); a new device key "
                             "will be made")
                self._record = {}
        return self._record

    def _save(self) -> None:
        _write_private(self._path, self._record or {})

    def _identity(self) -> dict[str, Any]:
        record = self._load()
        if not record.get("privateKey"):
            seed = os.urandom(32)
            public = _public_key(seed)
            record.clear()
            record.update({"version": 1, "privateKey": _b64url(seed), "publicKey": _b64url(public),
                           "deviceId": hashlib.sha256(public).hexdigest(), "createdAt": int(time.time() * 1000)})
            self._save()
            self._logger(f"[openclaw-device] new device identity {record['deviceId'][:12]}")
        return record

    # ---- when the device is used -------------------------------------------------------------------------------
    def wanted(self, url: Any) -> bool:
        """True when the connection to ``url`` should carry the device: not loopback, or a gateway there gave a
        token-only handshake too few scopes before."""
        with self._lock:
            self._url = str(url or "")  # the main connection's address: what public() describes
            return self._wanted(url)

    def _wanted(self, url: Any) -> bool:
        return not is_loopback_url(url) or self._load().get("requiredFor") == gateway_key(url)

    def paired_for(self, url: Any) -> bool:
        """For the office's short connections: add the device only once it is paired (never a pairing request)."""
        with self._lock:
            record = self._load()
            return bool(record.get("privateKey")) and self._wanted(url) and \
                (record.get("pairing") or {}).get("gateway") == gateway_key(url) and \
                (record.get("pairing") or {}).get("state") == "paired"

    def require(self, url: Any) -> None:
        """A token-only handshake at ``url`` came back short of scopes: use the device there from now on."""
        with self._lock:
            record = self._identity()
            key = gateway_key(url)
            if record.get("requiredFor") != key:
                record["requiredFor"] = key
                self._save()
                self._logger("[openclaw-device] the gateway gave a token-only connection too few scopes; "
                             "retrying as a device")

    # ---- handshake ---------------------------------------------------------------------------------------------
    def sign_connect(self, challenge: Any, client: dict[str, Any], role: str, scopes: list[str],
                     token: str) -> dict[str, Any] | None:
        """``connect.params.device`` for this challenge; None without a usable challenge (nothing to sign)."""
        payload = challenge if isinstance(challenge, dict) else {}
        nonce, signed_at = payload.get("nonce"), payload.get("ts")
        if not isinstance(nonce, str) or not nonce or isinstance(signed_at, bool) or not isinstance(signed_at, int) \
                or signed_at < 0:
            return None
        with self._lock:
            record = self._identity()
            seed = _unb64url(record["privateKey"])
            device_id = record["deviceId"]
            public = record["publicKey"]
        message = "|".join([
            "v3", device_id, str(client.get("id") or ""), str(client.get("mode") or ""), str(role or ""),
            ",".join(scopes), str(signed_at), str(token or ""), nonce,
            _auth_text(client.get("platform")), _auth_text(client.get("deviceFamily")),
        ])
        return {"id": device_id, "publicKey": public, "signature": _b64url(_sign(seed, message.encode("utf-8"))),
                "signedAt": signed_at, "nonce": nonce}

    def note_refusal(self, url: Any, error: Any) -> str | None:
        """Record a refused device handshake; returns the words for the connection's last error when it is the
        one-time approval OpenClaw is waiting for."""
        error = error if isinstance(error, dict) else {}
        details = error.get("details") if isinstance(error.get("details"), dict) else {}
        if details.get("code") != "PAIRING_REQUIRED" and error.get("code") != "NOT_PAIRED":
            return None
        request_id = str(details.get("requestId") or "")[:128]
        with self._lock:
            record = self._identity()
            pairing = record.get("pairing") or {}
            fresh = {"state": "pending", "gateway": gateway_key(url), "requestId": request_id,
                     "reason": str(details.get("reason") or "")[:64],
                     "requestedScopes": [s for s in (details.get("requestedScopes") or []) if isinstance(s, str)][:16],
                     "since": pairing.get("since") if pairing.get("state") == "pending" and
                     pairing.get("requestId") == request_id else int(time.time() * 1000)}
            if {k: pairing.get(k) for k in fresh} != fresh:
                record["pairing"] = fresh
                self._save()
                self._logger(f"[openclaw-device] waiting for approval in OpenClaw: {approve_command(request_id)}")
        return f"waiting for approval in OpenClaw ({approve_command(request_id)})"

    def note_hello(self, url: Any, auth: Any) -> None:
        """A device handshake was accepted: the office is paired; keep the device token OpenClaw issued."""
        auth = auth if isinstance(auth, dict) else {}
        with self._lock:
            record = self._identity()
            pairing = record.get("pairing") or {}
            token = auth.get("deviceToken") if isinstance(auth.get("deviceToken"), str) else ""
            scopes = [s for s in (auth.get("scopes") or []) if isinstance(s, str)][:16]
            changed = pairing.get("state") != "paired" or pairing.get("gateway") != gateway_key(url) or \
                (token and token != record.get("deviceToken")) or pairing.get("scopes") != scopes
            if not changed:
                return
            record["pairing"] = {"state": "paired", "gateway": gateway_key(url), "scopes": scopes,
                                 "since": pairing.get("since") if pairing.get("state") == "paired" and
                                 pairing.get("gateway") == gateway_key(url) else int(time.time() * 1000)}
            if token:
                record["deviceToken"] = token
                record["deviceTokenAt"] = int(time.time() * 1000)
            self._save()
            self._logger("[openclaw-device] paired with OpenClaw")

    # ---- actions -----------------------------------------------------------------------------------------------
    def repair(self) -> None:
        """Pair again with the same key (the next connection asks OpenClaw again if it no longer knows it)."""
        with self._lock:
            record = self._load()
            dropped = [record.pop(key, None) for key in ("pairing", "deviceToken", "deviceTokenAt")]
            if any(value is not None for value in dropped):
                self._save()

    def forget(self) -> None:
        """Drop the key, the token and the pairing; the next connection makes a new device identity."""
        with self._lock:
            self._record = {}
            try:
                os.unlink(self._path)
            except FileNotFoundError:
                pass

    # ---- public facts (no key, no token) -----------------------------------------------------------------------
    def public(self, url: Any = None) -> dict[str, Any]:
        with self._lock:
            url = self._url if url is None else str(url or "")
            record = self._load()
            in_use = bool(url) and self._wanted(url)
            if not in_use:
                return {"state": "off", "signer": signer_name()}
            pairing = record.get("pairing") or {}
            state = pairing.get("state") if pairing.get("gateway") == gateway_key(url) else ""
            out: dict[str, Any] = {"state": state if state in ("pending", "paired") else "unpaired",
                                   "signer": signer_name(), "gateway": gateway_key(url)}
            if record.get("deviceId"):
                out["deviceId"] = record["deviceId"]
            if out["state"] == "pending":
                out.update(requestId=pairing.get("requestId") or "", command=approve_command(pairing.get("requestId")),
                           since=pairing.get("since"))
            elif out["state"] == "paired":
                out.update(since=pairing.get("since"), scopes=list(pairing.get("scopes") or []))
            return out
