import json

import pytest
from django.test import Client

from core import jobs
from core.jobs import publish as real_publish
from orders.models import Order
from payments.models import WebhookEvent
from payments.services import events
from payments.signature import build_header
from tests.factories import stocked_product
from tests.helpers import NOW, create_order, event_payload

pytestmark = pytest.mark.django_db

SECRET = "whsec_test_current_secret"
PREVIOUS = "whsec_test_previous_secret"
TIMESTAMP = int(NOW.timestamp())
PROCESS = "payments.process_webhook_event"


@pytest.fixture(autouse=True)
def webhook_secrets(settings):
    settings.PAYMENT_WEBHOOK_SECRET = SECRET
    settings.PAYMENT_WEBHOOK_SECRET_PREVIOUS = PREVIOUS


@pytest.fixture
def order():
    return create_order((stocked_product(on_hand=5), 2))


def deliver(body: bytes, header: str | None):
    extra = {} if header is None else {"HTTP_X_PAY_SIGNATURE": header}
    return Client().post("/webhooks/payments/", body, content_type="application/json", **extra)


def signed(payload: dict, *, secret: str = SECRET, timestamp: int = TIMESTAMP):
    body = json.dumps(payload).encode()
    return body, build_header(secret, timestamp, body)


def test_valid_delivery_is_stored_and_queued_after_commit(
    order,
    published,
    django_capture_on_commit_callbacks,
):
    payload = event_payload("payment.succeeded", order, event_id="evt_1")

    with django_capture_on_commit_callbacks(execute=True):
        response = deliver(*signed(payload))

    assert response.status_code == 200
    assert response.json() == {"status": "accepted"}
    event = WebhookEvent.objects.get()
    assert (event.provider_event_id, event.type, event.status) == (
        "evt_1",
        "payment.succeeded",
        "received",
    )
    assert event.payload == payload
    assert event.provider_created_at == NOW
    assert event.received_at == NOW
    assert published == [(PROCESS, (str(event.id),))]
    assert Order.objects.get(pk=order.pk).status == Order.Status.PENDING_PAYMENT


def test_delivery_signed_with_the_previous_secret_is_accepted(order):
    response = deliver(*signed(event_payload("payment.succeeded", order), secret=PREVIOUS))

    assert response.status_code == 200


@pytest.mark.parametrize(
    "make_header",
    [
        lambda body: None,
        lambda body: f"t={TIMESTAMP}",
        lambda body: "nonsense",
        lambda body: build_header("whsec_wrong_secret_value", TIMESTAMP, body),
        lambda body: build_header(SECRET, TIMESTAMP - 301, body),
    ],
    ids=["missing", "no-signature", "garbage", "wrong-secret", "too-old"],
)
def test_signature_rejections_store_nothing(order, make_header):
    body = json.dumps(event_payload("payment.succeeded", order)).encode()

    response = deliver(body, make_header(body))

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_signature"
    assert not WebhookEvent.objects.exists()


def test_timestamp_exactly_at_the_tolerance_is_accepted(order):
    payload = event_payload("payment.succeeded", order)

    response = deliver(*signed(payload, timestamp=TIMESTAMP - 300))

    assert response.status_code == 200


def test_signature_over_reformatted_json_is_rejected(order):
    payload = event_payload("payment.succeeded", order)
    compact = json.dumps(payload, separators=(",", ":")).encode()
    spaced = json.dumps(payload, indent=2).encode()

    response = deliver(spaced, build_header(SECRET, TIMESTAMP, compact))

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_signature"
    assert not WebhookEvent.objects.exists()


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[1, 2, 3]",
        b'{"id": "evt_1", "type": "payment.succeeded", "created": 1772452800}',
        b'{"id": "evt_1", "type": "payment.succeeded", "created": "soon", "data": {}}',
        b'{"id": "evt_1", "type": "payment.succeeded", "created": 1772452800, "data": []}',
        b'{"type": "payment.succeeded", "created": 1772452800, "data": {}}',
        b'{"id": "evt_1", "type": "x", "created": 1772452800, "data": {"amount": NaN}}',
        b"\xff\xfe\x00",
    ],
)
def test_payload_rejections_store_nothing(published, body):
    response = deliver(body, build_header(SECRET, TIMESTAMP, body))

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_payload"
    assert not WebhookEvent.objects.exists()
    assert published == []


def test_duplicate_delivery_is_acknowledged_and_requeued_while_unprocessed(
    order,
    published,
    django_capture_on_commit_callbacks,
):
    delivery = signed(event_payload("payment.succeeded", order, event_id="evt_1"))

    with django_capture_on_commit_callbacks(execute=True):
        first = deliver(*delivery)
        second = deliver(*delivery)

    assert first.json() == {"status": "accepted"}
    assert second.status_code == 200
    assert second.json() == {"status": "duplicate"}
    event = WebhookEvent.objects.get()
    assert published == [(PROCESS, (str(event.id),)), (PROCESS, (str(event.id),))]


def test_redelivery_after_processing_enqueues_nothing(
    order,
    published,
    django_capture_on_commit_callbacks,
):
    delivery = signed(event_payload("payment.succeeded", order, event_id="evt_1"))
    deliver(*delivery)
    events.process_event(WebhookEvent.objects.get().pk, now=NOW)
    published.clear()

    with django_capture_on_commit_callbacks(execute=True):
        response = deliver(*delivery)

    assert response.json() == {"status": "duplicate"}
    assert published == []
    assert WebhookEvent.objects.count() == 1


def test_redelivery_of_a_failed_event_requeues_it(
    order,
    published,
    django_capture_on_commit_callbacks,
):
    delivery = signed(event_payload("payment.succeeded", order, event_id="evt_1"))
    deliver(*delivery)
    WebhookEvent.objects.update(status=WebhookEvent.Status.FAILED)
    published.clear()

    with django_capture_on_commit_callbacks(execute=True):
        deliver(*delivery)

    assert published == [(PROCESS, (str(WebhookEvent.objects.get().id),))]


def test_unknown_event_type_is_stored_and_later_ignored(order):
    response = deliver(*signed(event_payload("charge.dispute.created", order)))

    assert response.json() == {"status": "accepted"}
    event = WebhookEvent.objects.get()
    assert events.process_event(event.pk, now=NOW) == WebhookEvent.Status.IGNORED


def test_unknown_payment_intent_still_gets_a_success_response(order):
    payload = event_payload("payment.succeeded", order, payment_intent_id="pi_unknown")

    response = deliver(*signed(payload))

    assert response.status_code == 200
    assert WebhookEvent.objects.get().status == WebhookEvent.Status.RECEIVED


def test_broker_outage_does_not_fail_the_delivery(
    order,
    monkeypatch,
    django_capture_on_commit_callbacks,
):
    def broker_down(*args, **kwargs):
        raise ConnectionError("broker unreachable")

    monkeypatch.setattr(jobs, "publish", real_publish)
    monkeypatch.setattr(jobs.celery_app, "send_task", broker_down)

    with django_capture_on_commit_callbacks(execute=True):
        response = deliver(*signed(event_payload("payment.succeeded", order)))

    assert response.status_code == 200
    assert WebhookEvent.objects.count() == 1


def test_endpoint_ignores_api_credentials(order):
    body, header = signed(event_payload("payment.succeeded", order))

    response = Client().post(
        "/webhooks/payments/",
        body,
        content_type="application/json",
        HTTP_X_PAY_SIGNATURE=header,
        HTTP_AUTHORIZATION="Token not-a-real-token",
    )

    assert response.status_code == 200
