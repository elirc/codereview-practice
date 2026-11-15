import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import Ctx, Page
from app.domain.enums import StepKind
from app.schemas.common import Paginated
from app.schemas.users import UserSummary
from app.schemas.workflow import (
    AuditEntityType,
    AuditEventOut,
    BulkApproveIn,
    BulkApproveOut,
    PendingApprovalOut,
)
from app.services import approvals, audit_log, report_views, workflow

router = APIRouter(tags=["approvals"])


@router.get("/approvals/pending")
def pending_approvals(ctx: Ctx, page: Page) -> Paginated[PendingApprovalOut]:
    rows = approvals.pending_for(ctx, limit=page.limit, offset=page.offset)
    items = [
        PendingApprovalOut(
            **report_views.summary_out(report, ctx.base_currency).model_dump(),
            current_step_id=step.id,
            current_step_kind=StepKind(step.kind),
            current_step_position=step.position,
        )
        for report, step in rows
    ]
    return Paginated[PendingApprovalOut](items=items, limit=page.limit, offset=page.offset)


@router.post("/approvals/approve")
def approve_pending(ctx: Ctx, body: BulkApproveIn) -> BulkApproveOut:
    approved = workflow.approve_many(ctx, body.items, body.comment)
    return BulkApproveOut(approved=approved)


@router.get("/audit")
def audit_events(
    ctx: Ctx,
    page: Page,
    entity_type: Annotated[AuditEntityType | None, Query()] = None,
    entity_id: Annotated[uuid.UUID | None, Query()] = None,
) -> Paginated[AuditEventOut]:
    rows = audit_log.list_events(
        ctx,
        entity_type=entity_type,
        entity_id=entity_id,
        limit=page.limit,
        offset=page.offset,
    )
    items = [
        AuditEventOut(
            id=event.id,
            at=event.at,
            actor=(
                UserSummary(id=event.actor_id, full_name=actor_name)
                if event.actor_id is not None and actor_name is not None
                else None
            ),
            request_id=event.request_id,
            entity_type=event.entity_type,
            entity_id=event.entity_id,
            report_id=event.report_id,
            action=event.action,
            before=event.before,
            after=event.after,
        )
        for event, actor_name in rows
    ]
    return Paginated[AuditEventOut](items=items, limit=page.limit, offset=page.offset)
