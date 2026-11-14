import structlog
from celery import shared_task

from core import clock

from . import services

logger = structlog.get_logger(__name__)


@shared_task(bind=True, name="orders.expire_reservations")
def expire_reservations(self) -> int:
    log = logger.bind(task_id=self.request.id, attempt=self.request.retries + 1)
    log.info("expire_reservations_started")
    try:
        expired = services.expire_due_orders(now=clock.now())
    except Exception:
        log.exception("expire_reservations_failed")
        raise
    log.info("expire_reservations_finished", expired=expired)
    return expired
