from datetime import datetime

from django.utils import timezone


def now() -> datetime:
    """Current time in UTC. Views and tasks read it here and pass it into services."""
    return timezone.now()
