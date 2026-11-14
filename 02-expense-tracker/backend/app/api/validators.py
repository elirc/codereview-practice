from datetime import UTC, date, datetime, timedelta

from sqlalchemy.orm import Session

from app.domain.errors import InvalidInput
from app.models import Currency


def ensure_expense_date_allowed(expense_date: date | None, now: datetime) -> None:
    """Expense dates may be at most one day after today's UTC date."""
    if expense_date is None:
        return
    latest = now.astimezone(UTC).date() + timedelta(days=1)
    if expense_date > latest:
        raise InvalidInput.field("expense_date", "The expense date cannot be in the future.")


def ensure_known_currency(db: Session, code: str | None, path: str = "currency") -> None:
    if code is not None and db.get(Currency, code) is None:
        raise InvalidInput.field(path, "Unknown currency.")
