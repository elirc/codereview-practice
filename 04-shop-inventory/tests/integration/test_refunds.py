import pytest

from orders.models import Order
from payments import tasks
from payments.models import Refund
from payments.provider import ProviderPermanentError, ProviderTransientError
from payments.services import refunds
from tests.factories import stocked_product
from tests.helpers import NOW, create_order, pay

pytestmark = pytest.mark.django_db


@pytest.fixture
def paid_order() -> Order:
    mug = stocked_product(on_hand=10, sku="MUG-01", price_minor=1200)
    tea = stocked_product(on_hand=10, sku="TEA-01", price_minor=450)
    return pay(create_order((mug, 3), (tea, 2)))


def line_of(order: Order, sku: str):
    return order.lines.get(sku=sku)


def post_refund(client, order: Order, body: dict, key: str = "refund-key-1"):
    return client.post(
        f"/api/orders/{order.number}/refunds/",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )


def test_line_refund_is_created_pending_and_submitted_after_commit(
    manager_client,
    paid_order,
    published,
    django_capture_on_commit_callbacks,
):
    mug = line_of(paid_order, "MUG-01")

    with django_capture_on_commit_callbacks(execute=True):
        response = post_refund(
            manager_client,
            paid_order,
            {
                "lines": [{"order_line_id": str(mug.id), "quantity": 2, "restock": True}],
                "reason": "damaged in transit",
            },
        )

    assert response.status_code == 202
    body = response.json()
    assert (body["status"], body["amount_minor"], body["source"]) == ("pending", 2400, "staff")
    assert body["lines"] == [
        {"order_line_id": str(mug.id), "sku": "MUG-01", "quantity": 2, "restock": True},
    ]
    assert published == [("payments.submit_refund", (body["id"],))]
    mug.refresh_from_db()
    assert mug.refunded_quantity == 0


def test_goodwill_refund_has_no_lines(manager_client, paid_order):
    response = post_refund(manager_client, paid_order, {"amount_minor": 300, "reason": "late"})

    assert response.status_code == 202
    assert response.json()["lines"] == []
    assert Refund.objects.get().amount_minor == 300


def test_refunds_cannot_exceed_the_amount_paid(manager_client, paid_order):
    first = post_refund(manager_client, paid_order, {"amount_minor": 4000, "reason": "a"}, "k-0001")
    second = post_refund(manager_client, paid_order, {"amount_minor": 501, "reason": "b"}, "k-0002")

    assert first.status_code == 202
    assert second.status_code == 422
    assert second.json()["error"]["code"] == "exceeds_refundable"
    assert second.json()["error"]["details"] == {"refundable_minor": 500}


def test_pending_refund_quantities_limit_further_line_refunds(manager_client, paid_order):
    mug_id = str(line_of(paid_order, "MUG-01").id)

    def refund_mugs(quantity: int, key: str):
        body = {
            "lines": [{"order_line_id": mug_id, "quantity": quantity, "restock": False}],
            "reason": "faulty",
        }
        return post_refund(manager_client, paid_order, body, key)

    assert refund_mugs(2, "key-0001").status_code == 202
    too_many = refund_mugs(2, "key-0002")
    assert too_many.status_code == 422
    assert too_many.json()["error"]["code"] == "exceeds_refundable_quantity"
    assert refund_mugs(1, "key-0003").status_code == 202


def test_failed_refund_frees_its_amount_and_quantities(manager_client, paid_order):
    mug_id = str(line_of(paid_order, "MUG-01").id)
    body = {
        "lines": [{"order_line_id": mug_id, "quantity": 3, "restock": False}],
        "reason": "faulty",
    }
    first = post_refund(manager_client, paid_order, body, "key-0001")
    refunds.fail_refund(first.json()["id"], reason="card closed")

    retry = post_refund(manager_client, paid_order, body, "key-0002")

    assert retry.status_code == 202
    assert Refund.objects.filter(status=Refund.Status.PENDING).count() == 1


def test_clerk_refund_exactly_at_the_limit_is_allowed(clerk_client, settings):
    settings.CLERK_REFUND_LIMIT_MINOR = 5000
    order = pay(create_order((stocked_product(on_hand=5, price_minor=6000), 1)))

    response = post_refund(clerk_client, order, {"amount_minor": 5000, "reason": "goodwill"})

    assert response.status_code == 202


def test_clerk_refund_over_the_limit_is_forbidden(clerk_client, settings):
    settings.CLERK_REFUND_LIMIT_MINOR = 5000
    order = pay(create_order((stocked_product(on_hand=5, price_minor=6000), 1)))

    response = post_refund(clerk_client, order, {"amount_minor": 5001, "reason": "goodwill"})

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "refund_limit_exceeded"
    assert not Refund.objects.exists()


def test_manager_is_not_bound_by_the_clerk_limit(manager_client, settings):
    settings.CLERK_REFUND_LIMIT_MINOR = 5000
    order = pay(create_order((stocked_product(on_hand=5, price_minor=6000), 1)))

    response = post_refund(manager_client, order, {"amount_minor": 6000, "reason": "goodwill"})

    assert response.status_code == 202


def test_unpaid_order_cannot_be_refunded(manager_client):
    order = create_order((stocked_product(on_hand=5), 1))

    response = post_refund(manager_client, order, {"amount_minor": 100, "reason": "x"})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "invalid_state"


def test_line_from_another_order_is_rejected(manager_client, paid_order):
    other = pay(create_order((stocked_product(on_hand=5), 1)))
    foreign_line = str(other.lines.get().id)

    response = post_refund(
        manager_client,
        paid_order,
        {
            "lines": [{"order_line_id": foreign_line, "quantity": 1, "restock": False}],
            "reason": "x",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_line"


@pytest.mark.parametrize(
    "body",
    [
        {"reason": "neither"},
        {"amount_minor": 100, "lines": [], "reason": "both"},
        {"amount_minor": 0, "reason": "zero"},
        {"amount_minor": 100},
    ],
)
def test_refund_body_must_have_exactly_one_kind_and_a_reason(manager_client, paid_order, body):
    response = post_refund(manager_client, paid_order, body)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


def test_duplicate_order_line_in_one_refund_is_rejected(manager_client, paid_order):
    mug_id = str(line_of(paid_order, "MUG-01").id)
    line = {"order_line_id": mug_id, "quantity": 1, "restock": False}

    response = post_refund(manager_client, paid_order, {"lines": [line, line], "reason": "x"})

    assert response.status_code == 400


def test_refund_creation_is_idempotent(manager_client, paid_order):
    body = {"amount_minor": 300, "reason": "late"}

    first = post_refund(manager_client, paid_order, body)
    second = post_refund(manager_client, paid_order, body)
    changed = post_refund(manager_client, paid_order, {**body, "amount_minor": 301})

    assert second.status_code == 202
    assert second.json() == first.json()
    assert changed.status_code == 422
    assert changed.json()["error"]["code"] == "idempotency_key_reused"
    assert Refund.objects.count() == 1


def test_reusing_a_refund_key_on_another_order_is_rejected(manager_client, paid_order):
    other = pay(create_order((stocked_product(on_hand=5), 1)))
    body = {"amount_minor": 300, "reason": "late"}

    post_refund(manager_client, paid_order, body)
    response = post_refund(manager_client, other, body)

    assert response.status_code == 422
    assert Refund.objects.count() == 1


def test_refund_requires_an_idempotency_key(manager_client, paid_order):
    response = manager_client.post(
        f"/api/orders/{paid_order.number}/refunds/",
        {"amount_minor": 300, "reason": "late"},
        format="json",
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "idempotency_key_required"


def test_refunds_are_listed_for_staff_only(clerk_client, anon_client, paid_order):
    refund = Refund.objects.create(
        order=paid_order,
        amount_minor=100,
        reason="x",
        source=Refund.Source.STAFF,
    )

    listed = clerk_client.get(f"/api/orders/{paid_order.number}/refunds/")

    assert [row["id"] for row in listed.json()["results"]] == [str(refund.id)]
    assert anon_client.get(f"/api/orders/{paid_order.number}/refunds/").status_code == 401
    created = post_refund(anon_client, paid_order, {"amount_minor": 1, "reason": "x"})
    assert created.status_code == 401


def _pending_refund(order: Order, amount: int = 1000) -> Refund:
    return Refund.objects.create(
        order=order,
        amount_minor=amount,
        reason="faulty",
        source=Refund.Source.STAFF,
    )


def test_submit_refund_sends_the_refund_id_as_idempotency_key(paid_order, provider):
    refund = _pending_refund(paid_order)

    assert refunds.submit_refund(refund.id, retries=0, max_retries=5, now=NOW) is None

    refund.refresh_from_db()
    assert refund.status == Refund.Status.PENDING
    assert refund.provider_refund_id == provider.refunds[str(refund.id)].id
    assert provider.calls[-1] == (
        "create_refund",
        {
            "payment_intent_id": paid_order.payment_intent_id,
            "amount_minor": 1000,
            "idempotency_key": str(refund.id),
        },
    )


def test_transient_provider_error_asks_for_a_retry_with_backoff(paid_order, provider):
    refund = _pending_refund(paid_order)
    provider.fail_next_refund(ProviderTransientError("timeout"))

    retry = refunds.submit_refund(refund.id, retries=2, max_retries=5, now=NOW)

    assert retry is not None
    assert retry.countdown == 20
    refund.refresh_from_db()
    assert (refund.status, refund.provider_refund_id) == (Refund.Status.PENDING, "")


def test_retry_after_a_lost_response_reuses_the_provider_refund(paid_order, provider):
    refund = _pending_refund(paid_order)
    provider.fail_next_refund(ProviderTransientError("read timeout"), after_create=True)

    assert refunds.submit_refund(refund.id, retries=0, max_retries=5, now=NOW) is not None
    assert refunds.submit_refund(refund.id, retries=1, max_retries=5, now=NOW) is None

    refund.refresh_from_db()
    assert len(provider.refunds) == 1
    assert refund.provider_refund_id == provider.refunds[str(refund.id)].id
    keys = {call[1]["idempotency_key"] for call in provider.calls if call[0] == "create_refund"}
    assert keys == {str(refund.id)}


def test_permanent_provider_error_fails_the_refund(paid_order, provider):
    refund = _pending_refund(paid_order)
    provider.fail_next_refund(ProviderPermanentError("charge already refunded"))

    assert refunds.submit_refund(refund.id, retries=0, max_retries=5, now=NOW) is None

    refund.refresh_from_db()
    assert refund.status == Refund.Status.FAILED
    assert "charge already refunded" in refund.failure_reason


def test_exhausted_retries_fail_the_refund(paid_order, provider):
    refund = _pending_refund(paid_order)
    provider.fail_next_refund(ProviderTransientError("timeout"))

    assert refunds.submit_refund(refund.id, retries=5, max_retries=5, now=NOW) is None

    refund.refresh_from_db()
    assert refund.status == Refund.Status.FAILED


@pytest.mark.parametrize("state", ["succeeded", "failed", "submitted"])
def test_submit_refund_skips_refunds_that_need_no_submission(paid_order, provider, state):
    refund = _pending_refund(paid_order)
    if state == "submitted":
        Refund.objects.filter(pk=refund.pk).update(provider_refund_id="re_existing")
    else:
        Refund.objects.filter(pk=refund.pk).update(status=state)

    assert refunds.submit_refund(refund.id, retries=0, max_retries=5, now=NOW) is None
    assert provider.calls[-1][0] != "create_refund"


def test_submit_refund_task_reraises_transient_errors_when_called_directly(paid_order, provider):
    refund = _pending_refund(paid_order)
    provider.fail_next_refund(ProviderTransientError("timeout"))

    with pytest.raises(ProviderTransientError):
        tasks.submit_refund(str(refund.id))

    assert Refund.objects.get(pk=refund.pk).status == Refund.Status.PENDING


def test_percentage_refund_is_created_for_a_share_of_the_amount_paid(manager_client, paid_order):
    response = post_refund(manager_client, paid_order, {"percent": "20", "reason": "late delivery"})

    assert response.status_code == 202
    assert response.json()["amount_minor"] == 900


def test_refund_quote_previews_a_percentage_refund(clerk_client, paid_order):
    Refund.objects.create(
        order=paid_order,
        amount_minor=500,
        reason="dent",
        source=Refund.Source.STAFF,
    )

    response = clerk_client.get(f"/api/orders/{paid_order.number}/refunds/quote/?percent=10")

    assert response.status_code == 200
    assert response.json() == {"amount_minor": 450, "refundable_minor": 4000, "currency": "USD"}
    assert Refund.objects.count() == 1
