from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditEvent, Reimbursement, User
from tests.integration.factories import create_user
from tests.integration.workflow_support import (
    Org,
    act,
    decide,
    draft,
    error_code,
    ok,
    round_steps,
    submitted,
)

ClientFor = Callable[[User], TestClient]


@pytest.mark.parametrize("role", ["employee", "manager", "finance", "admin"])
def test_owner_can_never_approve_own_report(
    db: Session, org: Org, client_for: ClientFor, role: str
) -> None:
    owner = create_user(db, role=role)
    client = client_for(owner)
    report = submitted(client, draft(client, 1000))

    approve = decide(client, report, "approve")
    reject = decide(client, report, "reject", comment="No")

    assert approve.status_code == 403
    assert error_code(approve) == "self_approval"
    assert reject.status_code == 403
    assert error_code(reject) == "self_approval"


def test_manager_who_is_also_owners_approver_cannot_self_approve(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    client = client_for(org.lead)
    report = submitted(client, draft(client, 1000))

    assert round_steps(report)[0]["approver"]["id"] == str(org.director.id)
    response = decide(client, report, "approve")
    assert response.status_code == 403
    assert error_code(response) == "self_approval"


def test_finance_owner_needs_another_finance_user(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    owner = client_for(org.finance)
    report = submitted(owner, draft(owner, 1000))

    assert error_code(decide(owner, report, "approve")) == "self_approval"
    assert ok(decide(client_for(org.finance2), report, "approve"))["status"] == "approved"


def test_finance_manager_cannot_also_take_finance_step(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    finance_lead = create_user(db, role="finance", limit=1_000_000)
    owner = create_user(db, manager=finance_lead)
    report = submitted(client_for(owner), draft(client_for(owner), 1000))
    finance_lead_client = client_for(finance_lead)

    report = ok(decide(finance_lead_client, report, "approve"))
    second = decide(finance_lead_client, report, "approve")

    assert second.status_code == 403
    assert error_code(second) == "separation_of_duties"
    assert ok(decide(client_for(org.finance), report, "approve"))["status"] == "approved"


def test_later_step_cannot_be_decided_before_current_one(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    report = submitted(employee, draft(employee, 2400, 2400, 2400, 2400, 2400))
    second_step = round_steps(report)[1]

    response = decide(client_for(org.director), report, "approve", step_id=second_step["id"])

    assert response.status_code == 409
    assert error_code(response) == "not_current_step"
    assert db.scalars(select(AuditEvent).where(AuditEvent.entity_type == "step")).all() == []


def test_admin_has_no_approval_power(db: Session, org: Org, client_for: ClientFor) -> None:
    employee = client_for(org.employee)
    admin = client_for(org.admin)
    report = submitted(employee, draft(employee, 1000))

    on_manager_step = decide(admin, report, "approve")
    report = ok(decide(client_for(org.lead), report, "approve"))
    on_finance_step = decide(admin, report, "approve")

    assert on_manager_step.status_code == 403
    assert on_finance_step.status_code == 403
    assert error_code(on_finance_step) == "not_step_approver"


def test_only_named_approver_decides_manager_step(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    report = submitted(employee, draft(employee, 1000))

    by_finance = decide(client_for(org.finance), report, "approve")
    by_other_manager = decide(client_for(org.director), report, "approve")
    by_colleague = decide(client_for(create_user(db, manager=org.lead)), report, "approve")

    assert by_finance.status_code == 403
    assert error_code(by_finance) == "not_step_approver"
    assert by_other_manager.status_code == 404
    assert by_colleague.status_code == 404


def test_employee_named_as_manager_cannot_decide(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    supervisor = create_user(db, role="employee")
    owner = client_for(create_user(db, manager=supervisor))
    report = submitted(owner, draft(owner, 1000))

    assert round_steps(report)[0]["approver"]["id"] == str(supervisor.id)
    assert decide(client_for(supervisor), report, "approve").status_code == 404


def test_reimbursement_permissions(db: Session, org: Org, client_for: ClientFor) -> None:
    employee = client_for(org.employee)
    report = submitted(employee, draft(employee, 1000))
    report = ok(decide(client_for(org.lead), report, "approve"))

    too_early = act(client_for(org.finance), report, "reimburse", payment_reference="P-1")
    assert too_early.status_code == 409
    assert error_code(too_early) == "invalid_state"

    report = ok(decide(client_for(org.finance2), report, "approve"))
    by_owner = act(employee, report, "reimburse", payment_reference="P-1")
    by_manager = act(client_for(org.lead), report, "reimburse", payment_reference="P-1")
    by_admin = act(client_for(org.admin), report, "reimburse", payment_reference="P-1")
    by_stranger = act(client_for(create_user(db)), report, "reimburse", payment_reference="P-1")

    assert error_code(by_owner) == "self_approval"
    assert by_manager.status_code == 403
    assert by_admin.status_code == 403
    assert by_stranger.status_code == 404
    assert db.scalars(select(Reimbursement)).all() == []
    assert ok(act(client_for(org.finance), report, "reimburse", payment_reference="P-1"))


def test_finance_cannot_reimburse_own_report(db: Session, org: Org, client_for: ClientFor) -> None:
    owner = client_for(org.finance)
    report = ok(decide(client_for(org.finance2), submitted(owner, draft(owner, 1000)), "approve"))

    response = act(owner, report, "reimburse", payment_reference="SELF-1")

    assert response.status_code == 403
    assert error_code(response) == "self_approval"
    assert db.scalars(select(Reimbursement)).all() == []


def test_stale_version_conflicts_on_decide_and_reimburse(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    owner = client_for(create_user(db))
    finance = client_for(org.finance)
    report = submitted(owner, draft(owner, 1000))
    stale = {**report, "version": report["version"] - 1}

    stale_decision = decide(finance, stale, "approve")
    assert stale_decision.status_code == 409
    assert error_code(stale_decision) == "version_conflict"
    assert stale_decision.json()["error"]["details"] == {"current_version": report["version"]}

    approved = ok(decide(finance, report, "approve"))
    stale_reimburse = act(finance, report, "reimburse", payment_reference="P-9")
    assert stale_reimburse.status_code == 409
    assert error_code(stale_reimburse) == "version_conflict"
    assert approved["status"] == "approved"


def test_other_users_cannot_drive_owner_transitions(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    report = draft(employee, 1000)

    by_finance = act(client_for(org.finance), report, "submit")
    by_stranger = act(client_for(create_user(db)), report, "submit")

    assert by_finance.status_code == 403
    assert error_code(by_finance) == "not_report_owner"
    assert by_stranger.status_code == 404
