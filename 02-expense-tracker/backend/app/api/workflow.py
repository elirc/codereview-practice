import uuid

from fastapi import APIRouter

from app.api.deps import Ctx
from app.schemas.common import VersionedAction
from app.schemas.reports import ReportDetailOut
from app.schemas.workflow import ApproveIn, ReassignIn, RejectIn, ReimburseIn
from app.services import report_views, workflow

router = APIRouter(prefix="/reports/{report_id}", tags=["workflow"])


@router.post("/submit")
def submit(ctx: Ctx, report_id: uuid.UUID, body: VersionedAction) -> ReportDetailOut:
    workflow.submit(ctx, report_id, body.expected_version)
    return report_views.report_detail(ctx, report_id)


@router.post("/withdraw")
def withdraw(ctx: Ctx, report_id: uuid.UUID, body: VersionedAction) -> ReportDetailOut:
    workflow.withdraw(ctx, report_id, body.expected_version)
    return report_views.report_detail(ctx, report_id)


@router.post("/reopen")
def reopen(ctx: Ctx, report_id: uuid.UUID, body: VersionedAction) -> ReportDetailOut:
    workflow.reopen(ctx, report_id, body.expected_version)
    return report_views.report_detail(ctx, report_id)


@router.post("/steps/{step_id}/approve")
def approve_step(
    ctx: Ctx, report_id: uuid.UUID, step_id: uuid.UUID, body: ApproveIn
) -> ReportDetailOut:
    workflow.decide(
        ctx,
        report_id,
        step_id,
        approve=True,
        expected_version=body.expected_version,
        comment=body.comment,
    )
    return report_views.report_detail(ctx, report_id)


@router.post("/steps/{step_id}/reject")
def reject_step(
    ctx: Ctx, report_id: uuid.UUID, step_id: uuid.UUID, body: RejectIn
) -> ReportDetailOut:
    workflow.decide(
        ctx,
        report_id,
        step_id,
        approve=False,
        expected_version=body.expected_version,
        comment=body.comment,
    )
    return report_views.report_detail(ctx, report_id)


@router.post("/steps/{step_id}/reassign")
def reassign_step(
    ctx: Ctx, report_id: uuid.UUID, step_id: uuid.UUID, body: ReassignIn
) -> ReportDetailOut:
    workflow.reassign(ctx, report_id, step_id, body.approver_id)
    return report_views.report_detail(ctx, report_id)


@router.post("/reimburse")
def reimburse(ctx: Ctx, report_id: uuid.UUID, body: ReimburseIn) -> ReportDetailOut:
    workflow.reimburse(
        ctx,
        report_id,
        expected_version=body.expected_version,
        payment_reference=body.payment_reference,
    )
    return report_views.report_detail(ctx, report_id)
