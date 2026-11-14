from datetime import timedelta

import pytest

from inventory.models import StockMovement
from orders import services, tasks
from orders.models import Order
from tests.factories import stocked_product
from tests.helpers import NOW, assert_ledger_balanced, create_order, pay, stock_of

pytestmark = pytest.mark.django_db


def test_staff_cancel_releases_the_reservation(clerk_client, clerk):
    product = stocked_product(on_hand=5)
    order = create_order((product, 2))

    response = clerk_client.post(f"/api/orders/{order.number}/cancel/")

    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"
    assert stock_of(product).reserved == 0
    release = StockMovement.objects.get(order=order, kind="release")
    assert (release.reserved_delta, release.actor) == (-2, clerk)
    assert_ledger_balanced(product)


def test_cancelling_twice_releases_stock_once(clerk_client):
    product = stocked_product(on_hand=5)
    order = create_order((product, 2))

    first = clerk_client.post(f"/api/orders/{order.number}/cancel/")
    second = clerk_client.post(f"/api/orders/{order.number}/cancel/")

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "invalid_state"
    assert StockMovement.objects.filter(order=order, kind="release").count() == 1
    assert_ledger_balanced(product)


def test_paid_order_cannot_be_cancelled(clerk_client):
    product = stocked_product(on_hand=5)
    order = pay(create_order((product, 2)))

    response = clerk_client.post(f"/api/orders/{order.number}/cancel/")

    assert response.status_code == 409
    assert Order.objects.get(pk=order.pk).status == Order.Status.PAID
    assert (stock_of(product).on_hand, stock_of(product).reserved) == (3, 0)


def test_paying_a_pending_order_commits_its_reservation():
    product = stocked_product(on_hand=5)
    order = pay(create_order((product, 2)), now=NOW + timedelta(minutes=3))

    order.refresh_from_db()
    assert (order.status, order.amount_paid_minor) == (Order.Status.PAID, order.total_minor)
    assert order.paid_at == NOW + timedelta(minutes=3)
    commit = StockMovement.objects.get(order=order, kind="commit")
    assert (commit.on_hand_delta, commit.reserved_delta) == (-2, -2)
    assert_ledger_balanced(product)


def test_fulfil_moves_a_paid_order_to_fulfilled(manager_client):
    order = pay(create_order((stocked_product(on_hand=5), 1)))

    response = manager_client.post(f"/api/orders/{order.number}/fulfil/")

    assert response.status_code == 200
    assert response.json()["status"] == "fulfilled"


def test_unpaid_order_cannot_be_fulfilled(manager_client):
    order = create_order((stocked_product(on_hand=5), 1))

    response = manager_client.post(f"/api/orders/{order.number}/fulfil/")

    assert response.status_code == 409


@pytest.mark.parametrize("action", ["cancel", "fulfil"])
def test_anonymous_cannot_change_orders(anon_client, action):
    order = create_order((stocked_product(on_hand=5), 1))

    assert anon_client.post(f"/api/orders/{order.number}/{action}/").status_code == 401


def test_cancel_unknown_order_is_not_found(clerk_client):
    assert clerk_client.post("/api/orders/SO-999999/cancel/").status_code == 404


def test_expiry_releases_only_orders_whose_reservation_has_passed():
    product = stocked_product(on_hand=10)
    due = create_order((product, 2), now=NOW - timedelta(minutes=31))
    boundary = create_order((product, 3), now=NOW - timedelta(minutes=30))
    fresh = create_order((product, 4), now=NOW - timedelta(minutes=29))

    assert services.expire_due_orders(now=NOW) == 2

    statuses = dict(Order.objects.values_list("number", "status"))
    assert statuses[due.number] == statuses[boundary.number] == Order.Status.EXPIRED
    assert statuses[fresh.number] == Order.Status.PENDING_PAYMENT
    assert stock_of(product).reserved == 4
    assert_ledger_balanced(product)


def test_running_expiry_again_does_not_release_twice():
    product = stocked_product(on_hand=10)
    order = create_order((product, 2), now=NOW - timedelta(hours=1))

    services.expire_due_orders(now=NOW)
    services.expire_due_orders(now=NOW + timedelta(minutes=1))

    assert StockMovement.objects.filter(order=order, kind="release").count() == 1
    assert_ledger_balanced(product)


def test_expiry_skips_an_order_paid_after_it_was_selected():
    product = stocked_product(on_hand=10)
    order = create_order((product, 2), now=NOW - timedelta(hours=1))
    pay(order)

    assert services.expire_order(order.pk, now=NOW) is False

    assert Order.objects.get(pk=order.pk).status == Order.Status.PAID
    assert not StockMovement.objects.filter(order=order, kind="release").exists()
    assert_ledger_balanced(product)


def test_expiry_rechecks_the_deadline_under_the_lock():
    order = create_order((stocked_product(on_hand=10), 1), now=NOW)

    assert services.expire_order(order.pk, now=NOW + timedelta(minutes=29)) is False
    assert Order.objects.get(pk=order.pk).status == Order.Status.PENDING_PAYMENT


def test_one_failing_order_does_not_stop_the_batch(monkeypatch):
    product = stocked_product(on_hand=10)
    broken = create_order((product, 1), now=NOW - timedelta(hours=2))
    healthy = create_order((product, 1), now=NOW - timedelta(hours=1))
    original = services.expire_order

    def flaky_expire(order_id, *, now):
        if order_id == broken.pk:
            raise RuntimeError("boom")
        return original(order_id, now=now)

    monkeypatch.setattr(services, "expire_order", flaky_expire)

    assert services.expire_due_orders(now=NOW) == 1
    assert Order.objects.get(pk=healthy.pk).status == Order.Status.EXPIRED
    assert Order.objects.get(pk=broken.pk).status == Order.Status.PENDING_PAYMENT


def test_expiry_processes_at_most_one_batch():
    product = stocked_product(on_hand=10)
    for minutes in (90, 80, 70):
        create_order((product, 1), now=NOW - timedelta(minutes=minutes))

    assert services.expire_due_orders(now=NOW, batch_size=2) == 2
    assert Order.objects.filter(status=Order.Status.PENDING_PAYMENT).count() == 1


def test_expiry_task_uses_the_current_time(clock):
    order = create_order((stocked_product(on_hand=10), 1), now=NOW)
    clock.advance(minutes=30)

    assert tasks.expire_reservations() == 1
    assert Order.objects.get(pk=order.pk).status == Order.Status.EXPIRED
