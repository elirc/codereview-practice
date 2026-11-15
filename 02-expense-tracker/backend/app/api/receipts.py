import uuid

from fastapi import APIRouter, Request, Response, status
from starlette.concurrency import run_in_threadpool

from app.api.deps import Ctx, Storage
from app.api.multipart import read_single_file
from app.models import Receipt
from app.schemas.receipts import ReceiptOut
from app.services import receipts as receipts_service
from app.services.receipt_files import MAX_RECEIPT_BYTES, attachment_disposition
from app.services.storage import ReceiptStorage

router = APIRouter(prefix="/receipts", tags=["receipts"])


def receipt_response(storage: ReceiptStorage, receipt: Receipt) -> Response:
    """Serve a stored receipt as a download."""
    return Response(
        content=storage.get(receipt.storage_key),
        media_type=receipt.content_type,
        headers={
            "Content-Disposition": attachment_disposition(receipt.original_filename),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_receipt(request: Request, ctx: Ctx, storage: Storage) -> ReceiptOut:
    upload = await read_single_file(request, field_name="file", max_bytes=MAX_RECEIPT_BYTES)
    receipt = await run_in_threadpool(
        receipts_service.store_receipt, ctx, storage, filename=upload.filename, data=upload.data
    )
    return ReceiptOut.model_validate(receipt)


@router.get("/{receipt_id}/content")
def download_receipt(ctx: Ctx, storage: Storage, receipt_id: uuid.UUID) -> Response:
    receipt = receipts_service.receipt_for_download(ctx, receipt_id)
    return receipt_response(storage, receipt)
