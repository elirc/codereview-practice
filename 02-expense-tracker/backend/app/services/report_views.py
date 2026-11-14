import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.domain.enums import ExpenseCategory, ReportStatus, StepKind, StepStatus
from app.domain.policy import requires_receipt
from app.domain.state_machine import is_editable
from app.models import ApprovalStep, ExpenseLine, Report, User
from app.schemas.money import rate_text
from app.schemas.reports import (
    Capabilities,
    LineOut,
    ReimbursementOut,
    ReportDetailOut,
    ReportSummaryOut,
    StepOut,
)
from app.schemas.users import UserSummary
from app.services.access import get_visible_report
from app.services.context import ServiceContext
from app.services.conversions import convert_lines
from app.services.permissions import capabilities, current_step

DETAIL_OPTIONS = (
    selectinload(Report.owner),
    selectinload(Report.lines),
    selectinload(Report.steps).selectinload(ApprovalStep.approver),
    selectinload(Report.steps).selectinload(ApprovalStep.decider),
    selectinload(Report.reimbursement),
)


def _summary(user: User | None) -> UserSummary | None:
    return UserSummary.model_validate(user) if user is not None else None


def summary_out(report: Report, base_currency: str) -> ReportSummaryOut:
    return ReportSummaryOut(
        id=report.id,
        title=report.title,
        status=ReportStatus(report.status),
        owner=UserSummary.model_validate(report.owner),
        round=report.round,
        version=report.version,
        total_base_minor=report.total_base_minor,
        base_currency=base_currency,
        submitted_at=report.submitted_at,
        decided_at=report.decided_at,
        created_at=report.created_at,
        updated_at=report.updated_at,
    )


def _line_estimates(ctx: ServiceContext, report: Report) -> dict[uuid.UUID, int | None]:
    if is_editable(report.status):
        conversions = convert_lines(ctx.db, report.lines, ctx.base_currency)
        return {
            line_id: (conv.base.amount_minor if conv is not None else None)
            for line_id, conv in conversions.items()
        }
    return {line.id: line.base_amount_minor for line in report.lines}


def _line_out(line: ExpenseLine, estimate: int | None) -> LineOut:
    return LineOut(
        id=line.id,
        expense_date=line.expense_date,
        category=ExpenseCategory(line.category),
        description=line.description,
        amount_minor=line.amount_minor,
        currency=line.currency,
        receipt_id=line.receipt_id,
        rate_used=rate_text(line.rate_used) if line.rate_used is not None else None,
        rate_effective_date=line.rate_effective_date,
        base_amount_minor=line.base_amount_minor,
        estimated_base_minor=estimate,
        needs_receipt=(
            estimate is not None and requires_receipt(estimate) and line.receipt_id is None
        ),
    )


def _step_out(step: ApprovalStep) -> StepOut:
    return StepOut(
        id=step.id,
        round=step.round,
        position=step.position,
        kind=StepKind(step.kind),
        status=StepStatus(step.status),
        approver=_summary(step.approver),
        decided_by=_summary(step.decider),
        decided_at=step.decided_at,
        comment=step.comment,
    )


def _total(estimates: Sequence[int | None]) -> int | None:
    if any(value is None for value in estimates):
        return None
    return sum(value for value in estimates if value is not None)


def report_detail(ctx: ServiceContext, report_id: uuid.UUID) -> ReportDetailOut:
    """Load a report the caller may view, with lines, all rounds' steps and estimates."""
    get_visible_report(ctx, report_id)
    ctx.db.expire_all()
    report = ctx.db.scalars(
        select(Report)
        .where(Report.id == report_id)
        .options(*DETAIL_OPTIONS)
        .execution_options(populate_existing=True)
    ).one()

    estimates = _line_estimates(ctx, report)
    estimated_total = (
        _total(list(estimates.values()))
        if is_editable(report.status)
        else report.total_base_minor
    )
    step = current_step(report)
    summary = summary_out(report, ctx.base_currency)
    return ReportDetailOut(
        **summary.model_dump(),
        estimated_total_base_minor=estimated_total,
        lines=[_line_out(line, estimates.get(line.id)) for line in report.lines],
        steps=[_step_out(s) for s in report.steps],
        current_step_id=step.id if step is not None else None,
        reimbursement=(
            ReimbursementOut.model_validate(report.reimbursement, from_attributes=True)
            if report.reimbursement is not None
            else None
        ),
        can=Capabilities(**capabilities(ctx.actor, report)),
    )
