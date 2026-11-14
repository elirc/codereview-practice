import uuid
from datetime import datetime

from app.schemas.common import OutModel


class ReceiptOut(OutModel):
    id: uuid.UUID
    original_filename: str
    content_type: str
    size_bytes: int
    sha256: str
    created_at: datetime
