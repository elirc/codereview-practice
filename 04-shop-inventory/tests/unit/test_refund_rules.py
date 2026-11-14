import uuid
from decimal import Decimal

import pytest

from payments.exceptions import (
    ExceedsRefundable,
    ExceedsRefundableQuantity,
    InvalidLine,
    RefundLimitExceeded,
)
from payments.services.refunds import (
    LineAvailability,
    RefundLineRequest,
    RefundRequest,
    refund_amount,
)

MUG = uuid.UUID("00000000-0000-0000-0000-000000000001")
TEA = uuid.UUID("00000000-0000-0000-0000-000000000002")


def lines(mug_refunded: int = 0, mug_pending: int = 0) -> dict[uuid.UUID, LineAvailability]:
    return {
        MUG: LineAvailability(
            unit_price_minor=1200,
            quantity=3,
            refunded_quantity=mug_refunded,
            pending_quantity=mug_pending,
        ),
        TEA: LineAvailability(
            unit_price_minor=450,
            quantity=2,
            refunded_quantity=0,
            pending_quantity=0,
        ),
    }


def amount_for(request, *, available=None, paid=4500, claimed=0, limit=None):
    return refund_amount(
        request,
        lines=available if available is not None else lines(),
        amount_paid_minor=paid,
        claimed_minor=claimed,
        limit_minor=limit,
    )


def line_request(*items: tuple[uuid.UUID, int]) -> RefundRequest:
    return RefundRequest(
        reason="damaged",
        lines=[RefundLineRequest(order_line_id=i, quantity=q, restock=False) for i, q in items],
    )


def test_line_refund_amount_uses_the_snapshotted_unit_price():
    assert amount_for(line_request((MUG, 2), (TEA, 1))) == 2 * 1200 + 450


def test_goodwill_refund_uses_the_given_amount():
    assert amount_for(RefundRequest(reason="sorry", amount_minor=300)) == 300


def test_pending_quantities_count_against_the_line():
    available = lines(mug_pending=2)

    assert amount_for(line_request((MUG, 1)), available=available) == 1200
    with pytest.raises(ExceedsRefundableQuantity) as excinfo:
        amount_for(line_request((MUG, 2)), available=available)

    assert excinfo.value.details["lines"] == [
        {"order_line_id": str(MUG), "requested": 2, "refundable": 1},
    ]


def test_already_refunded_quantities_count_against_the_line():
    with pytest.raises(ExceedsRefundableQuantity):
        amount_for(line_request((MUG, 2)), available=lines(mug_refunded=1, mug_pending=1))


def test_line_from_another_order_is_invalid():
    stranger = uuid.uuid4()

    with pytest.raises(InvalidLine) as excinfo:
        amount_for(line_request((stranger, 1)))

    assert excinfo.value.details == {"order_line_ids": [str(stranger)]}


def test_claimed_refunds_reduce_what_is_refundable():
    assert amount_for(RefundRequest(reason="x", amount_minor=500), paid=4500, claimed=4000) == 500
    with pytest.raises(ExceedsRefundable) as excinfo:
        amount_for(RefundRequest(reason="x", amount_minor=501), paid=4500, claimed=4000)

    assert excinfo.value.details == {"refundable_minor": 500}


def test_nothing_is_refundable_once_fully_claimed():
    with pytest.raises(ExceedsRefundable) as excinfo:
        amount_for(RefundRequest(reason="x", amount_minor=1), paid=4500, claimed=4500)

    assert excinfo.value.details == {"refundable_minor": 0}


def test_limit_allows_a_refund_exactly_at_the_limit():
    assert amount_for(RefundRequest(reason="x", amount_minor=5000), paid=9000, limit=5000) == 5000


def test_limit_refuses_a_refund_one_unit_over():
    with pytest.raises(RefundLimitExceeded):
        amount_for(RefundRequest(reason="x", amount_minor=5001), paid=9000, limit=5000)


def test_limit_applies_to_line_refund_amounts():
    with pytest.raises(RefundLimitExceeded):
        amount_for(line_request((MUG, 3)), limit=3000)


def test_no_limit_means_any_refundable_amount_is_allowed():
    assert amount_for(RefundRequest(reason="x", amount_minor=9000), paid=9000) == 9000


def test_percentage_refund_is_a_share_of_the_amount_paid():
    assert amount_for(RefundRequest(reason="late", percent=Decimal("20")), paid=4500) == 900


def test_percentage_refund_respects_what_is_already_claimed():
    with pytest.raises(ExceedsRefundable):
        amount_for(RefundRequest(reason="late", percent=Decimal("50")), paid=4500, claimed=3000)
