import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

import structlog
from django.contrib.auth.base_user import AbstractBaseUser
from django.db import transaction
from django.db.models import F, Sum

from core.errors import InvalidState, NotFound
from core.jobs import RetryLater, backoff_seconds, enqueue_on_commit
from inventory.models import StockMovement
from inventory.services import apply_movement, lock_stock
from orders.models import Order, OrderLine

from ..exceptions import (
    ExceedsRefundable,
    ExceedsRefundableQuantity,
    InvalidLine,
    RefundLimitExceeded,
    RefundTooSmall,
)
from ..models import Refund, RefundLine
from ..provider import ProviderPermanentError, ProviderTransientError, get_provider

logger = structlog.get_logger(__name__)

SUBMIT_TASK = "payments.submit_refund"
UNSUBMITTED_AFTER = timedelta(minutes=5)
REFUNDABLE_STATUSES = (Order.Status.PAID, Order.Status.FULFILLED)
CLAIMING_STATUSES = (Refund.Status.PENDING, Refund.Status.SUCCEEDED)


@dataclass(frozen=True)
class RefundLineRequest:
    order_line_id: uuid.UUID
    quantity: int
    restock: bool


@dataclass(frozen=True)
class RefundRequest:
    reason: str
    lines: Sequence[RefundLineRequest] | None = None
    amount_minor: int | None = None
    percent: Decimal | None = None


@dataclass(frozen=True)
class LineAvailability:
    unit_price_minor: int
    quantity: int
    refunded_quantity: int
    pending_quantity: int

    @property
    def refundable_quantity(self) -> int:
        return self.quantity - self.refunded_quantity - self.pending_quantity


@dataclass(frozen=True)
class RefundQuote:
    amount_minor: int
    refundable_minor: int


def percent_of(amount_minor: int, percent: Decimal) -> int:
    """Return ``percent`` per cent of ``amount_minor``, rounded to the nearest minor unit."""
    return round(amount_minor * float(percent) / 100)


def refund_amount(
    request: RefundRequest,
    *,
    lines: Mapping[uuid.UUID, LineAvailability],
    amount_paid_minor: int,
    claimed_minor: int,
    limit_minor: int | None,
) -> int:
    """Check ``request`` against what is still refundable and return the refund amount.

    ``claimed_minor`` is the total of pending and succeeded refunds; ``limit_minor`` is the
    per-refund ceiling for the requesting user, or ``None`` when there is none.
    """
    if request.lines is not None:
        unknown = [
            str(line.order_line_id) for line in request.lines if line.order_line_id not in lines
        ]
        if unknown:
            raise InvalidLine(details={"order_line_ids": unknown})
        over = [
            {
                "order_line_id": str(line.order_line_id),
                "requested": line.quantity,
                "refundable": lines[line.order_line_id].refundable_quantity,
            }
            for line in request.lines
            if line.quantity > lines[line.order_line_id].refundable_quantity
        ]
        if over:
            raise ExceedsRefundableQuantity(details={"lines": over})
        amount = sum(
            lines[line.order_line_id].unit_price_minor * line.quantity for line in request.lines
        )
    elif request.percent is not None:
        amount = percent_of(amount_paid_minor, request.percent)
        if amount < 1:
            raise RefundTooSmall(details={"amount_paid_minor": amount_paid_minor})
    else:
        amount = request.amount_minor or 0

    refundable = amount_paid_minor - claimed_minor
    if amount > refundable:
        raise ExceedsRefundable(details={"refundable_minor": max(refundable, 0)})
    if limit_minor is not None and amount > limit_minor:
        raise RefundLimitExceeded(details={"limit_minor": limit_minor})
    return amount


def refund_progress(order: Order) -> tuple[int, str]:
    """Return ``(refunded_minor, refund_state)`` for ``order`` from its succeeded refunds."""
    refunded = sum(
        refund.amount_minor
        for refund in order.refunds.all()
        if refund.status == Refund.Status.SUCCEEDED
    )
    if refunded == 0:
        return 0, "none"
    if refunded >= order.amount_paid_minor:
        return refunded, "full"
    return refunded, "partial"


def claimed_minor(order: Order) -> int:
    totals = Refund.objects.filter(order=order, status__in=CLAIMING_STATUSES).aggregate(
        total=Sum("amount_minor"),
    )
    return totals["total"] or 0


def line_availability(order: Order) -> dict[uuid.UUID, LineAvailability]:
    pending = dict(
        RefundLine.objects.filter(refund__order=order, refund__status=Refund.Status.PENDING)
        .order_by()
        .values("order_line_id")
        .annotate(total=Sum("quantity"))
        .values_list("order_line_id", "total")
    )
    return {
        line.id: LineAvailability(
            unit_price_minor=line.unit_price_minor,
            quantity=line.quantity,
            refunded_quantity=line.refunded_quantity,
            pending_quantity=pending.get(line.id, 0),
        )
        for line in order.lines.all()
    }


def quote_refund(order: Order, request: RefundRequest, *, limit_minor: int | None) -> RefundQuote:
    """Work out what ``request`` would refund on ``order`` without creating anything."""
    if order.status not in REFUNDABLE_STATUSES:
        raise InvalidState("Only paid or fulfilled orders can be refunded.")
    claimed = claimed_minor(order)
    amount = refund_amount(
        request,
        lines=line_availability(order),
        amount_paid_minor=order.amount_paid_minor,
        claimed_minor=claimed,
        limit_minor=limit_minor,
    )
    return RefundQuote(amount_minor=amount, refundable_minor=order.amount_paid_minor - claimed)


def create_refund(
    *,
    order_number: str,
    request: RefundRequest,
    actor: AbstractBaseUser,
    limit_minor: int | None,
) -> Refund:
    """Create a pending staff refund and submit it to the provider after commit."""
    order = Order.objects.filter(number=order_number).first()
    if order is None:
        raise NotFound()
    quote = quote_refund(order, request, limit_minor=limit_minor)
    with transaction.atomic():
        order = Order.objects.select_for_update().get(pk=order.pk)
        if order.status not in REFUNDABLE_STATUSES:
            raise InvalidState("Only paid or fulfilled orders can be refunded.")
        refund = Refund.objects.create(
            order=order,
            amount_minor=quote.amount_minor,
            status=Refund.Status.PENDING,
            reason=request.reason,
            source=Refund.Source.STAFF,
            created_by=actor,
        )
        RefundLine.objects.bulk_create(
            [
                RefundLine(
                    refund=refund,
                    order_line_id=line.order_line_id,
                    quantity=line.quantity,
                    restock=line.restock,
                )
                for line in request.lines or ()
            ]
        )
        enqueue_on_commit(SUBMIT_TASK, str(refund.id))
    return refund


def create_system_refund(order: Order, *, reason: str) -> Refund | None:
    """Refund whatever is still refundable on ``order``, which the caller has locked."""
    amount = order.amount_paid_minor - claimed_minor(order)
    if amount <= 0:
        return None
    refund = Refund.objects.create(
        order=order,
        amount_minor=amount,
        status=Refund.Status.PENDING,
        reason=reason,
        source=Refund.Source.SYSTEM,
    )
    enqueue_on_commit(SUBMIT_TASK, str(refund.id))
    return refund


def submit_refund(
    refund_id: uuid.UUID,
    *,
    retries: int,
    max_retries: int,
    now: datetime,
) -> RetryLater | None:
    """Send a pending refund to the provider. Returns a retry hint for transient failures."""
    refund = Refund.objects.select_related("order").get(pk=refund_id)
    if refund.status != Refund.Status.PENDING or refund.provider_refund_id:
        return None
    try:
        created = get_provider().create_refund(
            refund.order.payment_intent_id,
            refund.amount_minor,
            idempotency_key=str(refund.id),
        )
    except ProviderTransientError as exc:
        if retries >= max_retries:
            fail_refund(refund.id, reason=f"Payment provider unavailable: {exc}")
            return None
        return RetryLater(countdown=backoff_seconds(retries), error=exc)
    except ProviderPermanentError as exc:
        fail_refund(refund.id, reason=f"Refused by payment provider: {exc}")
        return None
    Refund.objects.filter(pk=refund.pk, provider_refund_id="").update(
        provider_refund_id=created.id,
        updated_at=now,
    )
    return None


def requeue_unsubmitted_refunds(*, now: datetime) -> int:
    """Publish submission again for pending refunds the provider has not acknowledged."""
    refund_ids = list(
        Refund.objects.filter(
            status=Refund.Status.PENDING,
            provider_refund_id="",
            created_at__lte=now - UNSUBMITTED_AFTER,
        )
        .order_by("created_at")
        .values_list("id", flat=True)
    )
    for refund_id in refund_ids:
        enqueue_on_commit(SUBMIT_TASK, str(refund_id))
    return len(refund_ids)


def fail_refund(refund_id: uuid.UUID, *, reason: str) -> None:
    """Mark a refund failed if it is still pending."""
    order_id = Refund.objects.values_list("order_id", flat=True).get(pk=refund_id)
    with transaction.atomic():
        Order.objects.select_for_update().get(pk=order_id)
        refund = Refund.objects.select_for_update().get(pk=refund_id)
        if refund.status != Refund.Status.PENDING:
            return
        mark_refund_failed(refund, reason=reason)


def mark_refund_failed(refund: Refund, *, reason: str) -> None:
    """Fail a pending refund whose order the caller has locked."""
    refund.status = Refund.Status.FAILED
    refund.failure_reason = reason[:500]
    refund.save(update_fields=["status", "failure_reason", "updated_at"])
    logger.warning("refund_failed", refund_id=str(refund.id), reason=reason)


def complete_refund(refund: Refund, order: Order) -> None:
    """Mark a pending refund succeeded and apply it to the order lines and stock.

    The caller holds the lock on ``order``.
    """
    refund_lines = list(refund.lines.select_related("order_line"))
    for refund_line in refund_lines:
        OrderLine.objects.filter(pk=refund_line.order_line_id).update(
            refunded_quantity=F("refunded_quantity") + refund_line.quantity,
        )
    restocked = [refund_line for refund_line in refund_lines if refund_line.restock]
    if restocked:
        stock = lock_stock(refund_line.order_line.product_id for refund_line in restocked)
        for refund_line in restocked:
            apply_movement(
                stock[refund_line.order_line.product_id],
                kind=StockMovement.Kind.RESTOCK,
                on_hand_delta=refund_line.quantity,
                order=order,
                refund=refund,
            )
    refund.status = Refund.Status.SUCCEEDED
    refund.save(update_fields=["status", "updated_at"])


def succeeded_minor(order: Order) -> int:
    totals = Refund.objects.filter(order=order, status=Refund.Status.SUCCEEDED).aggregate(
        total=Sum("amount_minor"),
    )
    return totals["total"] or 0
