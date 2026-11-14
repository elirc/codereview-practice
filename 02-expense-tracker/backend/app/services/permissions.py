from app.domain.enums import ReportStatus, Role, StepKind, StepStatus
from app.domain.errors import DomainError, Forbidden
from app.models import ApprovalStep, Report, User


def round_steps(report: Report) -> list[ApprovalStep]:
    return sorted(
        (step for step in report.steps if step.round == report.round),
        key=lambda step: step.position,
    )


def current_step(report: Report) -> ApprovalStep | None:
    """The lowest-position pending step of the current round of a submitted report."""
    if report.status != ReportStatus.SUBMITTED:
        return None
    for step in round_steps(report):
        if step.status == StepStatus.PENDING:
            return step
    return None


def round_untouched(report: Report) -> bool:
    return all(step.status == StepStatus.PENDING for step in round_steps(report))


def decision_error(actor: User, report: Report, step: ApprovalStep) -> DomainError | None:
    """Why `actor` may not decide `step` (the current step), or None if they may."""
    if actor.id == report.owner_id:
        return Forbidden("self_approval", "You cannot decide on your own report.")
    if not actor.active:
        return Forbidden("not_step_approver", "You are not the approver for this step.")

    if step.kind == StepKind.MANAGER:
        if step.approver_id != actor.id or actor.role == Role.EMPLOYEE:
            return Forbidden("not_step_approver", "You are not the approver for this step.")
        return None

    if actor.role != Role.FINANCE:
        return Forbidden("not_step_approver", "Only finance can decide this step.")
    decided_earlier = any(
        s.position < step.position and s.decided_by == actor.id for s in round_steps(report)
    )
    if decided_earlier:
        return Forbidden(
            "separation_of_duties",
            "You already decided an earlier step of this report.",
        )
    return None


def reimburse_error(actor: User, report: Report) -> DomainError | None:
    if actor.id == report.owner_id:
        return Forbidden("self_approval", "You cannot reimburse your own report.")
    if actor.role != Role.FINANCE or not actor.active:
        return Forbidden("forbidden", "Only finance can reimburse reports.")
    return None


def capabilities(actor: User, report: Report) -> dict[str, bool]:
    """What the caller may do with the report right now, for driving the UI."""
    owner = actor.id == report.owner_id
    status = report.status
    step = current_step(report)
    return {
        "edit": owner and status == ReportStatus.DRAFT,
        "submit": owner and status == ReportStatus.DRAFT,
        "withdraw": owner and status == ReportStatus.SUBMITTED and round_untouched(report),
        "decide": step is not None and decision_error(actor, report, step) is None,
        "reopen": owner and status == ReportStatus.REJECTED,
        "reimburse": status == ReportStatus.APPROVED and reimburse_error(actor, report) is None,
    }
