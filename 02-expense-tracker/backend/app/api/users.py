import uuid

from fastapi import APIRouter

from app.api.deps import Ctx, Page
from app.schemas.common import Paginated
from app.schemas.users import UserOut, UserUpdate
from app.services import users as users_service

router = APIRouter(prefix="/users", tags=["users"])


@router.get("")
def list_users(ctx: Ctx, page: Page) -> Paginated[UserOut]:
    users = users_service.list_users(ctx, limit=page.limit, offset=page.offset)
    return Paginated[UserOut](
        items=[UserOut.model_validate(u) for u in users], limit=page.limit, offset=page.offset
    )


@router.patch("/{user_id}")
def update_user(ctx: Ctx, user_id: uuid.UUID, body: UserUpdate) -> UserOut:
    return UserOut.model_validate(users_service.update_user(ctx, user_id, body))
