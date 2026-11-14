import json
from functools import partial

import pytest
from django.db.models import Sum
from django.test import Client
from rest_framework.test import APIClient

from inventory.models import StockMovement
from inventory.services import receive_stock
from orders import services as order_services
from orders.exceptions import InsufficientStock
from orders.models import Order
from orders.services import LineRequest, place_order
from payments.models import Refund, WebhookEvent
from payments.services import events
from payments.signature import build_header
from tests.factories import staff_user, stocked_product
from tests.helpers import (
    NOW,
    assert_ledger_balanced,
    client_for,
    create_order,
    event_payload,
    pay,
    run_concurrently,
    stock_of,
    store_event,
)

pytestmark = pytest.mark.django_db(transaction=True)

SECRET = "whsec_concurrency_secret"


def checkout_call(lines: list[dict], key: str):
    def call():
        response = APIClient().post(
            "/api/orders/",
            {"email": "buyer@example.com", "lines": lines},
            format="json",
            HTTP_IDEMPOTENCY_KEY=key,
        )
        return response.status_code, response.json()

    return call


def statuses(results) -> list[int]:
    for result in results:
        if isinstance(result, BaseException):
            raise result
    return sorted(result[0] for result in results)


def test_two_checkouts_for_the_last_unit_reserve_it_once():
    product = stocked_product(on_hand=1, sku="LAST-01")
    lines = [{"sku": "LAST-01", "quantity": 1}]

    results = run_concurrently(
        checkout_call(lines, "concurrent-key-a"),
        checkout_call(lines, "concurrent-key-b"),
    )

    assert statuses(results) == [201, 409]
    assert stock_of(product).reserved == 1
    assert Order.objects.count() == 1
    assert_ledger_balanced(product)


def test_checkouts_locking_products_in_opposite_order_both_succeed():
    alpha = stocked_product(on_hand=50, sku="ALPHA")
    beta = stocked_product(on_hand=50, sku="BETA")

    for round_number in range(5):
        results = run_concurrently(
            checkout_call(
                [{"sku": "ALPHA", "quantity": 1}, {"sku": "BETA", "quantity": 1}],
                f"forward-key-{round_number}",
            ),
            checkout_call(
                [{"sku": "BETA", "quantity": 1}, {"sku": "ALPHA", "quantity": 1}],
                f"reverse-key-{round_number}",
            ),
        )
        assert statuses(results) == [201, 201]

    assert (stock_of(alpha).reserved, stock_of(beta).reserved) == (10, 10)
    assert_ledger_balanced(alpha)
    assert_ledger_balanced(beta)


def test_concurrent_receive_and_checkout_match_the_serial_result():
    product = stocked_product(on_hand=5, sku="MUG-01")

    def receive():
        return receive_stock(product, quantity=3, reason="delivery", actor=None)

    def buy():
        return place_order(
            email="buyer@example.com",
            lines=[LineRequest(sku="MUG-01", quantity=4)],
            now=NOW,
        )

    results = run_concurrently(receive, buy)

    assert not any(isinstance(result, BaseException) for result in results)
    item = stock_of(product)
    assert (item.on_hand, item.reserved) == (8, 4)
    assert_ledger_balanced(product)


def test_concurrent_duplicate_checkouts_create_one_order_and_share_the_response(provider):
    product = stocked_product(on_hand=5, sku="MUG-01")
    call = checkout_call([{"sku": "MUG-01", "quantity": 2}], "same-key-123")

    first, second = run_concurrently(call, call)

    assert first[0] == second[0] == 201
    assert first[1] == second[1]
    assert Order.objects.count() == 1
    assert stock_of(product).reserved == 2
    assert len([c for c in provider.calls if c[0] == "create_payment_intent"]) == 1
    assert_ledger_balanced(product)


def test_same_event_delivered_concurrently_pays_the_order_once(settings, published):
    settings.PAYMENT_WEBHOOK_SECRET = SECRET
    product = stocked_product(on_hand=5)
    order = create_order((product, 2))
    body = json.dumps(event_payload("payment.succeeded", order, event_id="evt_twice")).encode()
    header = build_header(SECRET, int(NOW.timestamp()), body)

    def deliver():
        response = Client().post(
            "/webhooks/payments/",
            body,
            content_type="application/json",
            HTTP_X_PAY_SIGNATURE=header,
        )
        return response.status_code, response.json()["status"]

    results = run_concurrently(deliver, deliver)

    assert sorted(results) == [(200, "accepted"), (200, "duplicate")]
    assert WebhookEvent.objects.count() == 1
    queued = [args[0] for name, args in published if name == "payments.process_webhook_event"]
    assert len(queued) == 2

    run_concurrently(*[partial(events.process_event, event_id, now=NOW) for event_id in queued])

    order.refresh_from_db()
    assert order.status == Order.Status.PAID
    assert StockMovement.objects.filter(order=order, kind="commit").count() == 1
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)
    assert_ledger_balanced(product)


def test_expiry_racing_a_payment_never_double_counts_stock():
    for _ in range(3):
        product = stocked_product(on_hand=5)
        order = create_order((product, 2), now=NOW.replace(hour=10))
        event = store_event("payment.succeeded", order)

        results = run_concurrently(
            partial(order_services.expire_order, order.pk, now=NOW),
            partial(events.process_event, event.pk, now=NOW),
        )

        assert not any(isinstance(result, BaseException) for result in results)
        order.refresh_from_db()
        assert order.status == Order.Status.PAID
        movements = StockMovement.objects.filter(order=order)
        assert movements.filter(kind="commit").count() == 1
        assert movements.filter(kind="release").count() <= 1
        assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)
        assert_ledger_balanced(product)


def test_expiry_racing_a_payment_with_no_stock_left_refunds_or_pays():
    product = stocked_product(on_hand=2)
    order = create_order((product, 2), now=NOW.replace(hour=10))
    event = store_event("payment.succeeded", order)

    def expire_and_sell_out():
        if not order_services.expire_order(order.pk, now=NOW):
            return
        try:
            place_order(
                email="walk-in@example.com",
                lines=[LineRequest(sku=product.sku, quantity=2)],
                now=NOW,
            )
        except InsufficientStock:
            pass

    results = run_concurrently(
        expire_and_sell_out,
        lambda: events.process_event(event.pk, now=NOW),
    )

    assert not any(isinstance(result, BaseException) for result in results)
    order.refresh_from_db()
    item = stock_of(product)
    if order.status == Order.Status.PAID:
        assert (item.on_hand, item.reserved) == (0, 0)
    else:
        assert order.status == Order.Status.EXPIRED
        assert Refund.objects.get(order=order).source == Refund.Source.SYSTEM
        assert (item.on_hand, item.reserved) == (2, 2)
    assert_ledger_balanced(product)


def test_concurrent_cancels_release_stock_once():
    clerk = staff_user("clerk")
    product = stocked_product(on_hand=5)
    order = create_order((product, 2))

    def cancel():
        return client_for(clerk).post(f"/api/orders/{order.number}/cancel/").status_code

    results = run_concurrently(cancel, cancel)

    assert sorted(results) == [200, 409]
    assert StockMovement.objects.filter(order=order, kind="release").count() == 1
    assert stock_of(product).reserved == 0
    assert_ledger_balanced(product)


def test_cancel_racing_a_payment_has_one_winner():
    clerk = staff_user("clerk")
    product = stocked_product(on_hand=5)
    order = create_order((product, 2))
    event = store_event("payment.succeeded", order)

    results = run_concurrently(
        lambda: client_for(clerk).post(f"/api/orders/{order.number}/cancel/").status_code,
        lambda: events.process_event(event.pk, now=NOW),
    )

    cancel_status, _ = results
    assert cancel_status in (200, 409)
    order.refresh_from_db()
    assert order.status == Order.Status.PAID
    movements = StockMovement.objects.filter(order=order)
    assert movements.filter(kind="release").count() == (1 if cancel_status == 200 else 0)
    assert movements.filter(kind="commit").count() == 1
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)
    assert_ledger_balanced(product)


def test_concurrent_refunds_cannot_exceed_the_amount_paid():
    manager = staff_user("manager")
    order = pay(create_order((stocked_product(on_hand=5, price_minor=4500), 1)))

    def refund(key: str):
        def call():
            response = client_for(manager).post(
                f"/api/orders/{order.number}/refunds/",
                {"amount_minor": 3000, "reason": "goodwill"},
                format="json",
                HTTP_IDEMPOTENCY_KEY=key,
            )
            return response.status_code

        return call

    results = run_concurrently(refund("refund-key-a"), refund("refund-key-b"))

    assert sorted(results) == [202, 422]
    claimed = Refund.objects.filter(order=order).aggregate(total=Sum("amount_minor"))["total"]
    assert claimed == 3000
