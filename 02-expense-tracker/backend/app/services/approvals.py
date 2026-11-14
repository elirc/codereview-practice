from collections.abc import Sequence

from sqlalchemy import Row, and_, func, or_, select
from sqlalchemy.orm import aliased, selectinload

from app.domain.enums import ReportStatus, Role, StepKind, StepStatus
from app.models import ApprovalStep, Report
from app.services.context import ServiceContext


def pending_for(
    ctx: ServiceContext, *, limit: int, offset: int
) -> Sequence[Row[tuple[Report, ApprovalStep]]]:
    """Submitted reports whose current step the caller could decide right now."""
    actor = ctx.actor
    if not actor.active or actor.role == Role.EMPLOYEE:
        return []

    current_position = (
        select(func.min(ApprovalStep.position))
        .where(
            ApprovalStep.report_id == Report.id,
            ApprovalStep.round == Report.round,
            ApprovalStep.status == StepStatus.PENDING,
        )
        .correlate(Report)
        .scalar_subquery()
    )

    decidable = and_(ApprovalStep.kind == StepKind.MANAGER, ApprovalStep.approver_id == actor.id)
    if actor.role == Role.FINANCE:
        earlier = aliased(ApprovalStep)
        decided_earlier = (
            select(earlier.id)
            .where(
                earlier.report_id == Report.id,
                earlier.round == Report.round,
                earlier.position < ApprovalStep.position,
                earlier.decided_by == actor.id,
            )
            .exists()
        )
        decidable = or_(decidable, and_(ApprovalStep.kind == StepKind.FINANCE, ~decided_earlier))

    stmt = (
        select(Report, ApprovalStep)
        .join(
            ApprovalStep,
            and_(
                ApprovalStep.report_id == Report.id,
                ApprovalStep.round == Report.round,
                ApprovalStep.position == current_position,
            ),
        )
        .where(Report.status == ReportStatus.SUBMITTED, Report.owner_id != actor.id, decidable)
        .options(selectinload(Report.owner))
        .order_by(Report.submitted_at, Report.id)
        .limit(limit)
        .offset(offset)
    )
    return ctx.db.execute(stmt).all()
