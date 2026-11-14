import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, StringConstraints

from app.domain.enums import StepKind
from app.schemas.common import StrictModel, VersionedAction
from app.schemas.reports import ReportSummaryOut
from app.schemas.users import UserSummary

Comment = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
PaymentReference = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)
]
AuditEntityType = Literal["report", "line", "receipt", "step", "rate", "user"]


class ApproveIn(VersionedAction):
    comment: Comment | None = None


class RejectIn(VersionedAction):
    comment: Comment


class ReassignIn(StrictModel):
    approver_id: uuid.UUID


class ReimburseIn(VersionedAction):
    payment_reference: PaymentReference


class PendingApprovalOut(ReportSummaryOut):
    current_step_id: uuid.UUID
    current_step_kind: StepKind
    current_step_position: int


class AuditEventOut(BaseModel):
    id: int
    at: datetime
    actor: UserSummary | None
    request_id: str | None
    entity_type: str
    entity_id: uuid.UUID
    report_id: uuid.UUID | None
    action: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None
