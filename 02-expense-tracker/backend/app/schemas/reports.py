import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints, model_validator

from app.domain.enums import ExpenseCategory, ReportStatus, StepKind, StepStatus
from app.schemas.common import StrictModel
from app.schemas.money import AmountMinor, CurrencyCode
from app.schemas.receipts import ReceiptOut
from app.schemas.users import UserSummary

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)
]
OwnerScope = Literal["me", "all"]


class ReportCreate(StrictModel):
    title: Title


class ReportUpdate(StrictModel):
    expected_version: int
    title: Title


class LineCreate(StrictModel):
    expected_version: int
    expense_date: date
    category: ExpenseCategory
    description: Description
    amount_minor: AmountMinor
    currency: CurrencyCode
    receipt_id: uuid.UUID | None = None


class LineUpdate(StrictModel):
    expected_version: int
    expense_date: date | None = None
    category: ExpenseCategory | None = None
    description: Description | None = None
    amount_minor: AmountMinor | None = None
    currency: CurrencyCode | None = None
    receipt_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _non_null_changes(self) -> "LineUpdate":
        for name in ("expense_date", "category", "description", "amount_minor", "currency"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class LineOut(BaseModel):
    id: uuid.UUID
    expense_date: date
    category: ExpenseCategory
    description: str
    amount_minor: int
    currency: str
    receipt_id: uuid.UUID | None
    receipt: ReceiptOut | None
    rate_used: str | None
    rate_effective_date: date | None
    base_amount_minor: int | None
    estimated_base_minor: int | None
    needs_receipt: bool


class StepOut(BaseModel):
    id: uuid.UUID
    round: int
    position: int
    kind: StepKind
    status: StepStatus
    approver: UserSummary | None
    decided_by: UserSummary | None
    decided_at: datetime | None
    comment: str | None


class ReimbursementOut(BaseModel):
    id: uuid.UUID
    amount_base_minor: int
    currency: str
    payment_reference: str
    paid_by: uuid.UUID
    paid_at: datetime


class Capabilities(BaseModel):
    edit: bool
    submit: bool
    withdraw: bool
    decide: bool
    reopen: bool
    reimburse: bool


class ReportSummaryOut(BaseModel):
    id: uuid.UUID
    title: str
    status: ReportStatus
    owner: UserSummary
    round: int
    version: int
    total_base_minor: int | None
    base_currency: str
    submitted_at: datetime | None
    decided_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ReportDetailOut(ReportSummaryOut):
    estimated_total_base_minor: int | None
    lines: list[LineOut]
    steps: list[StepOut]
    current_step_id: uuid.UUID | None
    reimbursement: ReimbursementOut | None
    can: Capabilities
