from datetime import timedelta

import pytest

from inventory.services import adjust_stock, receive_stock
from orders import services as order_services
from orders.models import Order
from payments.models import Refund
from payments.services import events, refunds
from tests.factories import stocked_product
from tests.helpers import NOW, assert_ledger_balanced, create_order, pay, stock_of, store_event

pytestmark = pytest.mark.django_db


def test_movement_sums_match_counters_after_a_mixed_sequence(manager):
    mug = stocked_product(on_hand=20, sku="MUG-01", price_minor=1200)
    tea = stocked_product(on_hand=8, sku="TEA-01", price_minor=450)
    products = (mug, tea)

    receive_stock(mug, quantity=5, reason="delivery", actor=manager)
    adjust_stock(tea, delta=-1, reason="broken", actor=manager)

    cancelled = create_order((mug, 2), (tea, 1))
    order_services.cancel_order(cancelled.pk, now=NOW, actor=manager)

    expired = create_order((mug, 3), now=NOW - timedelta(hours=1))
    order_services.expire_due_orders(now=NOW)

    late = create_order((tea, 2), now=NOW - timedelta(hours=1))
    order_services.expire_order(late.pk, now=NOW)
    events.process_event(store_event("payment.succeeded", late).pk, now=NOW)

    paid = pay(create_order((mug, 4), (tea, 3)))
    refund = refunds.create_refund(
        order_number=paid.number,
        request=refunds.RefundRequest(
            reason="damaged",
            lines=[
                refunds.RefundLineRequest(
                    order_line_id=paid.lines.get(sku="MUG-01").id,
                    quantity=2,
                    restock=True,
                ),
            ],
        ),
        actor=manager,
        limit_minor=None,
    )
    events.process_event(
        store_event("refund.succeeded", paid, refund_reference=str(refund.id), refund_id="re_1").pk,
        now=NOW,
    )

    pending = create_order((mug, 1))
    adjust_stock(mug, delta=2, reason="recount", actor=manager)

    assert Order.objects.get(pk=expired.pk).status == Order.Status.EXPIRED
    assert Order.objects.get(pk=late.pk).status == Order.Status.PAID
    assert Order.objects.get(pk=pending.pk).status == Order.Status.PENDING_PAYMENT
    assert Refund.objects.get(pk=refund.pk).status == Refund.Status.SUCCEEDED
    assert (stock_of(mug).on_hand, stock_of(mug).reserved) == (20 + 5 - 4 + 2 + 2, 1)
    assert (stock_of(tea).on_hand, stock_of(tea).reserved) == (8 - 1 - 2 - 3, 0)
    for product in products:
        assert_ledger_balanced(product)
