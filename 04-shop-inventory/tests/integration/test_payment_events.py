from datetime import timedelta

import pytest

from inventory.models import StockMovement
from inventory.services import adjust_stock
from orders import services as order_services
from orders.models import Order
from payments import tasks
from payments.exceptions import OrderNotFoundYet
from payments.models import Refund, WebhookEvent
from payments.services import events
from tests.factories import stocked_product
from tests.helpers import NOW, assert_ledger_balanced, create_order, stock_of, store_event

pytestmark = pytest.mark.django_db


class WorkerCrash(BaseException):
    pass


@pytest.fixture
def product():
    return stocked_product(on_hand=5, sku="MUG-01", price_minor=1200)


def process(event) -> str:
    return events.process_event(event.pk, now=NOW)


def reload(instance):
    instance.refresh_from_db()
    return instance


def test_payment_succeeded_pays_a_pending_order_and_commits_stock(product):
    order = create_order((product, 2))
    event = store_event("payment.succeeded", order, created=NOW - timedelta(seconds=5))

    assert process(event) == WebhookEvent.Status.PROCESSED

    order = reload(order)
    assert (order.status, order.amount_paid_minor, order.paid_at) == ("paid", 2400, NOW)
    assert order.last_payment_event_at == NOW - timedelta(seconds=5)
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)
    event = reload(event)
    assert (event.status, event.attempts, event.processed_at) == ("processed", 1, NOW)
    assert_ledger_balanced(product)


def test_processing_the_same_event_twice_has_no_further_effect(product):
    order = create_order((product, 2))
    event = store_event("payment.succeeded", order)

    process(event)
    assert process(event) == WebhookEvent.Status.PROCESSED

    assert StockMovement.objects.filter(order=order, kind="commit").count() == 1
    assert reload(event).attempts == 1
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)


def test_task_run_twice_for_one_event_is_a_no_op_the_second_time(product):
    order = create_order((product, 2))
    event = store_event("payment.succeeded", order)

    tasks.process_webhook_event(str(event.pk))
    tasks.process_webhook_event(str(event.pk))

    assert StockMovement.objects.filter(order=order, kind="commit").count() == 1
    assert_ledger_balanced(product)


def test_second_event_for_a_paid_order_is_ignored(product):
    order = create_order((product, 2))
    process(store_event("payment.succeeded", order))

    assert process(store_event("payment.succeeded", order)) == WebhookEvent.Status.IGNORED

    assert StockMovement.objects.filter(order=order, kind="commit").count() == 1


def test_payment_after_the_deadline_but_before_expiry_ran_pays_normally(product):
    order = create_order((product, 2), now=NOW - timedelta(hours=2))

    process(store_event("payment.succeeded", order))

    assert reload(order).status == Order.Status.PAID
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)


@pytest.mark.parametrize("released_as", ["expired", "cancelled"])
def test_late_payment_with_stock_available_reacquires_it(product, released_as):
    order = create_order((product, 2), now=NOW - timedelta(hours=2))
    order_services.release_unpaid_order(order.pk, to_status=released_as, now=NOW)

    process(store_event("payment.succeeded", order))

    order = reload(order)
    assert (order.status, order.amount_paid_minor) == ("paid", 2400)
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)
    commit = StockMovement.objects.get(order=order, kind="commit")
    assert (commit.on_hand_delta, commit.reserved_delta) == (-2, 0)
    assert_ledger_balanced(product)


def test_late_payment_with_stock_gone_keeps_status_and_refunds_in_full(
    product,
    published,
    django_capture_on_commit_callbacks,
):
    order = create_order((product, 2), now=NOW - timedelta(hours=2))
    order_services.expire_order(order.pk, now=NOW)
    adjust_stock(product, delta=-4, reason="sold in store", actor=None)
    event = store_event("payment.succeeded", order)

    with django_capture_on_commit_callbacks(execute=True):
        assert process(event) == WebhookEvent.Status.PROCESSED

    order = reload(order)
    assert (order.status, order.amount_paid_minor) == ("expired", 2400)
    refund = Refund.objects.get(order=order)
    assert (refund.source, refund.status, refund.amount_minor) == ("system", "pending", 2400)
    assert refund.reason == "stock_unavailable"
    assert published == [("payments.submit_refund", (str(refund.id),))]
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (1, 0)
    assert not StockMovement.objects.filter(order=order, kind="commit").exists()
    assert_ledger_balanced(product)


@pytest.mark.parametrize(
    "data",
    [{"amount_minor": 2399}, {"currency": "EUR"}],
)
def test_mismatched_payment_flags_the_order_and_keeps_the_reservation(product, data):
    order = create_order((product, 2))

    assert process(store_event("payment.succeeded", order, **data)) == "processed"

    order = reload(order)
    assert order.status == Order.Status.PENDING_PAYMENT
    assert order.needs_review is True
    assert "does not match" in order.review_reason
    assert stock_of(product).reserved == 2
    assert not StockMovement.objects.filter(order=order, kind="commit").exists()


def test_payment_failed_after_a_later_success_is_ignored(product):
    order = create_order((product, 2))
    success = store_event("payment.succeeded", order, created=NOW)
    failure = store_event("payment.failed", order, created=NOW - timedelta(seconds=30))

    process(success)

    assert process(failure) == WebhookEvent.Status.IGNORED
    assert reload(order).status == Order.Status.PAID


def test_payment_failed_records_the_reason_and_leaves_the_order_pending(product):
    order = create_order((product, 2))

    event = store_event("payment.failed", order, failure_reason="card_declined")

    assert process(event) == WebhookEvent.Status.PROCESSED
    order = reload(order)
    assert (order.status, order.payment_failure_reason) == ("pending_payment", "card_declined")
    assert order.last_payment_event_at == NOW
    assert stock_of(product).reserved == 2


def test_older_payment_failed_is_ignored_for_a_pending_order(product):
    order = create_order((product, 2))
    process(store_event("payment.succeeded", order, created=NOW, amount_minor=1))
    stale = store_event("payment.failed", order, created=NOW - timedelta(minutes=1))

    assert process(stale) == WebhookEvent.Status.IGNORED
    assert reload(order).payment_failure_reason == ""


def test_payment_failed_with_the_same_timestamp_is_ignored(product):
    order = create_order((product, 2))
    process(store_event("payment.failed", order, created=NOW, failure_reason="first"))

    duplicate = store_event("payment.failed", order, created=NOW, failure_reason="second")

    assert process(duplicate) == WebhookEvent.Status.IGNORED
    assert reload(order).payment_failure_reason == "first"


def test_unknown_event_type_is_ignored(product):
    order = create_order((product, 2))

    event = store_event("customer.updated", order)

    assert process(event) == WebhookEvent.Status.IGNORED
    assert reload(event).processed_at == NOW


def test_unknown_payment_intent_is_retried_without_changing_the_event_status(product):
    order = create_order((product, 2))
    Order.objects.filter(pk=order.pk).update(payment_intent_id="pi_other")
    event = store_event("payment.succeeded", order)

    retry = events.run_processing_attempt(event.pk, retries=0, max_retries=6, now=NOW)

    assert retry is not None
    assert retry.countdown == 5
    assert isinstance(retry.error, OrderNotFoundYet)
    event = reload(event)
    assert (event.status, event.attempts) == ("received", 1)
    assert event.last_error.startswith("OrderNotFoundYet")


def test_unknown_payment_intent_fails_the_event_once_retries_are_exhausted(product):
    order = create_order((product, 2))
    Order.objects.filter(pk=order.pk).update(payment_intent_id="pi_other")
    event = store_event("payment.succeeded", order)

    assert events.run_processing_attempt(event.pk, retries=6, max_retries=6, now=NOW) is None

    event = reload(event)
    assert (event.status, event.attempts) == ("failed", 1)


def test_task_called_directly_raises_the_retryable_error(product):
    order = create_order((product, 2))
    Order.objects.filter(pk=order.pk).update(payment_intent_id="pi_other")
    event = store_event("payment.succeeded", order)

    with pytest.raises(OrderNotFoundYet):
        tasks.process_webhook_event(str(event.pk))

    assert reload(event).status == WebhookEvent.Status.RECEIVED


def test_failed_event_succeeds_when_processed_again(product):
    order = create_order((product, 2))
    intent = order.payment_intent_id
    Order.objects.filter(pk=order.pk).update(payment_intent_id="pi_other")
    event = store_event("payment.succeeded", order, payment_intent_id=intent)
    events.run_processing_attempt(event.pk, retries=6, max_retries=6, now=NOW)
    Order.objects.filter(pk=order.pk).update(payment_intent_id=intent)

    assert process(event) == WebhookEvent.Status.PROCESSED

    assert (reload(event).attempts, reload(order).status) == (2, "paid")


def test_malformed_event_data_fails_without_retry(product):
    order = create_order((product, 2))
    event = store_event("payment.succeeded", order)
    event.payload["data"] = {"payment_intent_id": order.payment_intent_id}
    event.save()

    assert events.run_processing_attempt(event.pk, retries=0, max_retries=6, now=NOW) is None

    event = reload(event)
    assert event.status == WebhookEvent.Status.FAILED
    assert event.last_error.startswith("InvalidEventData")
    assert reload(order).status == Order.Status.PENDING_PAYMENT


def test_crash_mid_processing_rolls_back_and_a_redelivery_completes(product, monkeypatch):
    order = create_order((product, 2))
    event = store_event("payment.succeeded", order)
    real_pay = events.pay_pending_order

    def crash_after_paying(order, **kwargs):
        real_pay(order, **kwargs)
        raise WorkerCrash()

    monkeypatch.setattr(events, "pay_pending_order", crash_after_paying)
    with pytest.raises(WorkerCrash):
        process(event)

    assert reload(order).status == Order.Status.PENDING_PAYMENT
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (5, 2)
    assert (reload(event).status, reload(event).attempts) == ("received", 0)

    monkeypatch.setattr(events, "pay_pending_order", real_pay)
    assert process(event) == WebhookEvent.Status.PROCESSED
    assert reload(order).status == Order.Status.PAID
    assert_ledger_balanced(product)
