"""Signing and verification of ``X-Pay-Signature`` webhook headers."""

import hashlib
import hmac
from collections.abc import Iterable

from .exceptions import InvalidSignature

TOLERANCE_SECONDS = 300


def sign(secret: str, timestamp: str, body: bytes) -> str:
    message = f"{timestamp}.".encode() + body
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def build_header(secret: str, timestamp: int, body: bytes) -> str:
    return f"t={timestamp},v1={sign(secret, str(timestamp), body)}"


def parse_header(header: str) -> tuple[str, list[str]]:
    """Split a header into its timestamp and ``v1`` signatures, rejecting malformed input."""
    timestamp: str | None = None
    signatures: list[str] = []
    for part in header.split(","):
        key, separator, value = part.strip().partition("=")
        if not separator or not value:
            raise InvalidSignature()
        if key == "t":
            if timestamp is not None or not (value.isascii() and value.isdigit()):
                raise InvalidSignature()
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    if timestamp is None or not signatures:
        raise InvalidSignature()
    return timestamp, signatures


def verify(
    header: str | None,
    body: bytes,
    *,
    secrets: Iterable[str],
    now: int,
    tolerance: int = TOLERANCE_SECONDS,
) -> None:
    """Raise ``InvalidSignature`` unless ``header`` signs exactly ``body`` with one of ``secrets``.

    ``now`` is the current time in unix seconds.
    """
    if not header:
        raise InvalidSignature()
    timestamp, signatures = parse_header(header)
    if abs(now - int(timestamp)) > tolerance:
        raise InvalidSignature()
    candidates = [signature.encode("utf-8", "surrogateescape") for signature in signatures]
    for secret in secrets:
        if not secret:
            continue
        expected = sign(secret, timestamp, body).encode()
        if any(hmac.compare_digest(expected, candidate) for candidate in candidates):
            return
    raise InvalidSignature()
