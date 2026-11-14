import unicodedata
from dataclasses import dataclass
from urllib.parse import quote

MAX_RECEIPT_BYTES = 5 * 1024 * 1024
MAX_FILENAME_LENGTH = 200


@dataclass(frozen=True, slots=True)
class FileType:
    content_type: str
    extension: str


_SIGNATURES: tuple[tuple[bytes, FileType], ...] = (
    (b"%PDF-", FileType("application/pdf", "pdf")),
    (b"\xff\xd8\xff", FileType("image/jpeg", "jpg")),
    (b"\x89PNG\r\n\x1a\n", FileType("image/png", "png")),
)


def sniff_type(data: bytes) -> FileType | None:
    """Identify a receipt by its leading bytes; declared types are not consulted."""
    for signature, file_type in _SIGNATURES:
        if data.startswith(signature):
            return file_type
    return None


def sanitize_filename(name: str) -> str:
    """Keep a display-only copy of the client's filename."""
    kept = (
        ch for ch in name if ch not in "/\\" and not unicodedata.category(ch).startswith("C")
    )
    return "".join(kept)[:MAX_FILENAME_LENGTH]


def attachment_disposition(filename: str) -> str:
    if not filename:
        return 'attachment; filename="receipt"'
    fallback = "".join(ch for ch in filename if 32 <= ord(ch) < 127 and ch not in '"\\;')
    encoded = quote(filename, safe="")
    return f"attachment; filename=\"{fallback or 'receipt'}\"; filename*=UTF-8''{encoded}"
