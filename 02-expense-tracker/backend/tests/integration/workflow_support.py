from dataclasses import dataclass
from datetime import date
from typing import Any

import httpx
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import ExchangeRate, User
from tests.integration.factories import add_line, create_rate, create_user, new_report

Json = dict[str, Any]


@dataclass(frozen=True)
class Org:
    """A small reporting line: employee -> lead -> director, plus finance and admin."""

    admin: User
    finance: User
    finance2: User
    director: User
    lead: User
    employee: User


def build_org(db: Session) -> Org:
    admin = create_user(db, role="admin", name="Ada Admin")
    finance = create_user(db, role="finance", name="Fay Finance")
    finance2 = create_user(db, role="finance", name="Fred Finance")
    director = create_user(db, role="manager", limit=1_000_000, name="Dana Director")
    lead = create_user(db, role="manager", manager=director, limit=10_000, name="Leo Lead")
    employee = create_user(db, manager=lead, name="Emma Employee")
    return Org(admin, finance, finance2, director, lead, employee)


def seed_rate(db: Session, org: Org, currency: str, effective: str, rate: str) -> ExchangeRate:
    return create_rate(
        db,
        currency=currency,
        effective=date.fromisoformat(effective),
        rate=rate,
        created_by=org.finance,
    )


def draft(client: TestClient, *amounts: int, currency: str = "USD") -> Json:
    report = new_report(client)
    for index, amount in enumerate(amounts):
        report = add_line(
            client, report, amount_minor=amount, currency=currency, description=f"Item {index}"
        )
    return report


def act(client: TestClient, report: Json, action: str, **body: Any) -> httpx.Response:
    payload = {"expected_version": report["version"], **body}
    return client.post(f"/api/reports/{report['id']}/{action}", json=payload)


def decide(
    client: TestClient, report: Json, verb: str, step_id: str | None = None, **body: Any
) -> httpx.Response:
    target = step_id or report["current_step_id"]
    payload = {"expected_version": report["version"], **body}
    return client.post(f"/api/reports/{report['id']}/steps/{target}/{verb}", json=payload)


def ok(response: httpx.Response) -> Json:
    assert response.status_code == 200, response.text
    body: Json = response.json()
    return body


def submitted(client: TestClient, report: Json) -> Json:
    return ok(act(client, report, "submit"))


def round_steps(report: Json, round_number: int | None = None) -> list[Json]:
    wanted = report["round"] if round_number is None else round_number
    return [s for s in report["steps"] if s["round"] == wanted]


def error_code(response: httpx.Response) -> str:
    code: str = response.json()["error"]["code"]
    return code
