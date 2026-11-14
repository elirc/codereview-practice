from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditEvent, User
from tests.integration.factories import create_user

ClientFor = Callable[[User], TestClient]


def test_only_admin_lists_users(db: Session, client_for: ClientFor) -> None:
    admin = create_user(db, role="admin")
    finance = create_user(db, role="finance")

    assert client_for(finance).get("/api/users").status_code == 403
    response = client_for(admin).get("/api/users")
    assert response.status_code == 200
    assert {u["id"] for u in response.json()["items"]} == {str(admin.id), str(finance.id)}
    assert all("password_hash" not in u for u in response.json()["items"])


def test_admin_updates_role_and_limit_with_audit_of_changed_fields(
    db: Session, client_for: ClientFor
) -> None:
    admin = create_user(db, role="admin")
    target = create_user(db, role="employee")

    response = client_for(admin).patch(
        f"/api/users/{target.id}",
        json={"role": "manager", "approval_limit_minor": 50_000, "active": True},
    )

    assert response.status_code == 200
    assert response.json()["role"] == "manager"
    events = db.scalars(select(AuditEvent).where(AuditEvent.entity_id == target.id)).all()
    assert len(events) == 1
    assert events[0].action == "user.updated"
    assert events[0].actor_id == admin.id
    assert events[0].before == {"role": "employee", "approval_limit_minor": 0}
    assert events[0].after == {"role": "manager", "approval_limit_minor": 50_000}


def test_non_admin_cannot_update_users(db: Session, client_for: ClientFor) -> None:
    manager = create_user(db, role="manager")
    target = create_user(db, role="employee", manager=manager)

    response = client_for(manager).patch(f"/api/users/{target.id}", json={"role": "finance"})

    assert response.status_code == 403
    assert db.scalars(select(AuditEvent)).all() == []


def test_manager_cycle_is_rejected(db: Session, client_for: ClientFor) -> None:
    admin = create_user(db, role="admin")
    top = create_user(db, role="manager")
    middle = create_user(db, role="manager", manager=top)
    bottom = create_user(db, role="manager", manager=middle)
    client = client_for(admin)

    response = client.patch(f"/api/users/{top.id}", json={"manager_id": str(bottom.id)})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "manager_cycle"
    assert db.scalar(select(User.manager_id).where(User.id == top.id)) is None


def test_user_cannot_manage_themselves(db: Session, client_for: ClientFor) -> None:
    admin = create_user(db, role="admin")
    user = create_user(db, role="manager")

    response = client_for(admin).patch(f"/api/users/{user.id}", json={"manager_id": str(user.id)})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "manager_cycle"


def test_manager_can_be_cleared_and_reassigned(db: Session, client_for: ClientFor) -> None:
    admin = create_user(db, role="admin")
    old_manager = create_user(db, role="manager")
    new_manager = create_user(db, role="manager")
    user = create_user(db, manager=old_manager)
    client = client_for(admin)

    cleared = client.patch(f"/api/users/{user.id}", json={"manager_id": None})
    moved = client.patch(f"/api/users/{user.id}", json={"manager_id": str(new_manager.id)})

    assert cleared.json()["manager_id"] is None
    assert moved.json()["manager_id"] == str(new_manager.id)


def test_unknown_manager_and_unknown_fields_are_rejected(
    db: Session, client_for: ClientFor
) -> None:
    admin = create_user(db, role="admin")
    user = create_user(db)
    client = client_for(admin)

    unknown = client.patch(
        f"/api/users/{user.id}", json={"manager_id": "00000000-0000-4000-8000-000000000000"}
    )
    extra = client.patch(f"/api/users/{user.id}", json={"password_hash": "x"})
    negative = client.patch(f"/api/users/{user.id}", json={"approval_limit_minor": -1})

    assert unknown.status_code == 422
    assert unknown.json()["error"]["code"] == "unknown_manager"
    assert extra.status_code == 400
    assert negative.status_code == 400


def test_employee_cannot_be_assigned_as_manager(db: Session, client_for: ClientFor) -> None:
    admin = create_user(db, role="admin")
    employee = create_user(db, role="employee")
    user = create_user(db)

    response = client_for(admin).patch(f"/api/users/{user.id}", json={"manager_id": str(employee.id)})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "manager_role_required"
    assert db.scalar(select(User.manager_id).where(User.id == user.id)) is None


def test_manager_with_reports_cannot_become_employee(db: Session, client_for: ClientFor) -> None:
    admin = create_user(db, role="admin")
    lead = create_user(db, role="manager")
    create_user(db, manager=lead)
    spare = create_user(db, role="manager")
    client = client_for(admin)

    blocked = client.patch(f"/api/users/{lead.id}", json={"role": "employee"})
    allowed = client.patch(f"/api/users/{spare.id}", json={"role": "employee"})

    assert blocked.status_code == 422
    assert blocked.json()["error"]["code"] == "manager_role_required"
    assert db.scalar(select(User.role).where(User.id == lead.id)) == "manager"
    assert allowed.status_code == 200
    assert allowed.json()["role"] == "employee"
