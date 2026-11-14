import uuid
from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditEvent, ExpenseLine, Report, User
from tests.integration.factories import add_line, create_rate, create_user, new_report

ClientFor = Callable[[User], TestClient]


def test_owner_creates_and_reads_draft_report(db: Session, client_for: ClientFor) -> None:
    owner = create_user(db)
    client = client_for(owner)

    created = new_report(client, "  March travel  ")
    fetched = client.get(f"/api/reports/{created['id']}").json()

    assert created["title"] == "March travel"
    assert fetched["status"] == "draft"
    assert fetched["round"] == 0
    assert fetched["version"] == 1
    assert fetched["owner"]["id"] == str(owner.id)
    assert fetched["can"] == {
        "edit": True,
        "submit": True,
        "withdraw": False,
        "decide": False,
        "reopen": False,
        "reimburse": False,
    }
    actions = db.scalars(select(AuditEvent.action)).all()
    assert actions == ["report.created"]


def test_line_changes_bump_version_and_are_audited(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    report = new_report(client)

    with_line = add_line(client, report, amount_minor=1250)
    line_id = with_line["lines"][0]["id"]
    updated = client.patch(
        f"/api/reports/{report['id']}/lines/{line_id}",
        json={"expected_version": with_line["version"], "amount_minor": 1300},
    ).json()
    removed = client.delete(
        f"/api/reports/{report['id']}/lines/{line_id}",
        params={"expected_version": updated["version"]},
    ).json()

    assert [with_line["version"], updated["version"], removed["version"]] == [2, 3, 4]
    assert removed["lines"] == []
    events = db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all()
    assert [e.action for e in events] == [
        "report.created",
        "line.added",
        "line.updated",
        "line.removed",
    ]
    assert events[2].before == {"amount_minor": 1250}
    assert events[2].after == {"amount_minor": 1300}


def test_stale_version_on_line_edit_is_conflict_without_partial_write(
    db: Session, client_for: ClientFor
) -> None:
    client = client_for(create_user(db))
    report = new_report(client)
    first = add_line(client, report)
    add_line(client, first, description="Taxi")
    line_id = first["lines"][0]["id"]

    response = client.patch(
        f"/api/reports/{report['id']}/lines/{line_id}",
        json={"expected_version": first["version"], "amount_minor": 99_999},
    )

    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "version_conflict"
    assert error["details"] == {"current_version": 3}
    stored = db.get(ExpenseLine, uuid.UUID(line_id))
    assert stored is not None
    assert stored.amount_minor == 1500
    assert db.scalar(select(Report.version)) == 3


def test_title_update_requires_current_version(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    report = new_report(client)

    ok = client.patch(
        f"/api/reports/{report['id']}", json={"expected_version": 1, "title": "Renamed"}
    )
    stale = client.patch(
        f"/api/reports/{report['id']}", json={"expected_version": 1, "title": "Again"}
    )

    assert ok.status_code == 200
    assert ok.json()["title"] == "Renamed"
    assert stale.status_code == 409
    assert db.scalar(select(Report.title)) == "Renamed"


@pytest.mark.parametrize(
    ("override", "path"),
    [
        ({"amount_minor": 0}, "amount_minor"),
        ({"amount_minor": -500}, "amount_minor"),
        ({"amount_minor": 12.5}, "amount_minor"),
        ({"amount_minor": "1500"}, "amount_minor"),
        ({"currency": "XYZ"}, "currency"),
        ({"currency": "usd"}, "currency"),
        ({"expense_date": "2026-03-18"}, "expense_date"),
        ({"category": "gifts"}, "category"),
        ({"description": ""}, "description"),
        ({"surprise": True}, "surprise"),
    ],
)
def test_invalid_lines_are_rejected_at_the_boundary(
    db: Session, client_for: ClientFor, override: dict[str, Any], path: str
) -> None:
    client = client_for(create_user(db))
    report = new_report(client)
    body = {
        "expected_version": report["version"],
        "expense_date": "2026-03-10",
        "category": "meals",
        "description": "Lunch",
        "amount_minor": 1500,
        "currency": "USD",
        **override,
    }

    response = client.post(f"/api/reports/{report['id']}/lines", json=body)

    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert path in [f["path"] for f in error["details"]["fields"]]
    assert db.scalars(select(ExpenseLine)).all() == []


def test_expense_date_of_tomorrow_is_accepted(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    report = new_report(client)

    body = add_line(client, report, expense_date="2026-03-17")

    assert body["lines"][0]["expense_date"] == "2026-03-17"


def test_draft_shows_estimates_and_receipt_hints(db: Session, client_for: ClientFor) -> None:
    finance = create_user(db, role="finance")
    owner = create_user(db)
    create_rate(db, currency="JPY", effective=date(2026, 3, 1), rate="0.0067", created_by=finance)
    client = client_for(owner)
    report = new_report(client)

    report = add_line(client, report, amount_minor=3000, currency="JPY")
    report = add_line(client, report, amount_minor=5000, currency="JPY", description="Dinner")

    lines = {line["amount_minor"]: line for line in report["lines"]}
    assert lines[3000]["estimated_base_minor"] == 2010
    assert lines[3000]["needs_receipt"] is False
    assert lines[5000]["estimated_base_minor"] == 3350
    assert lines[5000]["needs_receipt"] is True
    assert lines[5000]["base_amount_minor"] is None
    assert lines[5000]["rate_used"] is None
    assert report["estimated_total_base_minor"] == 5360
    assert report["total_base_minor"] is None


def test_estimate_is_null_without_a_rate(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    report = new_report(client)

    report = add_line(client, report, amount_minor=1000, currency="EUR")
    report = add_line(client, report, amount_minor=1000, currency="USD")

    estimates = sorted(
        (line["currency"], line["estimated_base_minor"]) for line in report["lines"]
    )
    assert estimates == [("EUR", None), ("USD", 1000)]
    assert report["estimated_total_base_minor"] is None


def test_other_employee_cannot_see_or_change_report(db: Session, client_for: ClientFor) -> None:
    owner = create_user(db)
    other = create_user(db)
    report = new_report(client_for(owner))
    intruder = client_for(other)

    assert intruder.get(f"/api/reports/{report['id']}").status_code == 404
    assert (
        intruder.patch(
            f"/api/reports/{report['id']}", json={"expected_version": 1, "title": "Mine"}
        ).status_code
        == 404
    )
    assert intruder.delete(f"/api/reports/{report['id']}").status_code == 404
    listing = intruder.get("/api/reports", params={"owner": "all"}).json()
    assert listing["items"] == []


def test_finance_can_view_but_not_edit_others_drafts(db: Session, client_for: ClientFor) -> None:
    owner = create_user(db)
    finance = create_user(db, role="finance")
    report = new_report(client_for(owner))
    client = client_for(finance)

    assert client.get(f"/api/reports/{report['id']}").status_code == 200
    response = client.patch(
        f"/api/reports/{report['id']}", json={"expected_version": 1, "title": "Edited"}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "not_report_owner"


def test_list_filters_by_owner_and_status(db: Session, client_for: ClientFor) -> None:
    owner = create_user(db)
    admin = create_user(db, role="admin")
    owner_client = client_for(owner)
    new_report(owner_client, "One")
    new_report(owner_client, "Two")

    mine = owner_client.get("/api/reports").json()["items"]
    everyone = client_for(admin).get("/api/reports", params={"owner": "all"}).json()["items"]
    admins_own = client_for(admin).get("/api/reports").json()["items"]
    submitted = owner_client.get("/api/reports", params={"status": "submitted"}).json()["items"]
    limited = owner_client.get("/api/reports", params={"limit": 1}).json()

    assert {r["title"] for r in mine} == {"One", "Two"}
    assert len(everyone) == 2
    assert admins_own == []
    assert submitted == []
    assert len(limited["items"]) == 1
    assert owner_client.get("/api/reports", params={"limit": 201}).status_code == 400


def test_never_submitted_draft_can_be_deleted(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    report = add_line(client, new_report(client))

    response = client.delete(f"/api/reports/{report['id']}")

    assert response.status_code == 204
    assert db.scalars(select(Report)).all() == []
    assert db.scalars(select(ExpenseLine)).all() == []
    assert db.scalars(select(AuditEvent.action).order_by(AuditEvent.id)).all()[-1] == (
        "report.deleted"
    )
