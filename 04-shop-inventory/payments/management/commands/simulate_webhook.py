import json
import secrets
import urllib.error
import urllib.request

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core import clock
from orders.models import Order
from payments.signature import build_header

DEFAULT_URL = "http://localhost:8000/webhooks/payments/"


class Command(BaseCommand):
    help = "Build, sign and post a provider event for an order. Development only."

    def add_arguments(self, parser) -> None:
        parser.add_argument("type", help="Event type, for example payment.succeeded")
        parser.add_argument("order_number", help="Order number, for example SO-000001")
        parser.add_argument("--event-id", help="Provider event id (random when omitted)")
        parser.add_argument("--created", type=int, help="Event creation time in unix seconds")
        parser.add_argument("--amount", type=int, help="Amount in minor units")
        parser.add_argument("--currency", help="Currency code (defaults to the order's)")
        parser.add_argument("--refund-id", help="Provider refund id")
        parser.add_argument("--refund-reference", help="Our refund id echoed by the provider")
        parser.add_argument("--failure-reason", help="Failure reason for *.failed events")
        parser.add_argument("--url", default=DEFAULT_URL, help="Webhook endpoint to post to")

    def handle(self, *args, **options) -> None:
        if not settings.DEBUG:
            raise CommandError("simulate_webhook only runs with DJANGO_DEBUG enabled.")
        order = Order.objects.filter(number=options["order_number"]).first()
        if order is None:
            raise CommandError(f"Order {options['order_number']} does not exist.")
        if not order.payment_intent_id:
            raise CommandError(f"Order {order.number} has no payment intent.")

        now = int(clock.now().timestamp())
        data = {
            "payment_intent_id": order.payment_intent_id,
            "amount_minor": order.total_minor if options["amount"] is None else options["amount"],
            "currency": options["currency"] or order.currency,
        }
        for field in ("refund_id", "refund_reference", "failure_reason"):
            if options[field]:
                data[field] = options[field]
        payload = {
            "id": options["event_id"] or f"evt_{secrets.token_hex(12)}",
            "type": options["type"],
            "created": now if options["created"] is None else options["created"],
            "data": data,
        }
        body = json.dumps(payload).encode()
        request = urllib.request.Request(
            options["url"],
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Pay-Signature": build_header(settings.PAYMENT_WEBHOOK_SECRET, now, body),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status, text = response.status, response.read().decode()
        except urllib.error.HTTPError as exc:
            status, text = exc.code, exc.read().decode()
        except urllib.error.URLError as exc:
            raise CommandError(f"Could not reach {options['url']}: {exc.reason}") from exc
        self.stdout.write(f"{payload['id']} {payload['type']} -> {status} {text}")
