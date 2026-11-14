"""Intake of provider webhooks: authenticate, store once, hand off to processing."""

import json
from datetime import UTC, datetime
from typing import Any

import structlog
from django.conf import settings
from django.db import DataError, IntegrityError, transaction

from core.errors import flatten_errors
from core.jobs import enqueue_on_commit

from ..exceptions import InvalidPayload
from ..models import WebhookEvent
from ..serializers import WebhookEnvelopeSerializer
from ..signature import verify

logger = structlog.get_logger(__name__)

ACCEPTED = "accepted"
DUPLICATE = "duplicate"
PROCESS_TASK = "payments.process_webhook_event"


def receive_webhook(*, body: bytes, signature_header: str | None, now: datetime) -> str:
    """Verify and store a delivery, returning ``accepted`` or ``duplicate``."""
    verify(
        signature_header,
        body,
        secrets=[settings.PAYMENT_WEBHOOK_SECRET, settings.PAYMENT_WEBHOOK_SECRET_PREVIOUS],
        now=int(now.timestamp()),
    )
    payload, envelope = _parse(body)
    try:
        with transaction.atomic():
            event = WebhookEvent.objects.create(
                provider_event_id=envelope["id"],
                type=envelope["type"],
                payload=payload,
                provider_created_at=datetime.fromtimestamp(envelope["created"], tz=UTC),
                received_at=now,
            )
            enqueue_on_commit(PROCESS_TASK, str(event.id))
    except IntegrityError:
        existing = WebhookEvent.objects.get(provider_event_id=envelope["id"])
        if existing.status in (WebhookEvent.Status.RECEIVED, WebhookEvent.Status.FAILED):
            enqueue_on_commit(PROCESS_TASK, str(existing.id))
        logger.info("webhook_duplicate", provider_event_id=envelope["id"], status=existing.status)
        return DUPLICATE
    except DataError as exc:
        raise InvalidPayload("The webhook body contains values that cannot be stored.") from exc
    logger.info("webhook_accepted", provider_event_id=envelope["id"], type=envelope["type"])
    return ACCEPTED


def _reject_constant(value: str) -> Any:
    raise ValueError(f"{value} is not valid JSON")


def _parse(body: bytes) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        payload = json.loads(body, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:
        raise InvalidPayload("The webhook body is not valid JSON.") from exc
    if not isinstance(payload, dict):
        raise InvalidPayload("The webhook body must be a JSON object.")
    serializer = WebhookEnvelopeSerializer(data=payload)
    if not serializer.is_valid():
        raise InvalidPayload(details={"fields": flatten_errors(serializer.errors)})
    return payload, serializer.validated_data
