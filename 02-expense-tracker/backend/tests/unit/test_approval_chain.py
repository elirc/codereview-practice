import uuid

import pytest

from app.domain.approval_chain import ChainMember, NoEligibleApprover, PlannedStep, build_chain
from app.domain.enums import StepKind


def member(
    role: str = "employee",
    manager: ChainMember | None = None,
    limit: int = 0,
    active: bool = True,
) -> ChainMember:
    return ChainMember(
        id=uuid.uuid4(),
        role=role,
        manager_id=manager.id if manager else None,
        approval_limit_minor=limit,
        active=active,
    )


def directory(*members: ChainMember) -> dict[uuid.UUID, ChainMember]:
    return {m.id: m for m in members}


def manager_ids(steps: list[PlannedStep]) -> list[uuid.UUID | None]:
    return [s.approver_id for s in steps if s.kind == StepKind.MANAGER]


def test_owner_without_manager_gets_finance_step_only() -> None:
    finance = member("finance")
    owner = member()

    steps = build_chain(owner.id, directory(owner, finance), 10_000)

    assert steps == [PlannedStep(position=1, kind=StepKind.FINANCE, approver_id=None)]


def test_first_manager_with_sufficient_limit_ends_manager_steps() -> None:
    director = member("manager", limit=1_000_000)
    lead = member("manager", manager=director, limit=50_000)
    owner = member(manager=lead)
    finance = member("finance")

    steps = build_chain(owner.id, directory(director, lead, owner, finance), 50_000)

    assert manager_ids(steps) == [lead.id]
    assert [s.position for s in steps] == [1, 2]
    assert steps[-1].kind == StepKind.FINANCE


def test_escalates_to_second_level_when_limit_is_below_total() -> None:
    director = member("manager", limit=0)
    lead = member("manager", manager=director, limit=10_000)
    owner = member(manager=lead)
    finance = member("finance")

    steps = build_chain(owner.id, directory(director, lead, owner, finance), 25_000)

    assert manager_ids(steps) == [lead.id, director.id]
    assert [s.kind for s in steps] == [StepKind.MANAGER, StepKind.MANAGER, StepKind.FINANCE]


def test_escalates_to_third_level() -> None:
    vp = member("manager", limit=10_000_000)
    director = member("manager", manager=vp, limit=100_000)
    lead = member("manager", manager=director, limit=10_000)
    owner = member(manager=lead)
    finance = member("finance")

    steps = build_chain(owner.id, directory(vp, director, lead, owner, finance), 500_000)

    assert manager_ids(steps) == [lead.id, director.id, vp.id]
    assert [s.position for s in steps] == [1, 2, 3, 4]


def test_top_of_chain_is_sufficient_regardless_of_limit() -> None:
    director = member("manager", limit=100)
    owner = member(manager=director)
    finance = member("finance")

    steps = build_chain(owner.id, directory(director, owner, finance), 9_999_999)

    assert manager_ids(steps) == [director.id]


def test_inactive_manager_is_skipped() -> None:
    director = member("manager", limit=1_000_000)
    lead = member("manager", manager=director, limit=1_000_000, active=False)
    owner = member(manager=lead)
    finance = member("finance")

    steps = build_chain(owner.id, directory(director, lead, owner, finance), 5_000)

    assert manager_ids(steps) == [director.id]


def test_owner_who_is_finance_needs_another_finance_user() -> None:
    owner = member("finance")
    other_finance = member("finance")

    steps = build_chain(owner.id, directory(owner, other_finance), 5_000)

    assert steps[-1].kind == StepKind.FINANCE


def test_no_eligible_finance_user_raises() -> None:
    owner = member("finance")
    inactive_finance = member("finance", active=False)
    manager = member("manager", limit=1_000_000)

    with pytest.raises(NoEligibleApprover) as excinfo:
        build_chain(owner.id, directory(owner, inactive_finance, manager), 5_000)

    assert excinfo.value.code == "no_eligible_approver"


def test_finance_manager_still_counts_as_manager_step() -> None:
    finance_lead = member("finance", limit=1_000_000)
    owner = member(manager=finance_lead)

    steps = build_chain(owner.id, directory(finance_lead, owner), 5_000)

    assert manager_ids(steps) == [finance_lead.id]
    assert steps[-1].kind == StepKind.FINANCE
