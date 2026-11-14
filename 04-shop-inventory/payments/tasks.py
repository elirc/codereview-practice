import uuid

import structlog
from celery import shared_task

from core import clock

from .services import events, refunds

logger = structlog.get_logger(__name__)


@shared_task(bind=True, name="payments.submit_refund", max_retries=5)
def submit_refund(self, refund_id: str) -> None:
    log = logger.bind(
        task_id=self.request.id,
        refund_id=refund_id,
        attempt=self.request.retries + 1,
    )
    log.info("submit_refund_started")
    try:
        retry = refunds.submit_refund(
            uuid.UUID(refund_id),
            retries=self.request.retries,
            max_retries=self.max_retries,
            now=clock.now(),
        )
    except Exception:
        log.exception("submit_refund_failed")
        raise
    if retry is not None:
        log.warning("submit_refund_retrying", countdown=retry.countdown, error=str(retry.error))
        raise self.retry(exc=retry.error, countdown=retry.countdown)
    log.info("submit_refund_finished")


@shared_task(bind=True, name="payments.process_webhook_event", max_retries=6)
def process_webhook_event(self, event_id: str) -> None:
    log = logger.bind(
        task_id=self.request.id,
        event_id=event_id,
        attempt=self.request.retries + 1,
    )
    log.info("webhook_event_processing_started")
    retry = events.run_processing_attempt(
        uuid.UUID(event_id),
        retries=self.request.retries,
        max_retries=self.max_retries,
        now=clock.now(),
    )
    if retry is not None:
        log.warning("webhook_event_retrying", countdown=retry.countdown, error=str(retry.error))
        raise self.retry(exc=retry.error, countdown=retry.countdown)
    log.info("webhook_event_processing_finished")
