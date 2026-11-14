import uuid

import structlog
from celery import shared_task

from core import clock

from .services import refunds

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
