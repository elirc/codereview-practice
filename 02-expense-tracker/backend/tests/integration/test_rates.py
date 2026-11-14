from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditEvent, User
from tests.integration.factories import create_user

ClientFor = Callable[[User], TestClient]


def test_finance_creates_lists_and_updates_rates(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db, role="finance"))

    created = client.post(
        "/api/exchange-rates",
        json={"from_currency": "EUR", "effective_date": "2026-03-01", "rate": "1.0825"},
    )
    rate_id = created.json()["id"]
    updated = client.patch(f"/api/exchange-rates/{rate_id}", json={"rate": "1.0900"})
    listing = client.get("/api/exchange-rates", params={"from_currency": "EUR"}).json()

    assert created.status_code == 201
    assert created.json()["rate"] == "1.0825"
    assert updated.status_code == 200
    assert updated.json()["rate"] == "1.09"
    assert [(r["rate"], r["in_use"]) for r in listing["items"]] == [("1.09", False)]
    events = db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all()
    assert [e.action for e in events] == ["rate.created", "rate.updated"]
    assert events[1].before == {"rate": "1.0825"}
    assert events[1].after == {"rate": "1.09"}


def test_admin_may_manage_rates_but_employee_and_manager_may_not(
    db: Session, client_for: ClientFor
) -> None:
    body = {"from_currency": "GBP", "effective_date": "2026-03-01", "rate": "1.27"}

    assert client_for(create_user(db)).post("/api/exchange-rates", json=body).status_code == 403
    manager = client_for(create_user(db, role="manager"))
    assert manager.post("/api/exchange-rates", json=body).status_code == 403
    assert manager.get("/api/exchange-rates").status_code == 403
    admin = client_for(create_user(db, role="admin"))
    assert admin.post("/api/exchange-rates", json=body).status_code == 201


def test_duplicate_currency_and_date_is_conflict(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db, role="finance"))
    body = {"from_currency": "CAD", "effective_date": "2026-03-01", "rate": "0.74"}

    first = client.post("/api/exchange-rates", json=body)
    second = client.post("/api/exchange-rates", json={**body, "rate": "0.75"})

    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "rate_exists"


def test_rates_must_be_positive_decimal_strings(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db, role="finance"))
    base = {"from_currency": "EUR", "effective_date": "2026-03-01"}

    as_number = client.post("/api/exchange-rates", json={**base, "rate": 1.08})
    zero = client.post("/api/exchange-rates", json={**base, "rate": "0"})
    too_precise = client.post("/api/exchange-rates", json={**base, "rate": "1.00000000001"})
    base_currency = client.post(
        "/api/exchange-rates",
        json={"from_currency": "USD", "effective_date": "2026-03-01", "rate": "1"},
    )
    unknown = client.post(
        "/api/exchange-rates",
        json={"from_currency": "CHF", "effective_date": "2026-03-01", "rate": "1.1"},
    )

    for response in (as_number, zero, too_precise, base_currency, unknown):
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "validation_failed"


def test_currencies_are_listed_with_exponents(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))

    body = client.get("/api/currencies").json()

    assert {"code": "KWD", "exponent": 3} in body
    assert {"code": "JPY", "exponent": 0} in body
