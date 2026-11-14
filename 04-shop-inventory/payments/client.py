"""Calls to the payment provider made on behalf of the payments services."""

from dataclasses import dataclass
from datetime import datetime

import structlog
from django.conf import settings

from .provider import PaymentProvider, ProviderRefund, get_provider
from .signature import verify

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class RefundSubmission:
    refund_id: str
    payment_intent_id: str
    amount_minor: int
    attempt: int


class PaymentsClient:
    """Wraps the configured provider with the logging and keys our services rely on."""

    def __init__(self, provider: PaymentProvider | None = None):
        self._provider = provider or get_provider()

    def submit_refund(self, submission: RefundSubmission) -> ProviderRefund:
        key = self.refund_key(submission)
        logger.info(
            "provider_refund_requested",
            refund_id=submission.refund_id,
            attempt=submission.attempt,
            idempotency_key=key,
        )
        return self._provider.create_refund(
            submission.payment_intent_id,
            submission.amount_minor,
            idempotency_key=key,
        )

    @staticmethod
    def refund_key(submission: RefundSubmission) -> str:
        return f"{submission.refund_id}-{submission.attempt}"

    def verify_webhook(self, header: str | None, body: bytes, *, now: datetime) -> None:
        current = int(now.timestamp())
        signed_at = verify(
            header,
            body,
            secrets=[settings.PAYMENT_WEBHOOK_SECRET, settings.PAYMENT_WEBHOOK_SECRET_PREVIOUS],
            now=current,
        )
        logger.debug("webhook_signature_verified", skew_seconds=current - signed_at)
