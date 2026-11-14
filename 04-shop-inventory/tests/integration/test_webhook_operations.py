import io
import json
from datetime import timedelta

import pytest
from django.contrib.auth.models import User
from django.core.management import CommandError, call_command

from payments import tasks
from payments.management.commands import simulate_webhook
from payments.models import Refund, WebhookEvent
from payments.services import webhooks
from payments.signature import verify
from tests.factories import stocked_product
from tests.helpers import NOW, create_order, pay, store_event

pytestmark = pytest.mark.django_db

PROCESS = "payments.process_webhook_event"


@pytest.fixture
def order():
    return create_order((stocked_product(on_hand=5), 1))


def test_staff_list_webhook_events_with_filters(clerk_client, order):
    failed = store_event("payment.succeeded", order, event_id="evt_failed")
    WebhookEvent.objects.filter(pk=failed.pk).update(status=WebhookEvent.Status.FAILED)
    store_event("payment.failed", order, event_id="evt_received")

    everything = clerk_client.get("/api/webhook-events/").json()
    by_status = clerk_client.get("/api/webhook-events/?status=failed").json()
    by_type = clerk_client.get("/api/webhook-events/?type=payment.failed").json()

    assert everything["count"] == 2
    assert [row["provider_event_id"] for row in by_status["results"]] == ["evt_failed"]
    assert [row["provider_event_id"] for row in by_type["results"]] == ["evt_received"]


def test_event_detail_shows_the_payload(clerk_client, order):
    event = store_event("payment.succeeded", order, event_id="evt_1")

    response = clerk_client.get(f"/api/webhook-events/{event.pk}/")

    assert response.status_code == 200
    assert response.json()["payload"]["id"] == "evt_1"
    assert "signature" not in json.dumps(response.json()).lower()


@pytest.mark.parametrize("event_id", ["not-a-uuid", "6f1c1f43-0000-4000-8000-000000000000"])
def test_unknown_event_is_not_found(clerk_client, event_id):
    response = clerk_client.get(f"/api/webhook-events/{event_id}/")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_anonymous_cannot_read_webhook_events(anon_client):
    assert anon_client.get("/api/webhook-events/").status_code == 401


def test_manager_retries_a_failed_event(
    manager_client,
    order,
    published,
    django_capture_on_commit_callbacks,
):
    event = store_event("payment.succeeded", order)
    WebhookEvent.objects.filter(pk=event.pk).update(status=WebhookEvent.Status.FAILED)

    with django_capture_on_commit_callbacks(execute=True):
        response = manager_client.post(f"/api/webhook-events/{event.pk}/retry/")

    assert response.status_code == 202
    assert published == [(PROCESS, (str(event.pk),))]


def test_only_failed_events_can_be_retried(manager_client, order):
    event = store_event("payment.succeeded", order)

    response = manager_client.post(f"/api/webhook-events/{event.pk}/retry/")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "invalid_state"


def test_clerk_cannot_retry_events(clerk_client, order):
    event = store_event("payment.succeeded", order)
    WebhookEvent.objects.filter(pk=event.pk).update(status=WebhookEvent.Status.FAILED)

    assert clerk_client.post(f"/api/webhook-events/{event.pk}/retry/").status_code == 403


def test_events_still_received_after_five_minutes_are_requeued(
    order,
    published,
    django_capture_on_commit_callbacks,
):
    old = store_event("payment.succeeded", order, received_at=NOW - timedelta(minutes=6))
    boundary = store_event("payment.failed", order, received_at=NOW - timedelta(minutes=5))
    store_event("payment.failed", order, received_at=NOW - timedelta(minutes=4))
    done = store_event("payment.failed", order, received_at=NOW - timedelta(hours=1))
    WebhookEvent.objects.filter(pk=done.pk).update(status=WebhookEvent.Status.PROCESSED)

    with django_capture_on_commit_callbacks(execute=True):
        assert webhooks.requeue_stale_events(now=NOW) == 2

    assert published == [(PROCESS, (str(old.pk),)), (PROCESS, (str(boundary.pk),))]


def test_requeue_task_uses_the_current_time(order, clock):
    store_event("payment.succeeded", order, received_at=NOW)
    clock.advance(minutes=5)

    assert tasks.requeue_stale_events() == 1


def _refund(order, **fields) -> Refund:
    refund = Refund.objects.create(
        order=order,
        amount_minor=100,
        reason="faulty",
        source=Refund.Source.STAFF,
    )
    Refund.objects.filter(pk=refund.pk).update(**fields)
    return refund


def test_unsubmitted_pending_refunds_are_published_again(
    order,
    published,
    django_capture_on_commit_callbacks,
):
    paid = pay(order)
    stale = _refund(paid, created_at=NOW - timedelta(minutes=5))
    _refund(paid, created_at=NOW - timedelta(minutes=4))
    _refund(paid, created_at=NOW - timedelta(hours=1), provider_refund_id="re_sent")
    _refund(paid, created_at=NOW - timedelta(hours=1), status=Refund.Status.FAILED)

    with django_capture_on_commit_callbacks(execute=True):
        assert tasks.requeue_stale_events() == 1

    assert published == [("payments.submit_refund", (str(stale.pk),))]


class FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def read(self) -> bytes:
        return b'{"status": "accepted"}'


def test_simulate_webhook_posts_a_correctly_signed_event(order, settings, monkeypatch):
    settings.DEBUG = True
    sent = []

    def fake_urlopen(request, timeout):
        sent.append(request)
        return FakeResponse()

    monkeypatch.setattr(simulate_webhook.urllib.request, "urlopen", fake_urlopen)
    output = io.StringIO()

    call_command(
        "simulate_webhook",
        "payment.succeeded",
        order.number,
        "--event-id",
        "evt_sim",
        stdout=output,
    )

    request = sent[0]
    payload = json.loads(request.data)
    assert payload["id"] == "evt_sim"
    assert payload["data"]["payment_intent_id"] == order.payment_intent_id
    assert payload["data"]["amount_minor"] == order.total_minor
    verify(
        request.get_header("X-pay-signature"),
        request.data,
        secrets=[settings.PAYMENT_WEBHOOK_SECRET],
        now=int(NOW.timestamp()),
    )
    assert "evt_sim payment.succeeded -> 200" in output.getvalue()


def test_simulate_webhook_refuses_to_run_outside_debug(order, settings):
    settings.DEBUG = False

    with pytest.raises(CommandError):
        call_command("simulate_webhook", "payment.succeeded", order.number)


def test_admin_pages_are_read_only(client, order):
    admin_user = User.objects.create_superuser("root", "root@shop.test", "root-password-123")
    client.force_login(admin_user)

    assert client.get("/admin/orders/order/").status_code == 200
    assert client.get(f"/admin/orders/order/{order.pk}/change/").status_code == 200
    assert client.get("/admin/orders/order/add/").status_code == 403
    assert client.get("/admin/payments/webhookevent/").status_code == 200
    assert client.get("/admin/inventory/stockmovement/").status_code == 200
    assert client.get("/admin/catalog/product/add/").status_code == 403


def test_unmatched_urls_use_the_error_envelope(anon_client):
    response = anon_client.get("/api/does-not-exist/")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
