"""Applying stored provider events to orders, stock and refunds."""

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

import structlog
from django.db import OperationalError, transaction
from django.db.models import F

from core.jobs import RetryLater, backoff_seconds
from orders.models import Order
from orders.services import pay_pending_order, pay_released_order

from ..exceptions import InvalidEventData, OrderNotFoundYet
from ..models import Refund, WebhookEvent
from ..serializers import EventDataSerializer
from . import refunds

logger = structlog.get_logger(__name__)

RETRYABLE_ERRORS = (OrderNotFoundYet, OperationalError)
FINAL_STATUSES = (WebhookEvent.Status.PROCESSED, WebhookEvent.Status.IGNORED)
STOCK_UNAVAILABLE = "stock_unavailable"


@dataclass(frozen=True)
class EventData:
    payment_intent_id: str
    amount_minor: int
    currency: str
    refund_id: str
    refund_reference: str
    failure_reason: str


Handler = Callable[[WebhookEvent, EventData, datetime], str]


def process_event(event_id: uuid.UUID, *, now: datetime) -> str:
    """Apply one stored event. Events already processed or ignored are left untouched."""
    with transaction.atomic():
        event = WebhookEvent.objects.select_for_update().get(pk=event_id)
        if event.status in FINAL_STATUSES:
            return event.status
        handler = HANDLERS.get(event.type)
        if handler is None:
            outcome = WebhookEvent.Status.IGNORED
        else:
            outcome = handler(event, _parse_data(event), now)
        event.status = outcome
        event.processed_at = now
        event.attempts += 1
        event.save(update_fields=["status", "processed_at", "attempts"])
    return outcome


def run_processing_attempt(
    event_id: uuid.UUID,
    *,
    retries: int,
    max_retries: int,
    now: datetime,
) -> RetryLater | None:
    """Process an event once, recording the failure when it does not succeed.

    Returns a retry hint for retryable errors while retries remain; otherwise the event is
    marked failed.
    """
    try:
        process_event(event_id, now=now)
    except RETRYABLE_ERRORS as exc:
        exhausted = retries >= max_retries
        _record_failure(event_id, exc, mark_failed=exhausted)
        if exhausted:
            logger.error("webhook_event_failed", event_id=str(event_id), error=_describe(exc))
            return None
        return RetryLater(countdown=backoff_seconds(retries), error=exc)
    except Exception as exc:
        _record_failure(event_id, exc, mark_failed=True)
        logger.exception("webhook_event_failed", event_id=str(event_id))
    return None


def _record_failure(event_id: uuid.UUID, exc: Exception, *, mark_failed: bool) -> None:
    changes = {"attempts": F("attempts") + 1, "last_error": _describe(exc)[:2000]}
    if mark_failed:
        changes["status"] = WebhookEvent.Status.FAILED
    WebhookEvent.objects.filter(
        pk=event_id,
        status__in=[WebhookEvent.Status.RECEIVED, WebhookEvent.Status.FAILED],
    ).update(**changes)


def _describe(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"


def _parse_data(event: WebhookEvent) -> EventData:
    serializer = EventDataSerializer(data=event.payload.get("data"))
    if not serializer.is_valid():
        raise InvalidEventData(json.dumps(serializer.errors, default=str))
    return EventData(**serializer.validated_data)


def _lock_order(payment_intent_id: str) -> Order:
    order = Order.objects.select_for_update().filter(payment_intent_id=payment_intent_id).first()
    if order is None:
        raise OrderNotFoundYet(f"No order has payment intent {payment_intent_id}")
    return order


def _flag_for_review(order: Order, reason: str) -> None:
    order.needs_review = True
    order.review_reason = reason[:500]
    order.save(update_fields=["needs_review", "review_reason", "updated_at"])


def _record_payment_event_time(order: Order, created_at: datetime) -> None:
    if order.last_payment_event_at is None or created_at > order.last_payment_event_at:
        order.last_payment_event_at = created_at
        order.save(update_fields=["last_payment_event_at", "updated_at"])


def _payment_succeeded(event: WebhookEvent, data: EventData, now: datetime) -> str:
    order = _lock_order(data.payment_intent_id)

    if data.currency != order.currency or data.amount_minor != order.total_minor:
        _flag_for_review(
            order,
            f"Payment of {data.amount_minor} {data.currency} does not match the order total "
            f"of {order.total_minor} {order.currency}.",
        )
        _record_payment_event_time(order, event.provider_created_at)
        return WebhookEvent.Status.PROCESSED

    if order.status in (Order.Status.PAID, Order.Status.FULFILLED):
        return WebhookEvent.Status.IGNORED

    if order.status == Order.Status.PENDING_PAYMENT:
        pay_pending_order(order, amount_paid_minor=data.amount_minor, now=now)
    elif order.amount_paid_minor > 0:
        return WebhookEvent.Status.IGNORED
    elif not pay_released_order(order, amount_paid_minor=data.amount_minor, now=now):
        order.amount_paid_minor = data.amount_minor
        order.save(update_fields=["amount_paid_minor", "updated_at"])
        refunds.create_system_refund(order, reason=STOCK_UNAVAILABLE)
        logger.warning(
            "late_payment_refunded",
            order_number=order.number,
            status=order.status,
        )

    _record_payment_event_time(order, event.provider_created_at)
    return WebhookEvent.Status.PROCESSED


def _payment_failed(event: WebhookEvent, data: EventData, now: datetime) -> str:
    order = _lock_order(data.payment_intent_id)
    if order.status != Order.Status.PENDING_PAYMENT:
        return WebhookEvent.Status.IGNORED
    last_seen = order.last_payment_event_at
    if last_seen is not None and event.provider_created_at <= last_seen:
        return WebhookEvent.Status.IGNORED
    order.last_payment_event_at = event.provider_created_at
    order.payment_failure_reason = (data.failure_reason or "Payment failed.")[:500]
    order.save(update_fields=["last_payment_event_at", "payment_failure_reason", "updated_at"])
    return WebhookEvent.Status.PROCESSED


def _find_refund(order: Order, data: EventData) -> Refund | None:
    refunds_of_order = Refund.objects.select_for_update().filter(order=order)
    if data.refund_id:
        refund = refunds_of_order.filter(provider_refund_id=data.refund_id).first()
        if refund is not None:
            return refund
    if not data.refund_reference:
        return None
    try:
        reference = uuid.UUID(data.refund_reference)
    except ValueError:
        return None
    refund = refunds_of_order.filter(pk=reference).first()
    if refund is not None and data.refund_id and not refund.provider_refund_id:
        refund.provider_refund_id = data.refund_id
        refund.save(update_fields=["provider_refund_id", "updated_at"])
    return refund


def _record_provider_refund(order: Order, data: EventData) -> str:
    if not data.refund_id or data.amount_minor <= 0:
        _flag_for_review(order, "The provider reported a refund that could not be matched.")
        return WebhookEvent.Status.PROCESSED
    if refunds.succeeded_minor(order) + data.amount_minor > order.amount_paid_minor:
        _flag_for_review(
            order,
            f"Provider refund {data.refund_id} of {data.amount_minor} {data.currency} would "
            "exceed the amount paid.",
        )
        return WebhookEvent.Status.PROCESSED
    Refund.objects.create(
        order=order,
        amount_minor=data.amount_minor,
        status=Refund.Status.SUCCEEDED,
        reason="Issued in the payment provider dashboard.",
        provider_refund_id=data.refund_id,
        source=Refund.Source.PROVIDER,
    )
    return WebhookEvent.Status.PROCESSED


def _refund_event(event: WebhookEvent, data: EventData, *, succeeded: bool) -> str:
    order = _lock_order(data.payment_intent_id)
    refund = _find_refund(order, data)
    if refund is None:
        if succeeded:
            return _record_provider_refund(order, data)
        return WebhookEvent.Status.IGNORED

    if refund.status == Refund.Status.PENDING:
        if succeeded:
            refunds.complete_refund(refund, order)
        else:
            refunds.mark_refund_failed(refund, reason=data.failure_reason or "Refund failed.")
        return WebhookEvent.Status.PROCESSED

    reported = Refund.Status.SUCCEEDED if succeeded else Refund.Status.FAILED
    if refund.status == reported:
        return WebhookEvent.Status.IGNORED
    _flag_for_review(
        order,
        f"Refund {refund.id} is {refund.status} but the provider sent {event.type}.",
    )
    return WebhookEvent.Status.PROCESSED


def _refund_succeeded(event: WebhookEvent, data: EventData, now: datetime) -> str:
    return _refund_event(event, data, succeeded=True)


def _refund_failed(event: WebhookEvent, data: EventData, now: datetime) -> str:
    return _refund_event(event, data, succeeded=False)


HANDLERS: dict[str, Handler] = {
    "payment.succeeded": _payment_succeeded,
    "payment.failed": _payment_failed,
    "refund.succeeded": _refund_succeeded,
    "refund.failed": _refund_failed,
}
