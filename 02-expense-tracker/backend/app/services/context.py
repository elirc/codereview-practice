from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.models import User


@dataclass(frozen=True)
class ServiceContext:
    """Everything a service needs to act on behalf of the caller within one request."""

    db: Session
    actor: User
    request_id: str
    now: datetime
    base_currency: str
