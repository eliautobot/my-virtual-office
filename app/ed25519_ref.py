"""Pure-python Ed25519 (RFC 8032), used only when the `cryptography` package is not installed.

This is the reference implementation from RFC 8032 section 6 ("Ed25519 Python illustration"), kept as published
apart from naming, docstrings and the input checks. It is slow (milliseconds per signature) and not constant-time,
which is acceptable here: the office signs one short connect challenge per Gateway connection with a key that never
leaves its data folder. openclaw_device.py prefers `cryptography` whenever it is importable.

Copyright (c) 2017 IETF Trust and the persons identified as authors of the code (S. Josefsson, I. Liusvaara).
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, is permitted pursuant to, and
subject to the license terms contained in, the Simplified BSD License set forth in Section 4.c of the IETF Trust's
Legal Provisions Relating to IETF Documents (https://trustee.ietf.org/license-info).
"""

import hashlib


def _sha512(data: bytes) -> bytes:
    return hashlib.sha512(data).digest()


# Base field Z_p
_P = 2 ** 255 - 19


def _modp_inv(x: int) -> int:
    return pow(x, _P - 2, _P)


# Curve constant
_D = -121665 * _modp_inv(121666) % _P
# Group order
_Q = 2 ** 252 + 27742317777372353535851937790883648493


def _sha512_modq(data: bytes) -> int:
    return int.from_bytes(_sha512(data), "little") % _Q


# Points are tuples (X, Y, Z, T) of extended coordinates, with x = X/Z, y = Y/Z, x*y = T/Z.
def _point_add(P, Q):
    A, B = (P[1] - P[0]) * (Q[1] - Q[0]) % _P, (P[1] + P[0]) * (Q[1] + Q[0]) % _P
    C, D = 2 * P[3] * Q[3] * _D % _P, 2 * P[2] * Q[2] % _P
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F, G * H, F * G, E * H)


def _point_mul(s: int, P):
    Q = (0, 1, 1, 0)  # neutral element
    while s > 0:
        if s & 1:
            Q = _point_add(Q, P)
        P = _point_add(P, P)
        s >>= 1
    return Q


def _point_equal(P, Q) -> bool:
    if (P[0] * Q[2] - Q[0] * P[2]) % _P != 0:
        return False
    if (P[1] * Q[2] - Q[1] * P[2]) % _P != 0:
        return False
    return True


# Square root of -1
_MODP_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y: int, sign: int):
    if y >= _P:
        return None
    x2 = (y * y - 1) * _modp_inv(_D * y * y + 1)
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _MODP_SQRT_M1 % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


# Base point
_G_Y = 4 * _modp_inv(5) % _P
_G_X = _recover_x(_G_Y, 0)
_G = (_G_X, _G_Y, 1, _G_X * _G_Y % _P)


def _point_compress(P) -> bytes:
    zinv = _modp_inv(P[2])
    x = P[0] * zinv % _P
    y = P[1] * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _point_decompress(data: bytes):
    if len(data) != 32:
        raise ValueError("Invalid input length for decompression")
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def _secret_expand(secret: bytes):
    if len(secret) != 32:
        raise ValueError("Bad size of private key")
    h = _sha512(secret)
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= (1 << 254)
    return a, h[32:]


def public_key(secret: bytes) -> bytes:
    """The 32-byte public key of a 32-byte private key (seed)."""
    a, _prefix = _secret_expand(secret)
    return _point_compress(_point_mul(a, _G))


def sign(secret: bytes, message: bytes) -> bytes:
    """A 64-byte Ed25519 signature of ``message``."""
    a, prefix = _secret_expand(secret)
    A = _point_compress(_point_mul(a, _G))
    r = _sha512_modq(prefix + message)
    Rs = _point_compress(_point_mul(r, _G))
    h = _sha512_modq(Rs + A + message)
    s = (r + h * a) % _Q
    return Rs + int.to_bytes(s, 32, "little")


def verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    A = _point_decompress(public)
    if not A:
        return False
    Rs = signature[:32]
    R = _point_decompress(Rs)
    if not R:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _Q:
        return False
    h = _sha512_modq(Rs + public + message)
    return _point_equal(_point_mul(s, _G), _point_add(R, _point_mul(h, A)))
