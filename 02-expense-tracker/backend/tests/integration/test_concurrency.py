import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ApprovalStep, AuditEvent, Report, User
from tests.integration.factories import create_user
from tests.integration.workflow_support import Json, Org, act, decide, draft, ok, submitted

ClientFor = Callable[[User], TestClient]


def run_together(*calls: Callable[[], httpx.Response]) -> list[httpx.Response]:
    barrier = threading.Barrier(len(calls))

    def start(call: Callable[[], httpx.Response]) -> httpx.Response:
        barrier.wait()
        return call()

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [pool.submit(start, call) for call in calls]
        return [future.result() for future in futures]


def step_events(db: Session, step_id: str) -> list[AuditEvent]:
    return list(
        db.scalars(
            select(AuditEvent).where(
                AuditEvent.entity_type == "step", AuditEvent.entity_id == uuid.UUID(step_id)
            )
        ).all()
    )


def finance_only_report(db: Session, client_for: ClientFor) -> Json:
    owner = client_for(create_user(db))
    return submitted(owner, draft(owner, 1000))


def test_two_finance_users_deciding_one_step_produce_one_decision(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    report = finance_only_report(db, client_for)
    first = client_for(org.finance)
    second = client_for(org.finance2)

    responses = run_together(
        lambda: decide(first, report, "approve"),
        lambda: decide(second, report, "reject", comment="Duplicate claim"),
    )

    assert sorted(r.status_code for r in responses) == [200, 409]
    assert len(step_events(db, report["current_step_id"])) == 1
    status = db.scalar(select(Report.status).where(Report.id == uuid.UUID(report["id"])))
    assert status in ("approved", "rejected")


def test_double_submitted_approval_is_applied_once(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    report = finance_only_report(db, client_for)
    tab_one = client_for(org.finance)
    tab_two = client_for(org.finance)

    responses = run_together(
        lambda: decide(tab_one, report, "approve"),
        lambda: decide(tab_two, report, "approve"),
    )

    codes = sorted(r.status_code for r in responses)
    assert codes == [200, 409]
    loser = next(r for r in responses if r.status_code == 409)
    assert loser.json()["error"]["code"] in ("version_conflict", "invalid_state")
    assert len(step_events(db, report["current_step_id"])) == 1
    version = db.scalar(select(Report.version).where(Report.id == uuid.UUID(report["id"])))
    assert version == report["version"] + 1


def test_withdraw_and_first_approval_race_has_one_winner(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    lead = client_for(org.lead)
    report = submitted(employee, draft(employee, 1000))

    withdraw, approve = run_together(
        lambda: act(employee, report, "withdraw"),
        lambda: decide(lead, report, "approve"),
    )

    assert sorted([withdraw.status_code, approve.status_code]) == [200, 409]
    stored = ok(employee.get(f"/api/reports/{report['id']}"))
    first_step = db.scalars(
        select(ApprovalStep).where(ApprovalStep.id == uuid.UUID(report["current_step_id"]))
    ).one()
    if approve.status_code == 200:
        assert withdraw.json()["error"]["code"] in ("version_conflict", "invalid_state")
        assert first_step.status == "approved"
        assert stored["status"] == "submitted"
    else:
        assert approve.json()["error"]["code"] in ("version_conflict", "invalid_state")
        assert first_step.status == "skipped"
        assert stored["status"] == "draft"
        assert step_events(db, report["current_step_id"]) == []
