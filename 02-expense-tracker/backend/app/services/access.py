from app.domain.enums import Role
from app.domain.errors import Forbidden
from app.models import User


def has_role(user: User, *roles: Role) -> bool:
    return user.role in roles


def ensure_role(user: User, *roles: Role) -> None:
    if not has_role(user, *roles):
        raise Forbidden()
