import uuid
from datetime import timedelta
from functools import lru_cache
from itertools import count

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import hash_password, hash_session_token, new_session_token
from app.models import User, UserSession
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
