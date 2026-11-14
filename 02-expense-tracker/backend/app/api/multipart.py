from dataclasses import dataclass

from fastapi import Request
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header

from app.domain.errors import InvalidInput, PayloadTooLarge, UnsupportedMediaType

# Room for boundaries and part headers on top of the file itself.
MULTIPART_ENVELOPE_ALLOWANCE = 64 * 1024


@dataclass(frozen=True)
class UploadedFile:
    filename: str
    data: bytes


class _SingleFileCollector:
    def __init__(self, field_name: str, max_bytes: int) -> None:
        self.field_name = field_name
        self.max_bytes = max_bytes
        self.filename: str | None = None
        self.buffer = bytearray()
        self.too_large = False
        self.unexpected_field: str | None = None
        self._headers: dict[bytes, bytes] = {}
        self._header_field = bytearray()
        self._header_value = bytearray()
        self._collecting = False

    def on_part_begin(self) -> None:
        self._headers = {}
        self._collecting = False

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self._header_field += data[start:end]

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self._header_value += data[start:end]

    def on_header_end(self) -> None:
        self._headers[bytes(self._header_field).lower()] = bytes(self._header_value)
        self._header_field = bytearray()
        self._header_value = bytearray()

    def on_headers_finished(self) -> None:
        _, params = parse_options_header(self._headers.get(b"content-disposition", b""))
        name = params.get(b"name", b"").decode("utf-8", "replace")
        raw_filename = params.get(b"filename")
        if name != self.field_name or raw_filename is None or self.filename is not None:
            self.unexpected_field = name or "file"
            return
        self.filename = raw_filename.decode("utf-8", "replace")
        self._collecting = True

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if not self._collecting or self.too_large:
            return
        if len(self.buffer) + (end - start) > self.max_bytes:
            self.too_large = True
            return
        self.buffer += data[start:end]

    def on_part_end(self) -> None:
        self._collecting = False


def _too_large(max_bytes: int) -> PayloadTooLarge:
    return PayloadTooLarge(
        message=f"Receipts may be at most {max_bytes} bytes.", details={"max_bytes": max_bytes}
    )


async def read_single_file(request: Request, *, field_name: str, max_bytes: int) -> UploadedFile:
    """Stream a multipart body holding exactly one file part, enforcing `max_bytes` as it reads."""
    content_type, params = parse_options_header(request.headers.get("content-type", ""))
    if content_type != b"multipart/form-data":
        raise UnsupportedMediaType(message="Upload the receipt as multipart/form-data.")
    boundary = params.get(b"boundary")
    if not boundary:
        raise InvalidInput.field(field_name, "The multipart boundary is missing.")

    collector = _SingleFileCollector(field_name, max_bytes)
    parser = MultipartParser(
        boundary,
        {
            "on_part_begin": collector.on_part_begin,
            "on_part_data": collector.on_part_data,
            "on_part_end": collector.on_part_end,
            "on_header_field": collector.on_header_field,
            "on_header_value": collector.on_header_value,
            "on_header_end": collector.on_header_end,
            "on_headers_finished": collector.on_headers_finished,
        },
    )

    received = 0
    try:
        async for chunk in request.stream():
            received += len(chunk)
            if received > max_bytes + MULTIPART_ENVELOPE_ALLOWANCE:
                raise _too_large(max_bytes)
            parser.write(chunk)
            if collector.too_large:
                raise _too_large(max_bytes)
            if collector.unexpected_field is not None:
                raise InvalidInput.field(
                    collector.unexpected_field, f'Send one file in the "{field_name}" field.'
                )
        parser.finalize()
    except MultipartParseError:
        raise InvalidInput.field(field_name, "The multipart body is malformed.") from None

    if collector.filename is None:
        raise InvalidInput.field(field_name, "A file is required.")
    return UploadedFile(filename=collector.filename, data=bytes(collector.buffer))
