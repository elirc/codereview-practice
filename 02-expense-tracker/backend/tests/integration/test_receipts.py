import re
import uuid
from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditEvent, Receipt, User
from app.services.receipt_files import MAX_RECEIPT_BYTES
from tests.fakes import InMemoryStorage
from tests.integration.factories import add_line, create_user, new_report

ClientFor = Callable[[User], TestClient]

PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
BOUNDARY = "receipt-boundary-7f3a"


def upload(client: TestClient, filename: str, data: bytes, declared: str = "image/png") -> Any:
    return client.post("/api/receipts", files={"file": (filename, data, declared)})


def raw_multipart(filename: str, data: bytes) -> bytes:
    head = (
        f"--{BOUNDARY}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode()
    return head + data + f"\r\n--{BOUNDARY}--\r\n".encode()


def test_type_comes_from_content_not_name_or_declared_type(
    db: Session, client_for: ClientFor, storage: InMemoryStorage
) -> None:
    client = client_for(create_user(db))

    response = upload(client, "scan.png", PDF, declared="image/png")

    assert response.status_code == 201
    body = response.json()
    assert body["content_type"] == "application/pdf"
    assert body["size_bytes"] == len(PDF)
    stored = db.get(Receipt, uuid.UUID(body["id"]))
    assert stored is not None
    assert re.fullmatch(r"receipts/[0-9a-f-]{36}\.pdf", stored.storage_key)
    assert storage.blobs[stored.storage_key] == PDF


def test_html_named_as_pdf_is_unsupported(
    db: Session, client_for: ClientFor, storage: InMemoryStorage
) -> None:
    client = client_for(create_user(db))

    response = upload(client, "receipt.pdf", b"<html><script>x</script></html>", "application/pdf")

    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"
    assert storage.blobs == {}
    assert db.scalars(select(Receipt)).all() == []


def test_file_at_size_limit_is_accepted(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    data = PNG + b"\x00" * (MAX_RECEIPT_BYTES - len(PNG))

    response = upload(client, "big.png", data)

    assert response.status_code == 201
    assert response.json()["size_bytes"] == MAX_RECEIPT_BYTES


def test_oversized_file_with_understated_content_length_is_rejected(
    db: Session, client_for: ClientFor, storage: InMemoryStorage
) -> None:
    client = client_for(create_user(db))
    data = PDF + b"0" * (MAX_RECEIPT_BYTES + 1 - len(PDF))
    body = raw_multipart("big.pdf", data)

    response = client.post(
        "/api/receipts",
        content=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={BOUNDARY}",
            "Content-Length": "512",
        },
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"
    assert storage.blobs == {}


def test_path_in_filename_does_not_affect_storage_key(
    db: Session, client_for: ClientFor, storage: InMemoryStorage
) -> None:
    client = client_for(create_user(db))

    response = upload(client, "../../etc/passwd", PDF)

    assert response.status_code == 201
    assert response.json()["original_filename"] == "....etcpasswd"
    [key] = storage.blobs
    assert key.startswith("receipts/")
    assert "passwd" not in key
    assert ".." not in key


def test_non_multipart_and_extra_fields_are_rejected(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))

    as_json = client.post("/api/receipts", json={"file": "x"})
    two_files = client.post(
        "/api/receipts",
        files=[("file", ("a.pdf", PDF, "application/pdf")), ("file", ("b.pdf", PDF, "x/y"))],
    )
    extra = client.post(
        "/api/receipts",
        files={"file": ("a.pdf", PDF, "application/pdf")},
        data={"owner_id": "someone"},
    )
    missing = client.post("/api/receipts", files={"other": ("a.pdf", PDF, "application/pdf")})

    assert as_json.status_code == 415
    assert two_files.status_code == 400
    assert extra.status_code == 400
    assert missing.status_code == 400


def test_unattached_receipt_downloads_only_for_uploader(db: Session, client_for: ClientFor) -> None:
    owner = create_user(db)
    owner_client = client_for(owner)
    receipt = upload(owner_client, "taxi.pdf", PDF).json()

    mine = owner_client.get(f"/api/receipts/{receipt['id']}/content")
    finance = client_for(create_user(db, role="finance")).get(
        f"/api/receipts/{receipt['id']}/content"
    )

    assert mine.status_code == 200
    assert mine.content == PDF
    assert mine.headers["content-type"] == "application/pdf"
    assert mine.headers["x-content-type-options"] == "nosniff"
    assert mine.headers["content-disposition"].startswith("attachment;")
    assert finance.status_code == 404


def test_attached_receipt_follows_report_visibility(db: Session, client_for: ClientFor) -> None:
    owner = create_user(db)
    owner_client = client_for(owner)
    receipt = upload(owner_client, "hotel.png", PNG).json()
    report = add_line(owner_client, new_report(owner_client), receipt_id=receipt["id"])
    url = f"/api/receipts/{receipt['id']}/content"

    assert report["lines"][0]["receipt"]["id"] == receipt["id"]
    assert owner_client.get(url).status_code == 200
    assert client_for(create_user(db, role="finance")).get(url).status_code == 200
    assert client_for(create_user(db)).get(url).status_code == 404
    assert client_for(create_user(db, role="manager")).get(url).status_code == 404
    actions = db.scalars(select(AuditEvent.action).order_by(AuditEvent.id)).all()
    assert actions == ["report.created", "line.added", "receipt.attached"]


def test_cannot_attach_someone_elses_receipt(db: Session, client_for: ClientFor) -> None:
    other_client = client_for(create_user(db))
    foreign = upload(other_client, "theirs.pdf", PDF).json()
    client = client_for(create_user(db))
    report = new_report(client)

    response = client.post(
        f"/api/reports/{report['id']}/lines",
        json={
            "expected_version": report["version"],
            "expense_date": "2026-03-10",
            "category": "travel",
            "description": "Train",
            "amount_minor": 4000,
            "currency": "USD",
            "receipt_id": foreign["id"],
        },
    )

    assert response.status_code == 404
    assert client.get(f"/api/reports/{report['id']}").json()["lines"] == []


def test_receipt_cannot_be_attached_to_two_lines(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    receipt = upload(client, "one.pdf", PDF).json()
    report = add_line(client, new_report(client), receipt_id=receipt["id"])
    report = add_line(client, report, description="Second")
    second_line = next(line for line in report["lines"] if line["description"] == "Second")

    response = client.patch(
        f"/api/reports/{report['id']}/lines/{second_line['id']}",
        json={"expected_version": report["version"], "receipt_id": receipt["id"]},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "receipt_in_use"


def test_receipt_can_be_detached_and_moved(db: Session, client_for: ClientFor) -> None:
    client = client_for(create_user(db))
    receipt = upload(client, "one.pdf", PDF).json()
    report = add_line(client, new_report(client), receipt_id=receipt["id"])
    line_id = report["lines"][0]["id"]

    detached = client.patch(
        f"/api/reports/{report['id']}/lines/{line_id}",
        json={"expected_version": report["version"], "receipt_id": None},
    ).json()
    moved = add_line(client, detached, description="Other", receipt_id=receipt["id"])

    assert next(line for line in moved["lines"] if line["id"] == line_id)["receipt"] is None
    other = next(line for line in moved["lines"] if line["description"] == "Other")
    assert other["receipt"]["id"] == receipt["id"]


def test_line_receipt_downloads_for_report_viewers(db: Session, client_for: ClientFor) -> None:
    owner_client = client_for(create_user(db))
    receipt = upload(owner_client, "hotel.pdf", PDF).json()
    report = add_line(owner_client, new_report(owner_client), receipt_id=receipt["id"])
    url = f"/api/reports/{report['id']}/lines/{report['lines'][0]['id']}/receipt"

    mine = owner_client.get(url)
    finance = client_for(create_user(db, role="finance")).get(url)
    stranger = client_for(create_user(db)).get(url)

    assert mine.status_code == 200
    assert mine.content == PDF
    assert mine.headers["content-disposition"].startswith("attachment;")
    assert finance.status_code == 200
    assert stranger.status_code == 404


def test_receipt_can_be_replaced_and_removed_from_the_line(
    db: Session, client_for: ClientFor
) -> None:
    client = client_for(create_user(db))
    first = upload(client, "first.pdf", PDF).json()
    second = upload(client, "second.png", PNG).json()
    report = add_line(client, new_report(client), receipt_id=first["id"])
    url = f"/api/reports/{report['id']}/lines/{report['lines'][0]['id']}/receipt"

    replaced = client.put(
        url, json={"expected_version": report["version"], "receipt_id": second["id"]}
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["lines"][0]["receipt"]["id"] == second["id"]
    assert replaced.json()["version"] == report["version"] + 1

    removed = client.put(
        url, json={"expected_version": replaced.json()["version"], "receipt_id": None}
    )
    assert removed.status_code == 200
    assert removed.json()["lines"][0]["receipt"] is None

    actions = db.scalars(select(AuditEvent.action).order_by(AuditEvent.id)).all()
    assert actions[-3:] == ["line.updated", "receipt.attached", "line.updated"]
