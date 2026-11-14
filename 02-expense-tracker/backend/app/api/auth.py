from datetime import timedelta

from fastapi import APIRouter, Request, Response, status

from app.api.deps import SESSION_COOKIE, AppClock, AppSettings, CurrentUser, DbSession
from app.schemas.users import LoginIn, MeOut, UserOut
from app.services import auth as auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login")
def login(
    body: LoginIn,
    response: Response,
    db: DbSession,
    clock: AppClock,
    settings: AppSettings,
) -> MeOut:
    ttl = timedelta(hours=settings.session_ttl_hours)
    user, token = auth_service.login(
        db, email=body.email, password=body.password, now=clock.now(), ttl=ttl
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(ttl.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookies,
        path="/",
    )
    return MeOut(user=UserOut.model_validate(user), base_currency=settings.base_currency)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, db: DbSession, settings: AppSettings) -> Response:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        auth_service.logout(db, token)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(
        SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=settings.secure_cookies
    )
    return response


@router.get("/me")
def me(user: CurrentUser, settings: AppSettings) -> MeOut:
    return MeOut(user=UserOut.model_validate(user), base_currency=settings.base_currency)
