"""Request idempotency for endpoints that take an ``Idempotency-Key`` header."""

import hashlib
import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from django.db import connection, transaction
from rest_framework import status

from .errors import DomainError, ValidationFailed, current_request_id, domain_error_body
from .models import IdempotencyRecord

KEY_MIN_LENGTH = 8
KEY_MAX_LENGTH = 128

Outcome = tuple[int, Any]


class IdempotencyKeyRequired(DomainError):
    status_code = status.HTTP_400_BAD_REQUEST
    code = "idempotency_key_required"
    message = "The Idempotency-Key header is required."


class IdempotencyKeyReused(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "idempotency_key_reused"
    message = "This Idempotency-Key was already used with a different request."


@dataclass(frozen=True)
class StoredResponse:
    status: int
    body: Any


def canonical_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def request_hash(data: Any) -> str:
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def require_key(value: str | None) -> str:
    if not value:
        raise IdempotencyKeyRequired()
    if not KEY_MIN_LENGTH <= len(value) <= KEY_MAX_LENGTH or not value.isprintable():
        message = f"Must be {KEY_MIN_LENGTH} to {KEY_MAX_LENGTH} printable characters."
        raise ValidationFailed([{"path": "Idempotency-Key", "message": message}])
    return value


def run(
    *,
    scope: str,
    key: str,
    payload: Any,
    action: Callable[[], Outcome],
    finalize: Callable[[Any], Outcome] | None = None,
) -> StoredResponse:
    """Execute ``action`` at most once per ``(scope, key)`` and replay its stored response.

    ``action`` runs in the transaction that inserts the record. When ``finalize`` is given it
    runs after that transaction commits, receives the body returned by ``action``, and its
    outcome is the one stored. Domain errors below 500 are stored; anything else is not.
    """
    digest = request_hash(payload)
    with _key_lock(scope, key):
        stored = _stored_response(scope, key, digest)
        if stored is not None:
            return stored

        with transaction.atomic():
            record = IdempotencyRecord.objects.create(scope=scope, key=key, request_hash=digest)
            outcome = _attempt(action, savepoint=True)
            if finalize is None or not status.is_success(outcome.status):
                _save(record, outcome)
                return outcome

        try:
            outcome = _attempt(lambda: finalize(outcome.body), savepoint=False)
        except Exception:
            record.delete()
            raise
        _save(record, outcome)
        return outcome


def _attempt(fn: Callable[[], Outcome], *, savepoint: bool) -> StoredResponse:
    try:
        if savepoint:
            with transaction.atomic():
                status_code, body = fn()
        else:
            status_code, body = fn()
    except DomainError as exc:
        if exc.status_code >= 500:
            raise
        return StoredResponse(exc.status_code, domain_error_body(exc, current_request_id()))
    return StoredResponse(status_code, body)


def _stored_response(scope: str, key: str, digest: str) -> StoredResponse | None:
    record = IdempotencyRecord.objects.filter(scope=scope, key=key).first()
    if record is None:
        return None
    if record.request_hash != digest:
        raise IdempotencyKeyReused()
    if record.response_status is None:
        # Records are only written while holding the key lock, so an unfinished one belongs
        # to a request that died before completing.
        record.delete()
        return None
    return StoredResponse(record.response_status, record.response_body)


def _save(record: IdempotencyRecord, outcome: StoredResponse) -> None:
    record.response_status = outcome.status
    record.response_body = outcome.body
    record.save(update_fields=["response_status", "response_body"])


@contextmanager
def _key_lock(scope: str, key: str) -> Iterator[None]:
    # A session-level advisory lock spans both transactions of a request with ``finalize``.
    digest = hashlib.sha256(f"{scope}\x00{key}".encode()).digest()
    lock_id = int.from_bytes(digest[:8], "big", signed=True)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_lock(%s)", [lock_id])
    try:
        yield
    finally:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [lock_id])
