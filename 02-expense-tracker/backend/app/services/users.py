import uuid
from collections.abc import Sequence

from sqlalchemy import select, text

from app.domain.enums import Role
from app.domain.errors import NotFound, RuleViolation
from app.models import User
from app.schemas.users import UserUpdate
from app.services import audit
from app.services.access import ensure_role
from app.services.context import ServiceContext

USER_AUDIT_FIELDS = ("role", "manager_id", "approval_limit_minor", "active")
MANAGER_GRAPH_LOCK_KEY = 420_001


def list_users(ctx: ServiceContext, *, limit: int, offset: int) -> Sequence[User]:
    ensure_role(ctx.actor, Role.ADMIN)
    return ctx.db.scalars(
        select(User).order_by(User.full_name, User.id).limit(limit).offset(offset)
    ).all()


def _would_create_cycle(ctx: ServiceContext, user_id: uuid.UUID, manager_id: uuid.UUID) -> bool:
    seen: set[uuid.UUID] = set()
    current: uuid.UUID | None = manager_id
    while current is not None:
        if current == user_id:
            return True
        if current in seen:
            return True
        seen.add(current)
        current = ctx.db.scalar(select(User.manager_id).where(User.id == current))
    return False


def update_user(ctx: ServiceContext, user_id: uuid.UUID, changes: UserUpdate) -> User:
    ensure_role(ctx.actor, Role.ADMIN)
    fields = changes.model_fields_set

    if "manager_id" in fields:
        ctx.db.execute(
            text("SELECT pg_advisory_xact_lock(:key)"), {"key": MANAGER_GRAPH_LOCK_KEY}
        )

    user = ctx.db.scalars(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one_or_none()
    if user is None:
        raise NotFound()

    before = audit.snapshot(user, USER_AUDIT_FIELDS)

    if "manager_id" in fields:
        manager_id = changes.manager_id
        if manager_id is not None:
            if ctx.db.get(User, manager_id) is None:
                raise RuleViolation("unknown_manager", "The selected manager does not exist.")
            if _would_create_cycle(ctx, user.id, manager_id):
                raise RuleViolation(
                    "manager_cycle", "That manager would create a cycle in the reporting line."
                )
        user.manager_id = manager_id
    if changes.role is not None:
        user.role = changes.role
    if changes.approval_limit_minor is not None:
        user.approval_limit_minor = changes.approval_limit_minor
    if changes.active is not None:
        user.active = changes.active

    old, new = audit.changed_fields(before, audit.snapshot(user, USER_AUDIT_FIELDS))
    if new:
        user.updated_at = ctx.now
        audit.record(
            ctx, entity_type="user", entity_id=user.id, action="user.updated", before=old, after=new
        )
    ctx.db.commit()
    return user
