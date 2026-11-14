import pytest

from inventory.models import StockMovement
from orders.models import Order
from payments.models import Refund, WebhookEvent
from payments.services import events, refunds
from tests.factories import stocked_product
from tests.helpers import NOW, assert_ledger_balanced, create_order, pay, stock_of, store_event

pytestmark = pytest.mark.django_db


@pytest.fixture
def mug():
    return stocked_product(on_hand=10, sku="MUG-01", price_minor=1200)


@pytest.fixture
def paid_order(mug) -> Order:
    return pay(create_order((mug, 3)))


def refund_lines(client, order: Order, quantity: int, *, restock: bool, key: str):
    line_id = str(order.lines.get().id)
    body = {
        "lines": [{"order_line_id": line_id, "quantity": quantity, "restock": restock}],
        "reason": "damaged",
    }
    response = client.post(
        f"/api/orders/{order.number}/refunds/",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert response.status_code == 202, response.json()
    return Refund.objects.get(pk=response.json()["id"])


def refund_event(event_type: str, order: Order, refund: Refund | None = None, **data):
    if refund is not None:
        data.setdefault("refund_reference", str(refund.id))
        data.setdefault("amount_minor", refund.amount_minor)
    return events.process_event(store_event(event_type, order, **data).pk, now=NOW)


def submit(refund: Refund) -> Refund:
    refunds.submit_refund(refund.id, retries=0, max_retries=5, now=NOW)
    refund.refresh_from_db()
    return refund


def test_stock_is_restocked_only_when_the_refund_succeeds(manager_client, paid_order, mug):
    refund = submit(refund_lines(manager_client, paid_order, 2, restock=True, key="key-0001"))
    assert stock_of(mug).on_hand == 7

    outcome = refund_event(
        "refund.succeeded",
        paid_order,
        refund,
        refund_id=refund.provider_refund_id,
    )

    assert outcome == WebhookEvent.Status.PROCESSED
    refund.refresh_from_db()
    assert refund.status == Refund.Status.SUCCEEDED
    assert paid_order.lines.get().refunded_quantity == 2
    assert stock_of(mug).on_hand == 9
    restock = StockMovement.objects.get(kind="restock")
    assert (restock.refund_id, restock.order_id, restock.on_hand_delta) == (
        refund.id,
        paid_order.id,
        2,
    )
    assert_ledger_balanced(mug)


def test_a_second_success_event_does_not_restock_again(manager_client, paid_order, mug):
    refund = submit(refund_lines(manager_client, paid_order, 2, restock=True, key="key-0001"))
    refund_event("refund.succeeded", paid_order, refund, refund_id=refund.provider_refund_id)

    provider_id = refund.provider_refund_id
    again = refund_event("refund.succeeded", paid_order, refund, refund_id=provider_id)

    assert again == WebhookEvent.Status.IGNORED
    assert StockMovement.objects.filter(kind="restock").count() == 1
    assert paid_order.lines.get().refunded_quantity == 2


def test_lines_without_restock_are_counted_but_not_returned(manager_client, paid_order, mug):
    refund = submit(refund_lines(manager_client, paid_order, 1, restock=False, key="key-0001"))

    refund_event("refund.succeeded", paid_order, refund, refund_id=refund.provider_refund_id)

    assert paid_order.lines.get().refunded_quantity == 1
    assert stock_of(mug).on_hand == 7


def test_success_before_the_provider_id_was_stored_matches_by_reference(
    manager_client,
    paid_order,
):
    refund = refund_lines(manager_client, paid_order, 1, restock=False, key="key-0001")

    refund_event("refund.succeeded", paid_order, refund, refund_id="re_from_webhook")

    refund.refresh_from_db()
    assert (refund.status, refund.provider_refund_id) == ("succeeded", "re_from_webhook")
    assert submit(refund).provider_refund_id == "re_from_webhook"


def test_failed_refund_event_frees_capacity_for_a_new_refund(manager_client, paid_order):
    refund = submit(refund_lines(manager_client, paid_order, 3, restock=False, key="key-0001"))

    refund_event(
        "refund.failed",
        paid_order,
        refund,
        refund_id=refund.provider_refund_id,
        failure_reason="insufficient_funds",
    )

    refund.refresh_from_db()
    assert (refund.status, refund.failure_reason) == ("failed", "insufficient_funds")
    assert paid_order.lines.get().refunded_quantity == 0
    refund_lines(manager_client, paid_order, 3, restock=False, key="key-0002")


def test_failure_after_success_flags_the_order_without_touching_stock(
    manager_client,
    paid_order,
    mug,
):
    refund = submit(refund_lines(manager_client, paid_order, 2, restock=True, key="key-0001"))
    refund_event("refund.succeeded", paid_order, refund, refund_id=refund.provider_refund_id)

    outcome = refund_event("refund.failed", paid_order, refund, refund_id=refund.provider_refund_id)

    assert outcome == WebhookEvent.Status.PROCESSED
    refund.refresh_from_db()
    assert refund.status == Refund.Status.SUCCEEDED
    order = Order.objects.get(pk=paid_order.pk)
    assert order.needs_review is True
    assert stock_of(mug).on_hand == 9
    assert_ledger_balanced(mug)


def test_success_after_failure_flags_the_order(manager_client, paid_order):
    refund = submit(refund_lines(manager_client, paid_order, 1, restock=True, key="key-0001"))
    refund_event("refund.failed", paid_order, refund, refund_id=refund.provider_refund_id)

    refund_event("refund.succeeded", paid_order, refund, refund_id=refund.provider_refund_id)

    refund.refresh_from_db()
    assert refund.status == Refund.Status.FAILED
    assert Order.objects.get(pk=paid_order.pk).needs_review is True
    assert not StockMovement.objects.filter(kind="restock").exists()


def test_dashboard_refund_is_recorded_as_provider_sourced(paid_order):
    outcome = refund_event("refund.succeeded", paid_order, refund_id="re_dash", amount_minor=1000)

    assert outcome == WebhookEvent.Status.PROCESSED
    refund = Refund.objects.get()
    assert (refund.source, refund.status, refund.amount_minor) == ("provider", "succeeded", 1000)
    assert refund.provider_refund_id == "re_dash"
    assert not refund.lines.exists()


def test_dashboard_refund_beyond_the_amount_paid_needs_review(paid_order):
    refund_event("refund.succeeded", paid_order, refund_id="re_dash_1", amount_minor=3000)

    refund_event("refund.succeeded", paid_order, refund_id="re_dash_2", amount_minor=601)

    assert Refund.objects.count() == 1
    order = Order.objects.get(pk=paid_order.pk)
    assert order.needs_review is True
    assert "re_dash_2" in order.review_reason


def test_dashboard_refund_counts_pending_refunds_against_the_amount_paid(
    manager_client,
    paid_order,
):
    refund_lines(manager_client, paid_order, 2, restock=False, key="key-0001")

    refund_event("refund.succeeded", paid_order, refund_id="re_dash", amount_minor=1201)

    assert not Refund.objects.filter(source=Refund.Source.PROVIDER).exists()
    assert Order.objects.get(pk=paid_order.pk).needs_review is True


def test_failure_for_an_unknown_refund_is_ignored(paid_order):
    outcome = refund_event("refund.failed", paid_order, refund_id="re_unknown", amount_minor=500)

    assert outcome == WebhookEvent.Status.IGNORED
    assert not Refund.objects.exists()


def test_two_partial_refunds_make_the_order_fully_refunded(manager_client, paid_order):
    for key, amount in (("key-0001", 1600), ("key-0002", 2000)):
        response = manager_client.post(
            f"/api/orders/{paid_order.number}/refunds/",
            {"amount_minor": amount, "reason": "goodwill"},
            format="json",
            HTTP_IDEMPOTENCY_KEY=key,
        )
        refund = submit(Refund.objects.get(pk=response.json()["id"]))
        refund_event("refund.succeeded", paid_order, refund, refund_id=refund.provider_refund_id)

    order = manager_client.get(f"/api/orders/{paid_order.number}/").json()
    further = manager_client.post(
        f"/api/orders/{paid_order.number}/refunds/",
        {"amount_minor": 1, "reason": "one more"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="key-0003",
    )

    assert (order["refunded_minor"], order["refund_state"]) == (3600, "full")
    assert further.status_code == 422
    assert further.json()["error"]["code"] == "exceeds_refundable"


def test_partial_refund_state(manager_client, paid_order):
    refund = submit(refund_lines(manager_client, paid_order, 1, restock=False, key="key-0001"))
    refund_event("refund.succeeded", paid_order, refund, refund_id=refund.provider_refund_id)

    order = manager_client.get(f"/api/orders/{paid_order.number}/").json()

    assert (order["refunded_minor"], order["refund_state"]) == (1200, "partial")


def test_refund_amounts_use_the_price_paid_not_the_current_price(manager_client, paid_order):
    manager_client.patch("/api/products/MUG-01/", {"price_minor": 5000}, format="json")

    refund = refund_lines(manager_client, paid_order, 2, restock=False, key="key-0001")

    assert refund.amount_minor == 2400
