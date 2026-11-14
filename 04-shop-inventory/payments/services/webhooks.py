"""Intake of provider webhooks: authenticate, store once, hand off to processing."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from django.db import DataError, IntegrityError, transaction

from core import jobs
from core.errors import InvalidState, NotFound, flatten_errors

from ..client import PaymentsClient
from ..exceptions import InvalidPayload
from ..models import WebhookEvent
from ..serializers import WebhookEnvelopeSerializer

logger = structlog.get_logger(__name__)

ACCEPTED = "accepted"
DUPLICATE = "duplicate"
PROCESS_TASK = "payments.process_webhook_event"
STALE_AFTER = timedelta(minutes=5)


def receive_webhook(*, body: bytes, signature_header: str | None, now: datetime) -> str:
    """Verify and store a delivery, returning ``accepted`` or ``duplicate``."""
    PaymentsClient().verify_webhook(signature_header, body, now=now)
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
            _queue_processing(event)
    except IntegrityError:
        existing = WebhookEvent.objects.get(provider_event_id=envelope["id"])
        if existing.status in (WebhookEvent.Status.RECEIVED, WebhookEvent.Status.FAILED):
            _queue_processing(existing)
        logger.info("webhook_duplicate", provider_event_id=envelope["id"], status=existing.status)
        return DUPLICATE
    except DataError as exc:
        raise InvalidPayload("The webhook body contains values that cannot be stored.") from exc
    logger.info("webhook_accepted", provider_event_id=envelope["id"], type=envelope["type"])
    return ACCEPTED


def retry_failed_event(event_id: uuid.UUID) -> WebhookEvent:
    with transaction.atomic():
        event = WebhookEvent.objects.select_for_update().filter(pk=event_id).first()
        if event is None:
            raise NotFound()
        if event.status != WebhookEvent.Status.FAILED:
            raise InvalidState("Only failed events can be retried.")
        _queue_processing(event)
    logger.info("webhook_retry_requested", provider_event_id=event.provider_event_id)
    return event


def requeue_stale_events(*, now: datetime) -> int:
    """Queue processing again for events still ``received`` well after they arrived."""
    stale_ids = list(
        WebhookEvent.objects.filter(
            status=WebhookEvent.Status.RECEIVED,
            received_at__lte=now - STALE_AFTER,
        )
        .order_by("received_at")
        .values_list("id", flat=True)
    )
    for event_id in stale_ids:
        jobs.enqueue_on_commit(PROCESS_TASK, str(event_id))
    return len(stale_ids)


def _queue_processing(event: WebhookEvent) -> None:
    logger.debug("webhook_processing_queued", provider_event_id=event.provider_event_id)
    jobs.publish(PROCESS_TASK, str(event.id))


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
