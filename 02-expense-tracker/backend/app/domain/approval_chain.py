import uuid
from collections.abc import Mapping
from dataclasses import dataclass

from app.domain.enums import Role, StepKind
from app.domain.errors import RuleViolation


@dataclass(frozen=True, slots=True)
class ChainMember:
    id: uuid.UUID
    role: str
    manager_id: uuid.UUID | None
    approval_limit_minor: int
    active: bool


@dataclass(frozen=True, slots=True)
class PlannedStep:
    position: int
    kind: StepKind
    approver_id: uuid.UUID | None


class NoEligibleApprover(RuleViolation):
    default_code = "no_eligible_approver"
    default_message = "No one is available to approve this report."


def _manager_approvers(
    owner: ChainMember, users: Mapping[uuid.UUID, ChainMember], total_base_minor: int
) -> list[uuid.UUID]:
    approvers: list[uuid.UUID] = []
    visited: set[uuid.UUID] = {owner.id}
    next_id = owner.manager_id
    while next_id is not None:
        if next_id in visited:
            raise ValueError("manager graph contains a cycle")
        visited.add(next_id)
        member = users.get(next_id)
        if member is None:
            break
        if member.active:
            approvers.append(member.id)
            if member.approval_limit_minor >= total_base_minor:
                break
        next_id = member.manager_id
    return approvers


def build_chain(
    owner_id: uuid.UUID, users: Mapping[uuid.UUID, ChainMember], total_base_minor: int
) -> list[PlannedStep]:
    """Plan the approval steps for one submission round.

    Manager steps walk up from the owner's manager until someone's limit covers
    the total or the top of the reporting line is reached; one finance step
    follows. `users` needs the owner, their reporting line and the finance users.
    """
    owner = users[owner_id]
    has_finance_approver = any(
        member.role == Role.FINANCE and member.active and member.id != owner_id
        for member in users.values()
    )
    if not has_finance_approver:
        raise NoEligibleApprover()

    steps = [
        PlannedStep(position=index, kind=StepKind.MANAGER, approver_id=approver_id)
        for index, approver_id in enumerate(
            _manager_approvers(owner, users, total_base_minor), start=1
        )
    ]
    steps.append(PlannedStep(position=len(steps) + 1, kind=StepKind.FINANCE, approver_id=None))
    return steps
