"""Publishing Celery tasks once the surrounding transaction has committed."""

from dataclasses import dataclass

import structlog
from django.db import transaction

from config.celery import app as celery_app

logger = structlog.get_logger(__name__)

BACKOFF_BASE_SECONDS = 5
BACKOFF_CAP_SECONDS = 600


@dataclass(frozen=True)
class RetryLater:
    """Returned by job services when the task should be retried after ``countdown`` seconds."""

    countdown: int
    error: Exception


def enqueue_on_commit(task_name: str, *args: str) -> None:
    """Publish ``task_name`` after commit, or immediately when no transaction is open."""
    transaction.on_commit(lambda: publish(task_name, *args))


def publish(task_name: str, *args: str) -> None:
    try:
        celery_app.send_task(task_name, args=list(args))
    except Exception:
        # The work is already committed; a broker outage must not turn it into an error response.
        logger.exception("task_publish_failed", task=task_name, args=list(args))


def backoff_seconds(retries: int) -> int:
    """Exponential backoff for retry number ``retries`` (0-based), capped at ten minutes."""
    return min(BACKOFF_BASE_SECONDS * 2**retries, BACKOFF_CAP_SECONDS)
