import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.logging import get_logger
from app.domain.approval_chain import ChainMember, build_chain
from app.domain.conversion import Conversion
from app.domain.enums import ReportStatus, Role, StepKind, StepStatus
from app.domain.errors import InvalidTransition, NotFound, RuleViolation
from app.domain.money import Money
from app.domain.policy import requires_receipt
from app.domain.state_machine import ReportAction, next_status
from app.models import ApprovalStep, ExpenseLine, Reimbursement, Report, User
from app.services import audit
from app.services.access import (
    ensure_role,
    ensure_version,
    get_own_report,
    get_visible_report,
    touch,
)
from app.services.context import ServiceContext
from app.services.conversions import convert_lines
from app.services.permissions import (
    current_step,
    decision_error,
    reimburse_error,
    round_steps,
    round_untouched,
)

log = get_logger(__name__)

REPORT_WORKFLOW_FIELDS = ("status", "round", "version", "total_base_minor")
STEP_AUDIT_FIELDS = ("status", "decided_by", "comment")


def _report_event(
    ctx: ServiceContext, report: Report, action: str, before: audit.JsonDict
) -> None:
    old, new = audit.changed_fields(before, audit.snapshot(report, REPORT_WORKFLOW_FIELDS))
    audit.record(
        ctx,
        entity_type="report",
        entity_id=report.id,
        report_id=report.id,
        action=action,
        before=old,
        after=new,
    )


def _chain_directory(ctx: ServiceContext) -> dict[uuid.UUID, ChainMember]:
    rows = ctx.db.execute(
        select(User.id, User.role, User.manager_id, User.approval_limit_minor, User.active)
    )
    return {
        row.id: ChainMember(
            id=row.id,
            role=row.role,
            manager_id=row.manager_id,
            approval_limit_minor=row.approval_limit_minor,
            active=row.active,
        )
        for row in rows
    }


def _unfreeze(report: Report) -> None:
    for line in report.lines:
        line.rate_used = None
        line.rate_effective_date = None
        line.base_amount_minor = None
    report.total_base_minor = None
    report.submitted_at = None
    report.decided_at = None


def submit(ctx: ServiceContext, report_id: uuid.UUID, expected_version: int) -> None:
    report = get_own_report(ctx, report_id)
    new_status = next_status(report.status, ReportAction.SUBMIT)
    ensure_version(report, expected_version)

    lines = list(report.lines)
    if not lines:
        raise RuleViolation("empty_report", "Add at least one expense line before submitting.")

    conversions = convert_lines(ctx.db, lines, ctx.base_currency, lock=True)
    converted: list[tuple[ExpenseLine, Conversion]] = []
    missing: list[str] = []
    for line in lines:
        conv = conversions[line.id]
        if conv is None:
            missing.append(str(line.id))
        else:
            converted.append((line, conv))
    if missing:
        raise RuleViolation(
            "missing_exchange_rate",
            "No exchange rate covers the date of some lines.",
            {"line_ids": missing},
        )

    unreceipted = [
        str(line.id)
        for line, conv in converted
        if requires_receipt(conv.base.amount_minor) and line.receipt_id is None
    ]
    if unreceipted:
        raise RuleViolation(
            "receipt_required", "Some lines need a receipt.", {"line_ids": unreceipted}
        )

    total = Money.total((conv.base for _, conv in converted), ctx.base_currency)
    chain = build_chain(report.owner_id, _chain_directory(ctx), total.amount_minor)

    before = audit.snapshot(report, REPORT_WORKFLOW_FIELDS)
    for line, conv in converted:
        line.rate_used = conv.rate
        line.rate_effective_date = conv.effective_date
        line.base_amount_minor = conv.base.amount_minor
    report.total_base_minor = total.amount_minor
    report.round += 1
    report.status = new_status
    report.submitted_at = ctx.now
    report.decided_at = None
    touch(report, ctx)
    for planned in chain:
        ctx.db.add(
            ApprovalStep(
                id=uuid.uuid4(),
                report_id=report.id,
                round=report.round,
                position=planned.position,
                kind=planned.kind,
                approver_id=planned.approver_id,
                status=StepStatus.PENDING,
                created_at=ctx.now,
            )
        )
    _report_event(ctx, report, "report.submitted", before)
    ctx.db.commit()
    log.info("report_submitted", report_id=str(report.id), round=report.round, steps=len(chain))


def withdraw(ctx: ServiceContext, report_id: uuid.UUID, expected_version: int) -> None:
    report = get_own_report(ctx, report_id)
    new_status = next_status(report.status, ReportAction.WITHDRAW)
    ensure_version(report, expected_version)
    if not round_untouched(report):
        raise InvalidTransition(
            message="The report can no longer be withdrawn because a step has been decided."
        )

    before = audit.snapshot(report, REPORT_WORKFLOW_FIELDS)
    for step in round_steps(report):
        step.status = StepStatus.SKIPPED
    _unfreeze(report)
    report.status = new_status
    touch(report, ctx)
    _report_event(ctx, report, "report.withdrawn", before)
    ctx.db.commit()


def reopen(ctx: ServiceContext, report_id: uuid.UUID, expected_version: int) -> None:
    report = get_own_report(ctx, report_id)
    new_status = next_status(report.status, ReportAction.REOPEN)
    ensure_version(report, expected_version)

    before = audit.snapshot(report, REPORT_WORKFLOW_FIELDS)
    _unfreeze(report)
    report.status = new_status
    touch(report, ctx)
    _report_event(ctx, report, "report.reopened", before)
    ctx.db.commit()


def _step_of(report: Report, step_id: uuid.UUID) -> ApprovalStep:
    for step in report.steps:
        if step.id == step_id:
            return step
    raise NotFound("not_found", "Step not found.")


def decide(
    ctx: ServiceContext,
    report_id: uuid.UUID,
    step_id: uuid.UUID,
    *,
    approve: bool,
    expected_version: int,
    comment: str | None,
) -> None:
    report = get_visible_report(ctx, report_id, lock=True)
    next_status(report.status, ReportAction.APPROVE_STEP if approve else ReportAction.REJECT_STEP)
    ensure_version(report, expected_version)

    step = _step_of(report, step_id)
    current = current_step(report)
    if current is None or current.id != step.id:
        raise InvalidTransition("not_current_step", "This step is not awaiting a decision.")
    error = decision_error(ctx.actor, report, step)
    if error is not None:
        raise error

    before_report = audit.snapshot(report, REPORT_WORKFLOW_FIELDS)
    before_step = audit.snapshot(step, STEP_AUDIT_FIELDS)
    step.decided_by = ctx.actor.id
    step.decided_at = ctx.now
    step.comment = comment
    later = [s for s in round_steps(report) if s.position > step.position]

    if approve:
        step.status = StepStatus.APPROVED
        final = not any(s.status == StepStatus.PENDING for s in later)
        report.status = next_status(
            report.status,
            ReportAction.APPROVE_FINAL_STEP if final else ReportAction.APPROVE_STEP,
        )
        if final:
            report.decided_at = ctx.now
        action = "step.approved"
    else:
        step.status = StepStatus.REJECTED
        for s in later:
            s.status = StepStatus.SKIPPED
        report.status = next_status(report.status, ReportAction.REJECT_STEP)
        report.decided_at = ctx.now
        action = "step.rejected"
    touch(report, ctx)

    old, new = audit.changed_fields(before_step, audit.snapshot(step, STEP_AUDIT_FIELDS))
    audit.record(
        ctx,
        entity_type="step",
        entity_id=step.id,
        report_id=report.id,
        action=action,
        before=old,
        after=new,
    )
    _report_event(ctx, report, action, before_report)
    ctx.db.commit()
    log.info(action.replace(".", "_"), report_id=str(report.id), step_id=str(step.id))


def _reassignment_allowed(ctx: ServiceContext, previous: User, candidate: User | None) -> bool:
    if candidate is None or not candidate.active:
        return False
    previous_manager = (
        ctx.db.get(User, previous.manager_id) if previous.manager_id is not None else None
    )
    if previous_manager is not None and previous_manager.active:
        return candidate.id == previous_manager.id and candidate.role != Role.EMPLOYEE
    return candidate.role == Role.MANAGER


def reassign(
    ctx: ServiceContext, report_id: uuid.UUID, step_id: uuid.UUID, approver_id: uuid.UUID
) -> None:
    ensure_role(ctx.actor, Role.ADMIN)
    report = get_visible_report(ctx, report_id, lock=True)
    if report.status != ReportStatus.SUBMITTED:
        raise InvalidTransition()
    step = _step_of(report, step_id)
    if (
        step.round != report.round
        or step.kind != StepKind.MANAGER
        or step.status != StepStatus.PENDING
    ):
        raise InvalidTransition(
            message="Only pending manager steps of the current round can be reassigned."
        )
    previous = ctx.db.get(User, step.approver_id) if step.approver_id is not None else None
    if previous is None or previous.active:
        raise RuleViolation("approver_active", "The step's approver is still active.")

    candidate = ctx.db.get(User, approver_id)
    others = {s.approver_id for s in round_steps(report) if s.id != step.id}
    if (
        not _reassignment_allowed(ctx, previous, candidate)
        or approver_id == report.owner_id
        or approver_id in others
    ):
        raise RuleViolation(
            "invalid_reassignment", "That user cannot take over this approval step."
        )

    step.approver_id = approver_id
    touch(report, ctx)
    audit.record(
        ctx,
        entity_type="step",
        entity_id=step.id,
        report_id=report.id,
        action="step.reassigned",
        before={"approver_id": str(previous.id)},
        after={"approver_id": str(approver_id)},
    )
    ctx.db.commit()


def reimburse(
    ctx: ServiceContext, report_id: uuid.UUID, *, expected_version: int, payment_reference: str
) -> None:
    report = get_visible_report(ctx, report_id, lock=True)
    new_status = next_status(report.status, ReportAction.REIMBURSE)
    ensure_version(report, expected_version)
    error = reimburse_error(ctx.actor, report)
    if error is not None:
        raise error
    if report.total_base_minor is None:
        raise InvalidTransition(message="The report has no approved total.")

    before = audit.snapshot(report, REPORT_WORKFLOW_FIELDS)
    reimbursement = Reimbursement(
        id=uuid.uuid4(),
        report_id=report.id,
        amount_base_minor=report.total_base_minor,
        currency=ctx.base_currency,
        payment_reference=payment_reference,
        paid_by=ctx.actor.id,
        paid_at=ctx.now,
    )
    ctx.db.add(reimbursement)
    report.status = new_status
    touch(report, ctx)
    old, new = audit.changed_fields(before, audit.snapshot(report, REPORT_WORKFLOW_FIELDS))
    audit.record(
        ctx,
        entity_type="report",
        entity_id=report.id,
        report_id=report.id,
        action="report.reimbursed",
        before=old,
        after={
            **new,
            "amount_base_minor": reimbursement.amount_base_minor,
            "payment_reference": payment_reference,
        },
    )
    try:
        ctx.db.commit()
    except IntegrityError as exc:
        ctx.db.rollback()
        if "uq_reimbursements_report_id" in str(exc.orig):
            raise InvalidTransition(message="The report has already been reimbursed.") from None
        raise
    log.info("report_reimbursed", report_id=str(report.id))
