from datetime import timedelta

import pytest

from core.models import IdempotencyRecord
from inventory.models import StockMovement
from inventory.services import receive_stock
from orders.models import Order
from payments.provider import ProviderTransientError
from tests.factories import stocked_product
from tests.helpers import NOW, assert_ledger_balanced, checkout, create_order, stock_of

pytestmark = pytest.mark.django_db


def test_checkout_reserves_stock_and_returns_payment_details(anon_client, provider):
    mug = stocked_product(on_hand=5, sku="MUG-01", price_minor=1200)
    tea = stocked_product(on_hand=5, sku="TEA-01", price_minor=450)

    response = checkout(
        anon_client,
        [{"sku": "MUG-01", "quantity": 2}, {"sku": "TEA-01", "quantity": 3}],
    )

    assert response.status_code == 201
    body = response.json()
    assert body["number"].startswith("SO-")
    assert body["status"] == "pending_payment"
    assert body["total_minor"] == 2 * 1200 + 3 * 450
    assert body["currency"] == "USD"
    assert body["client_secret"].startswith("pi_")
    assert body["reservation_expires_at"] == "2026-03-02T12:30:00Z"
    order = Order.objects.get(number=body["number"])
    assert body["public_token"] == order.public_token
    assert order.payment_intent_id
    assert (stock_of(mug).reserved, stock_of(tea).reserved) == (2, 3)
    assert StockMovement.objects.filter(order=order, kind="reserve").count() == 2
    assert [call[0] for call in provider.calls] == ["create_payment_intent"]
    assert_ledger_balanced(mug)
    assert_ledger_balanced(tea)


def test_checkout_snapshots_line_name_and_price(anon_client):
    mug = stocked_product(on_hand=5, sku="MUG-01", name="Blue mug", price_minor=1200)

    response = checkout(anon_client, [{"sku": "MUG-01", "quantity": 1}])

    line = Order.objects.get(number=response.json()["number"]).lines.get()
    assert (line.sku, line.name, line.unit_price_minor, line.product_id) == (
        "MUG-01",
        "Blue mug",
        1200,
        mug.pk,
    )


def test_duplicate_skus_are_merged_into_one_line(anon_client):
    mug = stocked_product(on_hand=5, sku="MUG-01")

    response = checkout(
        anon_client,
        [{"sku": "MUG-01", "quantity": 1}, {"sku": "MUG-01", "quantity": 2}],
    )

    assert response.status_code == 201
    assert [(line["sku"], line["quantity"]) for line in response.json()["lines"]] == [
        ("MUG-01", 3),
    ]
    assert stock_of(mug).reserved == 3


def test_shortage_on_any_line_fails_the_whole_order_and_reserves_nothing(anon_client):
    mug = stocked_product(on_hand=5, sku="MUG-01")
    tea = stocked_product(on_hand=1, sku="TEA-01")

    response = checkout(
        anon_client,
        [{"sku": "MUG-01", "quantity": 2}, {"sku": "TEA-01", "quantity": 2}],
    )

    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "insufficient_stock"
    assert error["details"]["lines"] == [{"sku": "TEA-01", "requested": 2, "available": 1}]
    assert (stock_of(mug).reserved, stock_of(tea).reserved) == (0, 0)
    assert not Order.objects.exists()
    assert not StockMovement.objects.filter(kind="reserve").exists()


def test_every_short_line_is_reported(anon_client):
    stocked_product(on_hand=0, sku="MUG-01")
    stocked_product(on_hand=1, sku="TEA-01")

    response = checkout(
        anon_client,
        [{"sku": "MUG-01", "quantity": 1}, {"sku": "TEA-01", "quantity": 4}],
    )

    assert [line["sku"] for line in response.json()["error"]["details"]["lines"]] == [
        "MUG-01",
        "TEA-01",
    ]


def test_reserved_units_are_not_available_to_the_next_checkout(anon_client):
    stocked_product(on_hand=3, sku="MUG-01")

    first = checkout(anon_client, [{"sku": "MUG-01", "quantity": 2}], key="checkout-key-1")
    second = checkout(anon_client, [{"sku": "MUG-01", "quantity": 2}], key="checkout-key-2")

    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["error"]["details"]["lines"][0]["available"] == 1


@pytest.mark.parametrize("active", [True, False])
def test_unknown_or_inactive_sku_is_rejected(anon_client, active):
    stocked_product(on_hand=5, sku="OLD-01", active=active)
    sku = "NOPE-01" if active else "OLD-01"

    response = checkout(anon_client, [{"sku": sku, "quantity": 1}])

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unknown_product"
    assert response.json()["error"]["details"] == {"skus": [sku]}


@pytest.mark.parametrize(
    "lines",
    [
        [],
        [{"sku": "MUG-01", "quantity": 0}],
        [{"sku": "MUG-01", "quantity": 1000}],
        [{"sku": "MUG-01", "quantity": 600}, {"sku": "MUG-01", "quantity": 400}],
        [{"sku": f"SKU-{index}", "quantity": 1} for index in range(51)],
    ],
)
def test_line_limits_are_validated(anon_client, lines):
    response = checkout(anon_client, lines)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
    assert not IdempotencyRecord.objects.exists()


def test_fifty_distinct_lines_are_accepted(anon_client):
    for index in range(50):
        stocked_product(on_hand=1, sku=f"P-{index:02d}")

    response = checkout(anon_client, [{"sku": f"P-{i:02d}", "quantity": 1} for i in range(50)])

    assert response.status_code == 201


def test_missing_idempotency_key_is_rejected(anon_client):
    stocked_product(on_hand=5, sku="MUG-01")

    response = anon_client.post(
        "/api/orders/",
        {"email": "buyer@example.com", "lines": [{"sku": "MUG-01", "quantity": 1}]},
        format="json",
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "idempotency_key_required"


def test_same_key_and_body_replays_the_first_response(anon_client, provider):
    mug = stocked_product(on_hand=5, sku="MUG-01")
    lines = [{"sku": "MUG-01", "quantity": 2}]

    first = checkout(anon_client, lines)
    second = checkout(anon_client, lines)

    assert second.status_code == first.status_code == 201
    assert second.json() == first.json()
    assert Order.objects.count() == 1
    assert stock_of(mug).reserved == 2
    assert len(provider.calls) == 1


def test_same_key_with_a_different_body_is_rejected(anon_client):
    stocked_product(on_hand=5, sku="MUG-01")

    checkout(anon_client, [{"sku": "MUG-01", "quantity": 1}])
    response = checkout(anon_client, [{"sku": "MUG-01", "quantity": 2}])

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "idempotency_key_reused"
    assert Order.objects.count() == 1


def test_business_rejections_are_stored_and_replayed(anon_client):
    mug = stocked_product(on_hand=1, sku="MUG-01")
    lines = [{"sku": "MUG-01", "quantity": 2}]

    first = checkout(anon_client, lines)
    receive_stock(mug, quantity=9, reason="delivery", actor=None)
    second = checkout(anon_client, lines)

    assert first.status_code == second.status_code == 409
    assert second.json() == first.json()


def test_provider_failure_cancels_the_order_and_does_not_store_the_response(
    anon_client,
    provider,
):
    mug = stocked_product(on_hand=5, sku="MUG-01")
    provider.fail_next_intent(ProviderTransientError("timeout"))
    lines = [{"sku": "MUG-01", "quantity": 2}]

    failed = checkout(anon_client, lines)

    assert failed.status_code == 502
    assert failed.json()["error"]["code"] == "payment_provider_unavailable"
    cancelled = Order.objects.get()
    assert cancelled.status == Order.Status.CANCELLED
    assert stock_of(mug).reserved == 0
    assert not IdempotencyRecord.objects.exists()
    assert_ledger_balanced(mug)

    retried = checkout(anon_client, lines)

    assert retried.status_code == 201
    assert Order.objects.count() == 2
    assert stock_of(mug).reserved == 2


def test_price_change_after_checkout_does_not_change_the_order(manager_client):
    mug = stocked_product(on_hand=5, sku="MUG-01", price_minor=1200)
    order = create_order((mug, 2))

    manager_client.patch("/api/products/MUG-01/", {"price_minor": 9900}, format="json")

    order.refresh_from_db()
    assert order.total_minor == 2400
    assert order.lines.get().unit_price_minor == 1200


def test_anonymous_reads_an_order_with_its_token(anon_client):
    order = create_order((stocked_product(on_hand=5), 1))

    response = anon_client.get(f"/api/orders/{order.number}/?token={order.public_token}")

    assert response.status_code == 200
    assert response.json()["number"] == order.number
    assert "payment_intent_id" not in response.json()


@pytest.mark.parametrize("query", ["", "?token=", "?token=wrong-token"])
def test_anonymous_order_read_without_the_right_token_is_not_found(anon_client, query):
    order = create_order((stocked_product(on_hand=5), 1))

    response = anon_client.get(f"/api/orders/{order.number}/{query}")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_unknown_order_number_is_not_found_for_anonymous(anon_client):
    response = anon_client.get("/api/orders/SO-999999/?token=anything")

    assert response.status_code == 404


def test_staff_reads_any_order_without_a_token(clerk_client):
    order = create_order((stocked_product(on_hand=5), 1))

    response = clerk_client.get(f"/api/orders/{order.number}/")

    assert response.status_code == 200
    assert response.json()["payment_intent_id"] == order.payment_intent_id


def test_staff_lists_orders_with_filters(clerk_client):
    product = stocked_product(on_hand=10)
    first = create_order((product, 1), email="ann@example.com")
    create_order((product, 1), email="bob@example.com", now=NOW + timedelta(minutes=1))
    Order.objects.filter(pk=first.pk).update(needs_review=True)

    by_email = clerk_client.get("/api/orders/?email=ANN@example.com").json()
    by_review = clerk_client.get("/api/orders/?needs_review=true").json()
    by_status = clerk_client.get("/api/orders/?status=paid").json()

    assert [row["number"] for row in by_email["results"]] == [first.number]
    assert [row["number"] for row in by_review["results"]] == [first.number]
    assert by_status["count"] == 0


def test_invalid_order_filter_is_a_validation_error(clerk_client):
    response = clerk_client.get("/api/orders/?status=shipped")

    assert response.status_code == 400


def test_anonymous_cannot_list_orders(anon_client):
    assert anon_client.get("/api/orders/").status_code == 401
