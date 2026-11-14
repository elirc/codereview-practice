import uuid
from collections.abc import Sequence

from sqlalchemy import Row, select

from app.domain.enums import Role
from app.models import AuditEvent, Report, User
from app.services.access import has_role, visible_reports_clause
from app.services.context import ServiceContext


def list_events(
    ctx: ServiceContext,
    *,
    entity_type: str | None,
    entity_id: uuid.UUID | None,
    limit: int,
    offset: int,
) -> Sequence[Row[tuple[AuditEvent, str]]]:
    """Audit events the caller may read, oldest first.

    Filtering on a report returns the events of the report and of its lines,
    receipts and steps.
    """
    stmt = select(AuditEvent, User.full_name).outerjoin(User, User.id == AuditEvent.actor_id)
    if entity_type == "report" and entity_id is not None:
        stmt = stmt.where(AuditEvent.report_id == entity_id)
    else:
        if entity_type is not None:
            stmt = stmt.where(AuditEvent.entity_type == entity_type)
        if entity_id is not None:
            stmt = stmt.where(AuditEvent.entity_id == entity_id)

    if not has_role(ctx.actor, Role.FINANCE, Role.ADMIN):
        visible = select(Report.id).where(visible_reports_clause(ctx.actor))
        stmt = stmt.where(AuditEvent.report_id.in_(visible))

    stmt = stmt.order_by(AuditEvent.id).limit(limit).offset(offset)
    return ctx.db.execute(stmt).all()
