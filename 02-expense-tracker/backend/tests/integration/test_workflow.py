from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ApprovalStep, AuditEvent, Reimbursement, User
from tests.integration.factories import add_line, create_user, new_report
from tests.integration.workflow_support import (
    Org,
    act,
    decide,
    draft,
    error_code,
    ok,
    round_steps,
    seed_rate,
    submitted,
)

ClientFor = Callable[[User], TestClient]


def test_report_travels_from_draft_to_reimbursed_with_audit_trail(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    seed_rate(db, org, "JPY", "2026-03-01", "0.0067")
    employee = client_for(org.employee)
    lead = client_for(org.lead)
    finance = client_for(org.finance)

    report = new_report(employee, "Tokyo trip")
    report = add_line(employee, report, amount_minor=2000, currency="USD")
    report = add_line(employee, report, amount_minor=1000, currency="JPY", description="Metro")
    report = submitted(employee, report)

    assert report["status"] == "submitted"
    assert report["round"] == 1
    assert report["total_base_minor"] == 2670
    frozen = {line["currency"]: line for line in report["lines"]}
    assert frozen["JPY"]["rate_used"] == "0.0067"
    assert frozen["JPY"]["rate_effective_date"] == "2026-03-01"
    assert frozen["JPY"]["base_amount_minor"] == 670
    assert frozen["USD"]["rate_used"] == "1"
    assert frozen["USD"]["rate_effective_date"] == "2026-03-10"
    assert frozen["USD"]["base_amount_minor"] == 2000
    steps = round_steps(report)
    assert [(s["position"], s["kind"], s["status"]) for s in steps] == [
        (1, "manager", "pending"),
        (2, "finance", "pending"),
    ]
    assert steps[0]["approver"]["id"] == str(org.lead.id)
    assert report["current_step_id"] == steps[0]["id"]

    report = ok(decide(lead, report, "approve", comment="Looks right"))
    assert report["status"] == "submitted"
    assert report["current_step_id"] == steps[1]["id"]

    report = ok(decide(finance, report, "approve"))
    assert report["status"] == "approved"
    assert report["decided_at"] is not None
    assert report["can"]["reimburse"] is True

    report = ok(act(finance, report, "reimburse", payment_reference="PAY-2026-0042"))
    assert report["status"] == "reimbursed"
    assert report["reimbursement"]["amount_base_minor"] == 2670
    assert report["reimbursement"]["currency"] == "USD"
    assert report["reimbursement"]["payment_reference"] == "PAY-2026-0042"

    events = db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all()
    assert [(e.entity_type, e.action) for e in events] == [
        ("report", "report.created"),
        ("line", "line.added"),
        ("line", "line.added"),
        ("report", "report.submitted"),
        ("step", "step.approved"),
        ("report", "step.approved"),
        ("step", "step.approved"),
        ("report", "step.approved"),
        ("report", "report.reimbursed"),
    ]
    submit_event = events[3]
    assert submit_event.before == {
        "status": "draft",
        "round": 0,
        "version": 3,
        "total_base_minor": None,
    }
    assert submit_event.after == {
        "status": "submitted",
        "round": 1,
        "version": 4,
        "total_base_minor": 2670,
    }
    assert events[4].after == {
        "status": "approved",
        "decided_by": str(org.lead.id),
        "comment": "Looks right",
    }
    assert all(e.request_id for e in events)

    timeline = employee.get(
        "/api/audit", params={"entity_type": "report", "entity_id": report["id"]}
    ).json()["items"]
    assert len(timeline) == 9
    assert timeline[4]["actor"]["id"] == str(org.lead.id)


def test_conversions_round_per_line_and_total_is_their_sum(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    seed_rate(db, org, "JPY", "2026-03-01", "0.0067")
    seed_rate(db, org, "KWD", "2026-03-01", "3.25")
    seed_rate(db, org, "EUR", "2026-03-01", "0.3333333333")
    client = client_for(org.employee)
    report = new_report(client)
    report = add_line(client, report, amount_minor=1000, currency="JPY")
    report = add_line(client, report, amount_minor=1500, currency="KWD")
    for index in range(3):
        report = add_line(
            client, report, amount_minor=100, currency="EUR", description=f"Snack {index}"
        )

    report = submitted(client, report)

    bases = sorted((line["currency"], line["base_amount_minor"]) for line in report["lines"])
    assert bases == [("EUR", 33), ("EUR", 33), ("EUR", 33), ("JPY", 670), ("KWD", 488)]
    assert report["total_base_minor"] == 670 + 488 + 99


def test_rate_is_chosen_by_expense_date_and_frozen_at_submit(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    seed_rate(db, org, "EUR", "2026-02-01", "1.05")
    seed_rate(db, org, "EUR", "2026-03-01", "1.10")
    seed_rate(db, org, "EUR", "2026-03-20", "2.00")
    client = client_for(org.employee)
    report = new_report(client)
    report = add_line(client, report, amount_minor=1000, currency="EUR", expense_date="2026-02-15")
    report = add_line(client, report, amount_minor=1000, currency="EUR", expense_date="2026-03-10")

    report = submitted(client, report)
    seed_rate(db, org, "EUR", "2026-03-08", "1.50")
    after = ok(client.get(f"/api/reports/{report['id']}"))

    by_date = {line["expense_date"]: line for line in after["lines"]}
    assert by_date["2026-02-15"]["rate_used"] == "1.05"
    assert by_date["2026-02-15"]["base_amount_minor"] == 1050
    assert by_date["2026-03-10"]["rate_used"] == "1.1"
    assert by_date["2026-03-10"]["rate_effective_date"] == "2026-03-01"
    assert by_date["2026-03-10"]["base_amount_minor"] == 1100
    assert after["total_base_minor"] == 2150


def test_rejection_then_reopen_and_resubmit_builds_new_round_with_fresh_rates(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    seed_rate(db, org, "EUR", "2026-03-01", "1.10")
    employee = client_for(org.employee)
    lead = client_for(org.lead)
    report = submitted(employee, draft(employee, 1000, currency="EUR"))

    missing_comment = decide(lead, report, "reject")
    blank_comment = decide(lead, report, "reject", comment="   ")
    assert missing_comment.status_code == 400
    assert error_code(missing_comment) == "validation_failed"
    assert blank_comment.status_code == 400

    rejected = ok(decide(lead, report, "reject", comment="Please add the agenda"))
    assert rejected["status"] == "rejected"
    assert [s["status"] for s in round_steps(rejected)] == ["rejected", "skipped"]
    assert round_steps(rejected)[0]["comment"] == "Please add the agenda"
    assert rejected["can"]["reopen"] is False

    reopened = ok(act(employee, rejected, "reopen"))
    assert reopened["status"] == "draft"
    assert reopened["round"] == 1
    assert reopened["total_base_minor"] is None
    line = reopened["lines"][0]
    assert line["rate_used"] is None
    assert line["rate_effective_date"] is None
    assert line["base_amount_minor"] is None
    assert len(reopened["steps"]) == 2

    seed_rate(db, org, "EUR", "2026-03-05", "1.20")
    resubmitted = submitted(employee, reopened)

    assert resubmitted["round"] == 2
    assert resubmitted["lines"][0]["rate_used"] == "1.2"
    assert resubmitted["lines"][0]["base_amount_minor"] == 1200
    assert [s["status"] for s in round_steps(resubmitted, 1)] == ["rejected", "skipped"]
    assert [s["status"] for s in round_steps(resubmitted, 2)] == ["pending", "pending"]
    assert resubmitted["current_step_id"] == round_steps(resubmitted, 2)[0]["id"]
    actions = db.scalars(select(AuditEvent.action).order_by(AuditEvent.id)).all()
    assert "report.reopened" in actions
    assert actions.count("report.submitted") == 2


def test_submission_failures_leave_state_and_audit_untouched(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    seed_rate(db, org, "EUR", "2026-03-01", "1.10")
    seed_rate(db, org, "JPY", "2026-03-01", "0.0067")
    client = client_for(org.employee)

    empty = new_report(client, "Empty")
    early = add_line(client, new_report(client), currency="EUR", expense_date="2026-02-27")
    large = add_line(client, new_report(client), amount_minor=2500)
    yen = add_line(client, new_report(client), amount_minor=5000, currency="JPY")
    events_before = db.scalars(select(AuditEvent.id)).all()

    cases = [
        (empty, "empty_report"),
        (early, "missing_exchange_rate"),
        (large, "receipt_required"),
        (yen, "receipt_required"),
    ]
    for report, code in cases:
        response = act(client, report, "submit")
        assert response.status_code == 422, response.text
        assert error_code(response) == code
        after = ok(client.get(f"/api/reports/{report['id']}"))
        assert after["status"] == "draft"
        assert after["round"] == 0
        assert after["version"] == report["version"]

    details = act(client, early, "submit").json()["error"]["details"]
    assert details == {"line_ids": [early["lines"][0]["id"]]}
    assert db.scalars(select(AuditEvent.id)).all() == events_before
    assert db.scalars(select(ApprovalStep)).all() == []


def test_small_yen_line_needs_no_receipt(db: Session, org: Org, client_for: ClientFor) -> None:
    seed_rate(db, org, "JPY", "2026-03-01", "0.0067")
    client = client_for(org.employee)

    report = submitted(client, draft(client, 3000, currency="JPY"))

    assert report["total_base_minor"] == 2010


def test_submit_without_other_active_finance_user_fails(db: Session, client_for: ClientFor) -> None:
    owner = create_user(db, role="finance")
    create_user(db, role="finance", active=False)
    client = client_for(owner)
    report = draft(client, 1000)

    response = act(client, report, "submit")

    assert response.status_code == 422
    assert error_code(response) == "no_eligible_approver"
    assert ok(client.get(f"/api/reports/{report['id']}"))["round"] == 0


def test_owner_without_manager_gets_only_finance_step(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    client = client_for(create_user(db))

    report = submitted(client, draft(client, 1000))

    assert [(s["position"], s["kind"]) for s in round_steps(report)] == [(1, "finance")]
    assert round_steps(report)[0]["approver"] is None


def test_total_above_first_limit_escalates_to_top_of_chain(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    client = client_for(org.employee)

    report = submitted(client, draft(client, 2400, 2400, 2400, 2400, 2400, 2400, 2400))

    assert report["total_base_minor"] == 16_800
    approvers = [s["approver"]["id"] if s["approver"] else None for s in round_steps(report)]
    assert approvers == [str(org.lead.id), str(org.director.id), None]


def test_withdraw_returns_to_draft_until_a_step_is_decided(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    lead = client_for(org.lead)
    report = submitted(employee, draft(employee, 1000))

    withdrawn = ok(act(employee, report, "withdraw"))
    assert withdrawn["status"] == "draft"
    assert withdrawn["total_base_minor"] is None
    assert withdrawn["lines"][0]["base_amount_minor"] is None
    assert [s["status"] for s in round_steps(withdrawn, 1)] == ["skipped", "skipped"]
    assert employee.delete(f"/api/reports/{report['id']}").status_code == 409

    again = submitted(employee, withdrawn)
    assert again["round"] == 2
    approved_once = ok(decide(lead, again, "approve"))

    late = act(employee, approved_once, "withdraw")
    assert late.status_code == 409
    assert error_code(late) == "invalid_state"


def test_lines_cannot_change_after_submission(db: Session, org: Org, client_for: ClientFor) -> None:
    client = client_for(org.employee)
    report = submitted(client, draft(client, 1000))
    line_id = report["lines"][0]["id"]

    edit = client.patch(
        f"/api/reports/{report['id']}/lines/{line_id}",
        json={"expected_version": report["version"], "amount_minor": 5},
    )
    rename = client.patch(
        f"/api/reports/{report['id']}",
        json={"expected_version": report["version"], "title": "Changed"},
    )

    assert edit.status_code == 409
    assert error_code(edit) == "invalid_state"
    assert rename.status_code == 409


def test_original_approver_decides_after_manager_change(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    report = submitted(employee, draft(employee, 1000))

    moved = client_for(org.admin).patch(
        f"/api/users/{org.employee.id}", json={"manager_id": str(org.director.id)}
    )
    assert moved.status_code == 200

    approved = ok(decide(client_for(org.lead), report, "approve"))
    assert round_steps(approved)[0]["decided_by"]["id"] == str(org.lead.id)


def test_finance_demoted_after_submission_cannot_take_finance_step(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    owner = client_for(create_user(db))
    report = submitted(owner, draft(owner, 1000))
    demoted = client_for(org.finance)

    client_for(org.admin).patch(f"/api/users/{org.finance.id}", json={"role": "employee"})

    assert decide(demoted, report, "approve").status_code == 404
    assert ok(decide(client_for(org.finance2), report, "approve"))["status"] == "approved"


def test_admin_reassigns_step_of_deactivated_manager(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    admin = client_for(org.admin)
    report = submitted(employee, draft(employee, 1000))
    url = f"/api/reports/{report['id']}/steps/{report['current_step_id']}/reassign"

    still_active = admin.post(url, json={"approver_id": str(org.director.id)})
    assert still_active.status_code == 422
    assert error_code(still_active) == "approver_active"

    admin.patch(f"/api/users/{org.lead.id}", json={"active": False})
    wrong_target = admin.post(url, json={"approver_id": str(org.finance2.id)})
    owner_target = admin.post(url, json={"approver_id": str(org.employee.id)})
    not_admin = client_for(org.finance).post(url, json={"approver_id": str(org.director.id)})
    reassigned = admin.post(url, json={"approver_id": str(org.director.id)})

    assert wrong_target.status_code == 422
    assert error_code(wrong_target) == "invalid_reassignment"
    assert owner_target.status_code == 422
    assert not_admin.status_code == 403
    body = ok(reassigned)
    assert round_steps(body)[0]["approver"]["id"] == str(org.director.id)
    event = db.scalars(select(AuditEvent).where(AuditEvent.action == "step.reassigned")).one()
    assert event.before == {"approver_id": str(org.lead.id)}
    assert event.after == {"approver_id": str(org.director.id)}

    approved = ok(decide(client_for(org.director), body, "approve"))
    assert round_steps(approved)[0]["status"] == "approved"


def test_rate_used_by_submitted_line_cannot_be_edited(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    used = seed_rate(db, org, "EUR", "2026-03-01", "1.10")
    unused = seed_rate(db, org, "GBP", "2026-03-01", "1.27")
    employee = client_for(org.employee)
    finance = client_for(org.finance)
    report = submitted(employee, draft(employee, 1000, currency="EUR"))

    blocked = finance.patch(f"/api/exchange-rates/{used.id}", json={"rate": "1.11"})
    allowed = finance.patch(f"/api/exchange-rates/{unused.id}", json={"rate": "1.28"})
    listing = {r["id"]: r["in_use"] for r in finance.get("/api/exchange-rates").json()["items"]}

    assert blocked.status_code == 409
    assert error_code(blocked) == "rate_in_use"
    assert allowed.status_code == 200
    assert listing == {str(used.id): True, str(unused.id): False}

    ok(act(employee, report, "withdraw"))
    reopened_edit = finance.patch(f"/api/exchange-rates/{used.id}", json={"rate": "1.11"})
    assert reopened_edit.status_code == 200


def test_reimbursement_is_recorded_once(db: Session, org: Org, client_for: ClientFor) -> None:
    owner = client_for(create_user(db))
    finance = client_for(org.finance)
    report = ok(decide(finance, submitted(owner, draft(owner, 1000)), "approve"))

    first = act(finance, report, "reimburse", payment_reference="PAY-1")
    retry = act(finance, report, "reimburse", payment_reference="PAY-1")
    fresh_retry = act(finance, first.json(), "reimburse", payment_reference="PAY-1")

    assert first.status_code == 200
    assert retry.status_code == 409
    assert fresh_retry.status_code == 409
    assert error_code(fresh_retry) == "invalid_state"
    assert len(db.scalars(select(Reimbursement)).all()) == 1
