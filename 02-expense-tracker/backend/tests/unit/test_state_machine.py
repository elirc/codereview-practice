import itertools

import pytest

from app.domain.enums import ReportStatus
from app.domain.errors import InvalidTransition
from app.domain.state_machine import ReportAction, ensure_editable, next_status

S = ReportStatus
A = ReportAction

LEGAL = {
    (S.DRAFT, A.SUBMIT): S.SUBMITTED,
    (S.SUBMITTED, A.WITHDRAW): S.DRAFT,
    (S.SUBMITTED, A.APPROVE_STEP): S.SUBMITTED,
    (S.SUBMITTED, A.APPROVE_FINAL_STEP): S.APPROVED,
    (S.SUBMITTED, A.REJECT_STEP): S.REJECTED,
    (S.REJECTED, A.REOPEN): S.DRAFT,
    (S.APPROVED, A.REIMBURSE): S.REIMBURSED,
}

ILLEGAL = [pair for pair in itertools.product(S, A) if pair not in LEGAL]


@pytest.mark.parametrize(("pair", "expected"), list(LEGAL.items()))
def test_legal_transitions(pair: tuple[ReportStatus, ReportAction], expected: ReportStatus) -> None:
    status, action = pair

    assert next_status(status, action) == expected


@pytest.mark.parametrize(("status", "action"), ILLEGAL)
def test_every_other_transition_is_rejected(status: ReportStatus, action: ReportAction) -> None:
    with pytest.raises(InvalidTransition) as excinfo:
        next_status(status, action)

    assert excinfo.value.code == "invalid_state"


def test_reimbursed_is_terminal() -> None:
    for action in A:
        with pytest.raises(InvalidTransition):
            next_status(S.REIMBURSED, action)


def test_only_drafts_are_editable() -> None:
    ensure_editable(S.DRAFT)
    for status in (S.SUBMITTED, S.APPROVED, S.REJECTED, S.REIMBURSED):
        with pytest.raises(InvalidTransition):
            ensure_editable(status)
