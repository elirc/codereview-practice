import hashlib
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.logging import get_logger
from app.domain.errors import Conflict, NotFound, UnsupportedMediaType
from app.models import ExpenseLine, Receipt, Report
from app.services import audit
from app.services.access import can_view_report, ensure_version, get_own_report, touch
from app.services.context import ServiceContext
from app.services.receipt_files import sanitize_filename, sniff_type
from app.services.storage import ReceiptStorage

log = get_logger(__name__)


def _receipt_not_found() -> NotFound:
    return NotFound("not_found", "Receipt not found.")


def store_receipt(
    ctx: ServiceContext, storage: ReceiptStorage, *, filename: str, data: bytes
) -> Receipt:
    file_type = sniff_type(data)
    if file_type is None:
        raise UnsupportedMediaType(message="Receipts must be PDF, JPEG or PNG files.")

    receipt_id = uuid.uuid4()
    key = f"receipts/{receipt_id}.{file_type.extension}"
    storage.put(key, data, file_type.content_type)
    receipt = Receipt(
        id=receipt_id,
        owner_id=ctx.actor.id,
        storage_key=key,
        original_filename=sanitize_filename(filename),
        content_type=file_type.content_type,
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        created_at=ctx.now,
    )
    ctx.db.add(receipt)
    try:
        ctx.db.commit()
    except Exception:
        ctx.db.rollback()
        storage.delete(key)
        raise
    log.info("receipt_stored", receipt_id=str(receipt_id), size_bytes=len(data))
    return receipt


def receipt_for_download(ctx: ServiceContext, receipt_id: uuid.UUID) -> Receipt:
    """Return a receipt the caller may download: via its report, or as the unattached uploader."""
    receipt = ctx.db.get(Receipt, receipt_id)
    if receipt is None:
        raise _receipt_not_found()
    report_id = ctx.db.scalar(
        select(ExpenseLine.report_id).where(ExpenseLine.receipt_id == receipt.id)
    )
    if report_id is None:
        if receipt.owner_id != ctx.actor.id:
            raise _receipt_not_found()
    elif not can_view_report(ctx, report_id):
        raise _receipt_not_found()
    return receipt


def line_receipt(ctx: ServiceContext, report_id: uuid.UUID, line_id: uuid.UUID) -> Receipt:
    """Return the receipt attached to a line of a report the caller may view."""
    if not can_view_report(ctx, report_id):
        raise _receipt_not_found()
    receipt = ctx.db.scalar(
        select(Receipt)
        .join(ExpenseLine, ExpenseLine.receipt_id == Receipt.id)
        .where(ExpenseLine.id == line_id)
    )
    if receipt is None:
        raise _receipt_not_found()
    return receipt


def attach_to_line(ctx: ServiceContext, line: ExpenseLine, receipt_id: uuid.UUID | None) -> bool:
    """Point `line` at one of the caller's receipts, or clear it when `receipt_id` is None.

    Returns True when a receipt became newly attached to the line.
    """
    if receipt_id is None or receipt_id == line.receipt_id:
        line.receipt_id = receipt_id
        return False

    receipt = ctx.db.scalars(
        select(Receipt).where(Receipt.id == receipt_id).with_for_update()
    ).one_or_none()
    if receipt is None or receipt.owner_id != ctx.actor.id:
        raise _receipt_not_found()
    holder = ctx.db.scalar(select(ExpenseLine.id).where(ExpenseLine.receipt_id == receipt_id))
    if holder is not None and holder != line.id:
        raise Conflict("receipt_in_use", "This receipt is already attached to another line.")
    line.receipt_id = receipt_id
    return True


def record_attachment(ctx: ServiceContext, report: Report, line: ExpenseLine) -> None:
    if line.receipt_id is None:
        return
    audit.record(
        ctx,
        entity_type="receipt",
        entity_id=line.receipt_id,
        report_id=report.id,
        action="receipt.attached",
        after={"line_id": str(line.id)},
    )


def commit_attachment(ctx: ServiceContext) -> None:
    try:
        ctx.db.commit()
    except IntegrityError as exc:
        ctx.db.rollback()
        if "uq_expense_lines_receipt_id" in str(exc.orig):
            raise Conflict(
                "receipt_in_use", "This receipt is already attached to another line."
            ) from None
        raise


def set_line_receipt(
    ctx: ServiceContext,
    report_id: uuid.UUID,
    line_id: uuid.UUID,
    *,
    receipt_id: uuid.UUID | None,
    expected_version: int,
) -> None:
    """Attach one of the caller's receipts to a line of their report, or detach it."""
    report = get_own_report(ctx, report_id)
    ensure_version(report, expected_version)
    line = ctx.db.scalars(
        select(ExpenseLine).where(ExpenseLine.id == line_id, ExpenseLine.report_id == report.id)
    ).one_or_none()
    if line is None:
        raise NotFound()

    previous = line.receipt_id
    attached = attach_to_line(ctx, line, receipt_id)
    if line.receipt_id != previous:
        line.updated_at = ctx.now
        audit.record(
            ctx,
            entity_type="line",
            entity_id=line.id,
            report_id=report.id,
            action="line.updated",
            before={"receipt_id": audit.to_jsonable(previous)},
            after={"receipt_id": audit.to_jsonable(line.receipt_id)},
        )
    touch(report, ctx)
    if attached:
        record_attachment(ctx, report, line)
    commit_attachment(ctx)
