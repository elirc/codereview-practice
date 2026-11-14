import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models import AuditEvent, Currency, User

NOW = datetime(2026, 3, 16, 9, 0, tzinfo=UTC)


def _insert_audit_event(db: Session) -> int:
    user = User(
        email="auditor@example.com",
        password_hash="x",
        full_name="Auditor",
        role="admin",
        approval_limit_minor=0,
        active=True,
        created_at=NOW,
        updated_at=NOW,
    )
    db.add(user)
    db.flush()
    event = AuditEvent(
        at=NOW,
        actor_id=user.id,
        request_id="req-1",
        entity_type="user",
        entity_id=user.id,
        action="user.updated",
        before={"role": "employee"},
        after={"role": "admin"},
    )
    db.add(event)
    db.commit()
    return event.id


def test_currencies_are_seeded_with_exponents(db: Session) -> None:
    rows = {c.code: c.exponent for c in db.scalars(select(Currency))}

    assert rows == {"USD": 2, "EUR": 2, "GBP": 2, "CAD": 2, "JPY": 0, "KWD": 3}


def test_audit_events_reject_update(db: Session) -> None:
    event_id = _insert_audit_event(db)

    with pytest.raises(DBAPIError):
        db.execute(
            text("UPDATE audit_events SET action = 'tampered' WHERE id = :id"), {"id": event_id}
        )
    db.rollback()

    assert db.get(AuditEvent, event_id) is not None
    assert db.scalar(select(AuditEvent.action).where(AuditEvent.id == event_id)) == "user.updated"


def test_audit_events_reject_delete(db: Session) -> None:
    event_id = _insert_audit_event(db)

    with pytest.raises(DBAPIError):
        db.execute(text("DELETE FROM audit_events WHERE id = :id"), {"id": event_id})
    db.rollback()

    assert db.scalar(select(AuditEvent.id).where(AuditEvent.id == event_id)) == event_id


def test_user_cannot_be_their_own_manager(db: Session) -> None:
    user_id = uuid.uuid4()
    db.add(
        User(
            id=user_id,
            email="self@example.com",
            password_hash="x",
            full_name="Self",
            role="manager",
            manager_id=user_id,
            approval_limit_minor=0,
            active=True,
            created_at=NOW,
            updated_at=NOW,
        )
    )

    with pytest.raises(DBAPIError):
        db.commit()
    db.rollback()
