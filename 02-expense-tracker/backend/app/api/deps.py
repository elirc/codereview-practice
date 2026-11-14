from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query, Request
from sqlalchemy.orm import Session

from app.core.clock import Clock
from app.core.config import Settings
from app.core.db import get_db
from app.domain.errors import Forbidden, Unauthenticated
from app.models import User
from app.services import auth as auth_service
from app.services.context import ServiceContext
from app.services.storage import ReceiptStorage

SESSION_COOKIE = "et_session"
CSRF_HEADER = "x-requested-with"
CSRF_HEADER_VALUE = "fetch"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

DbSession = Annotated[Session, Depends(get_db)]


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_clock(request: Request) -> Clock:
    clock: Clock = request.app.state.clock
    return clock


def get_storage(request: Request) -> ReceiptStorage:
    storage: ReceiptStorage = request.app.state.storage
    return storage


AppSettings = Annotated[Settings, Depends(get_settings_dep)]
AppClock = Annotated[Clock, Depends(get_clock)]
Storage = Annotated[ReceiptStorage, Depends(get_storage)]


def require_csrf_header(request: Request) -> None:
    if request.method in SAFE_METHODS:
        return
    if request.headers.get(CSRF_HEADER) != CSRF_HEADER_VALUE:
        raise Forbidden("csrf_failed", "State-changing requests must send X-Requested-With: fetch.")


def get_current_user(request: Request, db: DbSession, clock: AppClock) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise Unauthenticated()
    user = auth_service.user_for_token(db, token, clock.now())
    if user is None:
        raise Unauthenticated()
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_context(
    request: Request,
    db: DbSession,
    user: CurrentUser,
    clock: AppClock,
    settings: AppSettings,
) -> ServiceContext:
    return ServiceContext(
        db=db,
        actor=user,
        request_id=request.state.request_id,
        now=clock.now(),
        base_currency=settings.base_currency,
    )


Ctx = Annotated[ServiceContext, Depends(get_context)]


@dataclass(frozen=True)
class PageParams:
    limit: int
    offset: int


def page_params(
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PageParams:
    return PageParams(limit=limit, offset=offset)


Page = Annotated[PageParams, Depends(page_params)]
