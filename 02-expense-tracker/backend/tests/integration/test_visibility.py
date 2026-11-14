from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import User
from tests.integration.factories import create_user, new_report
from tests.integration.workflow_support import Org, decide, draft, ok, seed_rate, submitted

ClientFor = Callable[[User], TestClient]


def pending_ids(client: TestClient) -> list[str]:
    return [item["id"] for item in ok(client.get("/api/approvals/pending"))["items"]]


def test_reports_outside_callers_view_are_not_found(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    report = submitted(employee, draft(employee, 1000))
    url = f"/api/reports/{report['id']}"

    assert client_for(org.lead).get(url).status_code == 200
    assert client_for(org.finance).get(url).status_code == 200
    assert client_for(org.admin).get(url).status_code == 200
    assert client_for(org.director).get(url).status_code == 404
    assert client_for(create_user(db, manager=org.lead)).get(url).status_code == 404


def test_past_approver_keeps_access_after_report_completes(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    lead = client_for(org.lead)
    report = submitted(employee, draft(employee, 1000))
    report = ok(decide(lead, report, "approve"))
    report = ok(decide(client_for(org.finance), report, "approve"))

    assert lead.get(f"/api/reports/{report['id']}").status_code == 200
    listed = ok(lead.get("/api/reports", params={"owner": "all"}))["items"]
    assert [r["id"] for r in listed] == [report["id"]]
    assert ok(lead.get("/api/reports"))["items"] == []


def test_manager_list_includes_own_and_involved_reports_only(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    lead = client_for(org.lead)
    employee = client_for(org.employee)
    own = new_report(lead, "Lead's own")
    involved = submitted(employee, draft(employee, 1000))
    new_report(employee, "Employee draft")
    new_report(client_for(org.director), "Director draft")

    listed = {r["id"] for r in ok(lead.get("/api/reports", params={"owner": "all"}))["items"]}

    assert listed == {own["id"], involved["id"]}


def test_pending_approvals_follow_the_current_step(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    lead = client_for(org.lead)
    director = client_for(org.director)
    finance = client_for(org.finance)
    finance2 = client_for(org.finance2)
    admin = client_for(org.admin)
    report = submitted(employee, draft(employee, 2400, 2400, 2400, 2400, 2400))
    rid = report["id"]

    assert pending_ids(lead) == [rid]
    assert pending_ids(director) == []
    assert pending_ids(finance) == []
    assert pending_ids(employee) == []
    assert pending_ids(admin) == []

    report = ok(decide(lead, report, "approve"))
    assert pending_ids(lead) == []
    assert pending_ids(director) == [rid]

    report = ok(decide(director, report, "approve"))
    inbox = ok(finance.get("/api/approvals/pending"))["items"]
    assert [(i["id"], i["current_step_kind"], i["current_step_position"]) for i in inbox] == [
        (rid, "finance", 3)
    ]
    assert pending_ids(finance2) == [rid]
    assert pending_ids(director) == []


def test_pending_approvals_exclude_own_reports_and_earlier_deciders(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    finance_lead = create_user(db, role="finance", limit=1_000_000)
    member = client_for(create_user(db, manager=finance_lead))
    finance_lead_client = client_for(finance_lead)
    report = submitted(member, draft(member, 1000))
    own = client_for(org.finance)
    submitted(own, draft(own, 1000))

    assert report["id"] in pending_ids(finance_lead_client)
    ok(decide(finance_lead_client, report, "approve"))

    assert report["id"] not in pending_ids(finance_lead_client)
    assert report["id"] in pending_ids(own)
    assert len(pending_ids(own)) == 1


def test_audit_log_is_filtered_to_viewable_reports(
    db: Session, org: Org, client_for: ClientFor
) -> None:
    employee = client_for(org.employee)
    stranger = client_for(create_user(db))
    finance = client_for(org.finance)
    report = submitted(employee, draft(employee, 1000))
    finance.post(
        "/api/exchange-rates",
        json={"from_currency": "EUR", "effective_date": "2026-03-01", "rate": "1.1"},
    )
    seed_rate(db, org, "GBP", "2026-03-01", "1.27")
    query = {"entity_type": "report", "entity_id": report["id"]}

    own_events = ok(employee.get("/api/audit", params=query))["items"]
    stranger_events = ok(stranger.get("/api/audit", params=query))["items"]
    employee_all = ok(employee.get("/api/audit"))["items"]
    finance_all = ok(finance.get("/api/audit"))["items"]
    lead_events = ok(client_for(org.lead).get("/api/audit", params=query))["items"]

    assert [e["action"] for e in own_events] == [
        "report.created",
        "line.added",
        "report.submitted",
    ]
    assert stranger_events == []
    assert {e["entity_type"] for e in employee_all} == {"report", "line"}
    assert "rate.created" in {e["action"] for e in finance_all}
    assert len(lead_events) == 3
