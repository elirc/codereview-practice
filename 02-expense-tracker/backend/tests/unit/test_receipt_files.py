import pytest

from app.services.receipt_files import attachment_disposition, sanitize_filename, sniff_type


@pytest.mark.parametrize(
    ("data", "content_type", "extension"),
    [
        (b"%PDF-1.7\n...", "application/pdf", "pdf"),
        (b"\xff\xd8\xff\xe0\x00\x10JFIF", "image/jpeg", "jpg"),
        (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "image/png", "png"),
    ],
)
def test_sniffs_supported_types_from_magic_bytes(
    data: bytes, content_type: str, extension: str
) -> None:
    file_type = sniff_type(data)

    assert file_type is not None
    assert (file_type.content_type, file_type.extension) == (content_type, extension)


@pytest.mark.parametrize(
    "data", [b"", b"<html><body>receipt</body></html>", b"GIF89a", b"%PD", b"\x89PNG"]
)
def test_rejects_other_content(data: bytes) -> None:
    assert sniff_type(data) is None


def test_sanitize_removes_separators_and_control_characters() -> None:
    assert sanitize_filename("../../etc/passwd") == "....etcpasswd"
    assert sanitize_filename("C:\\Users\\me\\taxi.pdf") == "C:Usersmetaxi.pdf"
    assert sanitize_filename("lunch\r\n\x00\u202e.pdf") == "lunch.pdf"
    assert sanitize_filename("caf\u00e9.png") == "caf\u00e9.png"


def test_sanitize_truncates_to_200_characters() -> None:
    assert len(sanitize_filename("a" * 500 + ".pdf")) == 200


def test_attachment_disposition_quotes_and_encodes() -> None:
    assert attachment_disposition("") == 'attachment; filename="receipt"'
    assert attachment_disposition('a"b.pdf') == (
        "attachment; filename=\"ab.pdf\"; filename*=UTF-8''a%22b.pdf"
    )
    assert attachment_disposition("caf\u00e9.png") == (
        "attachment; filename=\"caf.png\"; filename*=UTF-8''caf%C3%A9.png"
    )
