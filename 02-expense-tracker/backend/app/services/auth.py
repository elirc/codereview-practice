from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.security import (
    burn_password_check,
    hash_session_token,
    new_session_token,
    verify_password,
)
from app.domain.errors import Unauthenticated
from app.models import User, UserSession


def _invalid_credentials() -> Unauthenticated:
    return Unauthenticated("invalid_credentials", "Email or password is incorrect.")


def login(
    db: Session, *, email: str, password: str, now: datetime, ttl: timedelta
) -> tuple[User, str]:
    """Verify credentials and open a session. Returns the user and the raw token."""
    user = db.scalar(select(User).where(User.email == email.strip().lower()))
    if user is None:
        burn_password_check(password)
        raise _invalid_credentials()
    if not verify_password(user.password_hash, password) or not user.active:
        raise _invalid_credentials()

    token = new_session_token()
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=hash_session_token(token),
            created_at=now,
            expires_at=now + ttl,
        )
    )
    db.commit()
    return user, token


def logout(db: Session, token: str) -> None:
    db.execute(delete(UserSession).where(UserSession.token_hash == hash_session_token(token)))
    db.commit()


def user_for_token(db: Session, token: str, now: datetime) -> User | None:
    return db.scalar(
        select(User)
        .join(UserSession, UserSession.user_id == User.id)
        .where(
            UserSession.token_hash == hash_session_token(token),
            UserSession.expires_at > now,
            User.active.is_(True),
        )
    )
