from datetime import timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import UserSession
from tests.conftest import START_OF_TEST_TIME, SteppingClock
from tests.integration.factories import PASSWORD, api_client, create_user


def test_login_sets_http_only_cookie_and_me_returns_user(app: FastAPI, db: Session) -> None:
    user = create_user(db, role="manager", email="maria@example.com")
    client = api_client(app)

    response = client.post(
        "/api/auth/login", json={"email": "Maria@Example.com", "password": PASSWORD}
    )

    assert response.status_code == 200
    cookie_header = response.headers["set-cookie"]
    assert cookie_header.startswith("et_session=")
    assert "HttpOnly" in cookie_header
    assert "samesite=lax" in cookie_header.lower()
    assert "Secure" not in cookie_header
    assert "password_hash" not in response.text

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["id"] == str(user.id)
    assert me.json()["base_currency"] == "USD"


def test_session_token_is_stored_hashed(app: FastAPI, db: Session) -> None:
    create_user(db, email="hash@example.com")
    client = api_client(app)

    client.post("/api/auth/login", json={"email": "hash@example.com", "password": PASSWORD})

    token = client.cookies.get("et_session")
    stored = db.scalars(select(UserSession.token_hash)).all()
    assert token is not None
    assert len(stored) == 1
    assert stored[0] != token
    assert len(stored[0]) == 64


def test_login_rejects_wrong_password_and_unknown_email(app: FastAPI, db: Session) -> None:
    create_user(db, email="kim@example.com")
    client = api_client(app)

    wrong = client.post("/api/auth/login", json={"email": "kim@example.com", "password": "nope"})
    unknown = client.post(
        "/api/auth/login", json={"email": "ghost@example.com", "password": PASSWORD}
    )

    assert wrong.status_code == 401
    assert wrong.json()["error"]["code"] == "invalid_credentials"
    assert unknown.status_code == 401
    assert unknown.json()["error"]["code"] == "invalid_credentials"


def test_inactive_user_cannot_log_in(app: FastAPI, db: Session) -> None:
    create_user(db, email="gone@example.com", active=False)

    response = api_client(app).post(
        "/api/auth/login", json={"email": "gone@example.com", "password": PASSWORD}
    )

    assert response.status_code == 401


def test_mutation_without_csrf_header_is_rejected(app: FastAPI, db: Session) -> None:
    create_user(db, email="csrf@example.com")
    client = TestClient(app)

    response = client.post(
        "/api/auth/login", json={"email": "csrf@example.com", "password": PASSWORD}
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


def test_me_requires_session(app: FastAPI) -> None:
    response = api_client(app).get("/api/auth/me")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_logout_revokes_session(app: FastAPI, db: Session) -> None:
    create_user(db, email="bye@example.com")
    client = api_client(app)
    client.post("/api/auth/login", json={"email": "bye@example.com", "password": PASSWORD})
    token = client.cookies.get("et_session")

    logout = client.post("/api/auth/logout")

    assert logout.status_code == 204
    assert db.scalars(select(UserSession)).all() == []
    replay = api_client(app)
    replay.cookies.set("et_session", token or "")
    assert replay.get("/api/auth/me").status_code == 401


def test_expired_session_is_rejected(app: FastAPI, db: Session, clock: SteppingClock) -> None:
    create_user(db, email="late@example.com")
    client = api_client(app)
    client.post("/api/auth/login", json={"email": "late@example.com", "password": PASSWORD})

    clock.set(START_OF_TEST_TIME + timedelta(hours=13))

    assert client.get("/api/auth/me").status_code == 401


def test_login_rejects_unknown_fields(app: FastAPI, db: Session) -> None:
    response = api_client(app).post(
        "/api/auth/login",
        json={"email": "x@example.com", "password": PASSWORD, "role": "admin"},
    )

    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert {"path": "role", "message": "Extra inputs are not permitted"} in error["details"][
        "fields"
    ]
