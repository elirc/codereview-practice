import uuid

from sqlalchemy import ColumnElement, exists, or_, select, true

from app.domain.enums import Role
from app.domain.errors import Conflict, Forbidden, NotFound
from app.models import ApprovalStep, Report, User
from app.services.context import ServiceContext


def has_role(user: User, *roles: Role) -> bool:
    return user.role in roles


def ensure_role(user: User, *roles: Role) -> None:
    if not has_role(user, *roles):
        raise Forbidden()


def visible_reports_clause(actor: User) -> ColumnElement[bool]:
    """SQL condition matching the reports `actor` may view."""
    if has_role(actor, Role.FINANCE, Role.ADMIN):
        return true()
    owned = Report.owner_id == actor.id
    if has_role(actor, Role.MANAGER):
        involved = (
            select(ApprovalStep.id)
            .where(
                ApprovalStep.report_id == Report.id,
                or_(ApprovalStep.approver_id == actor.id, ApprovalStep.decided_by == actor.id),
            )
            .exists()
        )
        return or_(owned, involved)
    return owned


def can_view_report(ctx: ServiceContext, report_id: uuid.UUID) -> bool:
    return bool(
        ctx.db.scalar(
            select(
                exists().where(Report.id == report_id, visible_reports_clause(ctx.actor))
            )
        )
    )


def get_visible_report(ctx: ServiceContext, report_id: uuid.UUID, *, lock: bool = False) -> Report:
    """Load a report the caller may view; anything else is reported as not found."""
    stmt = select(Report).where(Report.id == report_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    report = ctx.db.scalars(stmt).one_or_none()
    if report is None or not can_view_report(ctx, report.id):
        raise NotFound()
    return report


def get_own_report(ctx: ServiceContext, report_id: uuid.UUID) -> Report:
    """Lock and return a report owned by the caller."""
    report = get_visible_report(ctx, report_id, lock=True)
    if report.owner_id != ctx.actor.id:
        raise Forbidden("not_report_owner", "Only the report's owner can do this.")
    return report


def ensure_version(report: Report, expected_version: int) -> None:
    if report.version != expected_version:
        raise Conflict(
            "version_conflict",
            "The report was changed by someone else. Reload and try again.",
            {"current_version": report.version},
        )


def touch(report: Report, ctx: ServiceContext) -> None:
    report.version += 1
    report.updated_at = ctx.now
