import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import Ctx, Page
from app.api.validators import ensure_expense_date_allowed, ensure_known_currency
from app.domain.enums import ReportStatus
from app.schemas.common import Paginated
from app.schemas.reports import (
    LineCreate,
    LineUpdate,
    OwnerScope,
    ReportCreate,
    ReportDetailOut,
    ReportSummaryOut,
    ReportUpdate,
)
from app.services import report_views
from app.services import reports as reports_service

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("")
def list_reports(
    ctx: Ctx,
    page: Page,
    status_filter: Annotated[ReportStatus | None, Query(alias="status")] = None,
    owner: OwnerScope = "me",
) -> Paginated[ReportSummaryOut]:
    reports = reports_service.list_reports(
        ctx, owner=owner, status=status_filter, limit=page.limit, offset=page.offset
    )
    return Paginated[ReportSummaryOut](
        items=[report_views.summary_out(r, ctx.base_currency) for r in reports],
        limit=page.limit,
        offset=page.offset,
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_report(ctx: Ctx, body: ReportCreate) -> ReportDetailOut:
    report = reports_service.create_report(ctx, body.title)
    return report_views.report_detail(ctx, report.id)


@router.get("/{report_id}")
def get_report(ctx: Ctx, report_id: uuid.UUID) -> ReportDetailOut:
    return report_views.report_detail(ctx, report_id)


@router.patch("/{report_id}")
def update_report(ctx: Ctx, report_id: uuid.UUID, body: ReportUpdate) -> ReportDetailOut:
    reports_service.update_report(
        ctx, report_id, title=body.title, expected_version=body.expected_version
    )
    return report_views.report_detail(ctx, report_id)


@router.delete("/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report(ctx: Ctx, report_id: uuid.UUID) -> Response:
    reports_service.delete_report(ctx, report_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{report_id}/lines", status_code=status.HTTP_201_CREATED)
def add_line(ctx: Ctx, report_id: uuid.UUID, body: LineCreate) -> ReportDetailOut:
    ensure_expense_date_allowed(body.expense_date, ctx.now)
    ensure_known_currency(ctx.db, body.currency)
    reports_service.add_line(ctx, report_id, body)
    return report_views.report_detail(ctx, report_id)


@router.patch("/{report_id}/lines/{line_id}")
def update_line(
    ctx: Ctx, report_id: uuid.UUID, line_id: uuid.UUID, body: LineUpdate
) -> ReportDetailOut:
    ensure_expense_date_allowed(body.expense_date, ctx.now)
    ensure_known_currency(ctx.db, body.currency)
    reports_service.update_line(ctx, report_id, line_id, body)
    return report_views.report_detail(ctx, report_id)


@router.delete("/{report_id}/lines/{line_id}")
def remove_line(
    ctx: Ctx,
    report_id: uuid.UUID,
    line_id: uuid.UUID,
    expected_version: Annotated[int, Query()],
) -> ReportDetailOut:
    reports_service.remove_line(ctx, report_id, line_id, expected_version)
    return report_views.report_detail(ctx, report_id)
