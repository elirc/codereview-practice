import uuid
from datetime import date, timedelta
from decimal import Decimal
from functools import lru_cache
from itertools import count
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import hash_password, hash_session_token, new_session_token
from app.models import ExchangeRate, User, UserSession
from tests.conftest import START_OF_TEST_TIME

PASSWORD = "correct horse battery staple"
_sequence = count(1)


@lru_cache(maxsize=1)
def password_hash() -> str:
    return hash_password(PASSWORD)


def create_user(
    db: Session,
    *,
    role: str = "employee",
    manager: User | None = None,
    limit: int = 0,
    active: bool = True,
    name: str | None = None,
    email: str | None = None,
) -> User:
    n = next(_sequence)
    user = User(
        id=uuid.uuid4(),
        email=email or f"user{n}@example.com",
        password_hash=password_hash(),
        full_name=name or f"{role.title()} {n}",
        role=role,
        manager_id=manager.id if manager else None,
        approval_limit_minor=limit,
        active=active,
        created_at=START_OF_TEST_TIME,
        updated_at=START_OF_TEST_TIME,
    )
    db.add(user)
    db.commit()
    return user


def create_rate(
    db: Session, *, currency: str, effective: date, rate: str, created_by: User
) -> ExchangeRate:
    row = ExchangeRate(
        id=uuid.uuid4(),
        from_currency=currency,
        effective_date=effective,
        rate=Decimal(rate),
        created_by=created_by.id,
        created_at=START_OF_TEST_TIME,
        updated_at=START_OF_TEST_TIME,
    )
    db.add(row)
    db.commit()
    return row


def new_report(client: TestClient, title: str = "Client visit") -> dict[str, Any]:
    response = client.post("/api/reports", json={"title": title})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def add_line(
    client: TestClient,
    report: dict[str, Any],
    *,
    amount_minor: int = 1500,
    currency: str = "USD",
    expense_date: str = "2026-03-10",
    category: str = "meals",
    description: str = "Lunch with client",
    **extra: Any,
) -> dict[str, Any]:
    response = client.post(
        f"/api/reports/{report['id']}/lines",
        json={
            "expected_version": report["version"],
            "expense_date": expense_date,
            "category": category,
            "description": description,
            "amount_minor": amount_minor,
            "currency": currency,
            **extra,
        },
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def api_client(app: FastAPI) -> TestClient:
    return TestClient(app, headers={"X-Requested-With": "fetch"})


def signed_in_client(app: FastAPI, db: Session, user: User) -> TestClient:
    token = new_session_token()
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=hash_session_token(token),
            created_at=START_OF_TEST_TIME,
            expires_at=START_OF_TEST_TIME + timedelta(days=365),
        )
    )
    db.commit()
    client = api_client(app)
    client.cookies.set("et_session", token)
    return client
