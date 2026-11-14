from enum import StrEnum

from app.domain.enums import ReportStatus
from app.domain.errors import InvalidTransition


class ReportAction(StrEnum):
    SUBMIT = "submit"
    WITHDRAW = "withdraw"
    APPROVE_STEP = "approve_step"
    APPROVE_FINAL_STEP = "approve_final_step"
    REJECT_STEP = "reject_step"
    REOPEN = "reopen"
    REIMBURSE = "reimburse"


TRANSITIONS: dict[tuple[ReportStatus, ReportAction], ReportStatus] = {
    (ReportStatus.DRAFT, ReportAction.SUBMIT): ReportStatus.SUBMITTED,
    (ReportStatus.SUBMITTED, ReportAction.WITHDRAW): ReportStatus.DRAFT,
    (ReportStatus.SUBMITTED, ReportAction.APPROVE_STEP): ReportStatus.SUBMITTED,
    (ReportStatus.SUBMITTED, ReportAction.APPROVE_FINAL_STEP): ReportStatus.APPROVED,
    (ReportStatus.SUBMITTED, ReportAction.REJECT_STEP): ReportStatus.REJECTED,
    (ReportStatus.REJECTED, ReportAction.REOPEN): ReportStatus.DRAFT,
    (ReportStatus.APPROVED, ReportAction.REIMBURSE): ReportStatus.REIMBURSED,
}

EDITABLE_STATUSES = frozenset({ReportStatus.DRAFT})


def can_transition(current: str, action: ReportAction) -> bool:
    return (ReportStatus(current), action) in TRANSITIONS


def next_status(current: str, action: ReportAction) -> ReportStatus:
    """Return the status reached by applying `action`, or raise InvalidTransition."""
    try:
        return TRANSITIONS[(ReportStatus(current), action)]
    except KeyError:
        raise InvalidTransition(details={"status": str(current), "action": action.value}) from None


def is_editable(current: str) -> bool:
    return ReportStatus(current) in EDITABLE_STATUSES


def ensure_editable(current: str) -> None:
    if not is_editable(current):
        raise InvalidTransition(
            message="Only draft reports can be changed.", details={"status": str(current)}
        )
