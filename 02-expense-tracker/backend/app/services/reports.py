import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.domain.enums import ReportStatus
from app.domain.errors import InvalidTransition, NotFound
from app.domain.state_machine import ensure_editable
from app.models import ExpenseLine, Report
from app.schemas.reports import LineCreate, LineUpdate, OwnerScope
from app.services import audit, receipts
from app.services.access import ensure_version, get_own_report, touch, visible_reports_clause
from app.services.context import ServiceContext

REPORT_AUDIT_FIELDS = ("title", "status", "round", "version")
LINE_AUDIT_FIELDS = (
    "expense_date",
    "category",
    "description",
    "amount_minor",
    "currency",
    "receipt_id",
)
LINE_EDITABLE_FIELDS = ("expense_date", "category", "description", "amount_minor", "currency")


def create_report(ctx: ServiceContext, title: str) -> Report:
    report = Report(
        id=uuid.uuid4(),
        owner_id=ctx.actor.id,
        title=title,
        status=ReportStatus.DRAFT,
        round=0,
        version=1,
        created_at=ctx.now,
        updated_at=ctx.now,
    )
    ctx.db.add(report)
    audit.record(
        ctx,
        entity_type="report",
        entity_id=report.id,
        report_id=report.id,
        action="report.created",
        after=audit.snapshot(report, REPORT_AUDIT_FIELDS),
    )
    ctx.db.commit()
    return report


def list_reports(
    ctx: ServiceContext,
    *,
    owner: OwnerScope,
    status: ReportStatus | None,
    limit: int,
    offset: int,
) -> Sequence[Report]:
    stmt = select(Report).options(selectinload(Report.owner))
    if owner == "me":
        stmt = stmt.where(Report.owner_id == ctx.actor.id)
    else:
        stmt = stmt.where(visible_reports_clause(ctx.actor))
    if status is not None:
        stmt = stmt.where(Report.status == status)
    stmt = stmt.order_by(Report.created_at.desc(), Report.id).limit(limit).offset(offset)
    return ctx.db.scalars(stmt).all()


def _editable_own_report(
    ctx: ServiceContext, report_id: uuid.UUID, expected_version: int | None
) -> Report:
    report = get_own_report(ctx, report_id)
    ensure_editable(report.status)
    if expected_version is not None:
        ensure_version(report, expected_version)
    return report


def update_report(
    ctx: ServiceContext, report_id: uuid.UUID, *, title: str, expected_version: int
) -> None:
    report = _editable_own_report(ctx, report_id, expected_version)
    before = audit.snapshot(report, REPORT_AUDIT_FIELDS)
    report.title = title
    touch(report, ctx)
    old, new = audit.changed_fields(before, audit.snapshot(report, REPORT_AUDIT_FIELDS))
    audit.record(
        ctx,
        entity_type="report",
        entity_id=report.id,
        report_id=report.id,
        action="report.updated",
        before=old,
        after=new,
    )
    ctx.db.commit()


def delete_report(ctx: ServiceContext, report_id: uuid.UUID) -> None:
    report = _editable_own_report(ctx, report_id, None)
    if report.round != 0:
        raise InvalidTransition(message="Reports that have been submitted cannot be deleted.")
    audit.record(
        ctx,
        entity_type="report",
        entity_id=report.id,
        report_id=report.id,
        action="report.deleted",
        before=audit.snapshot(report, REPORT_AUDIT_FIELDS),
    )
    ctx.db.delete(report)
    ctx.db.commit()


def _line_of(ctx: ServiceContext, report: Report, line_id: uuid.UUID) -> ExpenseLine:
    line = ctx.db.scalars(
        select(ExpenseLine).where(ExpenseLine.id == line_id, ExpenseLine.report_id == report.id)
    ).one_or_none()
    if line is None:
        raise NotFound()
    return line


def add_line(ctx: ServiceContext, report_id: uuid.UUID, data: LineCreate) -> ExpenseLine:
    report = _editable_own_report(ctx, report_id, data.expected_version)
    line = ExpenseLine(
        id=uuid.uuid4(),
        report_id=report.id,
        expense_date=data.expense_date,
        category=data.category,
        description=data.description,
        amount_minor=data.amount_minor,
        currency=data.currency,
        created_at=ctx.now,
        updated_at=ctx.now,
    )
    ctx.db.add(line)
    attached = receipts.attach_to_line(ctx, line, data.receipt_id)
    touch(report, ctx)
    audit.record(
        ctx,
        entity_type="line",
        entity_id=line.id,
        report_id=report.id,
        action="line.added",
        after=audit.snapshot(line, LINE_AUDIT_FIELDS),
    )
    if attached:
        receipts.record_attachment(ctx, report, line)
    receipts.commit_attachment(ctx)
    return line


def update_line(
    ctx: ServiceContext, report_id: uuid.UUID, line_id: uuid.UUID, data: LineUpdate
) -> ExpenseLine:
    report = _editable_own_report(ctx, report_id, data.expected_version)
    line = _line_of(ctx, report, line_id)
    before = audit.snapshot(line, LINE_AUDIT_FIELDS)

    for name in LINE_EDITABLE_FIELDS:
        if name in data.model_fields_set:
            setattr(line, name, getattr(data, name))
    attached = "receipt_id" in data.model_fields_set and receipts.attach_to_line(
        ctx, line, data.receipt_id
    )

    old, new = audit.changed_fields(before, audit.snapshot(line, LINE_AUDIT_FIELDS))
    touch(report, ctx)
    if new:
        line.updated_at = ctx.now
        audit.record(
            ctx,
            entity_type="line",
            entity_id=line.id,
            report_id=report.id,
            action="line.updated",
            before=old,
            after=new,
        )
    if attached:
        receipts.record_attachment(ctx, report, line)
    receipts.commit_attachment(ctx)
    return line


def remove_line(
    ctx: ServiceContext, report_id: uuid.UUID, line_id: uuid.UUID, expected_version: int
) -> None:
    report = _editable_own_report(ctx, report_id, expected_version)
    line = _line_of(ctx, report, line_id)
    audit.record(
        ctx,
        entity_type="line",
        entity_id=line.id,
        report_id=report.id,
        action="line.removed",
        before=audit.snapshot(line, LINE_AUDIT_FIELDS),
    )
    ctx.db.delete(line)
    touch(report, ctx)
    ctx.db.commit()
