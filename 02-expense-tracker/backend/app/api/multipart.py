from dataclasses import dataclass

from fastapi import Request
from python_multipart.multipart import parse_options_header
from starlette.datastructures import UploadFile

from app.domain.errors import InvalidInput, PayloadTooLarge, UnsupportedMediaType


@dataclass(frozen=True)
class UploadedFile:
    filename: str
    data: bytes


def _too_large(max_bytes: int) -> PayloadTooLarge:
    return PayloadTooLarge(
        message=f"Receipts may be at most {max_bytes} bytes.", details={"max_bytes": max_bytes}
    )


async def read_single_file(request: Request, *, field_name: str, max_bytes: int) -> UploadedFile:
    """Read a multipart body holding exactly one file part of at most `max_bytes`."""
    content_type, _ = parse_options_header(request.headers.get("content-type", ""))
    if content_type != b"multipart/form-data":
        raise UnsupportedMediaType(message="Upload the receipt as multipart/form-data.")

    async with request.form(max_files=1, max_fields=0) as form:
        upload = form.get(field_name)
        if not isinstance(upload, UploadFile) or len(form) != 1:
            raise InvalidInput.field(field_name, f'Send one file in the "{field_name}" field.')
        if upload.size is not None and upload.size > max_bytes:
            raise _too_large(max_bytes)
        data = await upload.read()
    return UploadedFile(filename=upload.filename or "", data=data)
