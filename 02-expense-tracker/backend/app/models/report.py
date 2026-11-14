import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain.enums import ExpenseCategory, ReportStatus, StepKind, StepStatus
from app.models.base import Base, sql_in
from app.models.currency import RATE_TYPE
from app.models.receipt import Receipt
from app.models.user import User


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        CheckConstraint(f"status IN ({sql_in(ReportStatus)})", name="status_valid"),
        CheckConstraint("char_length(title) BETWEEN 1 AND 120", name="title_length"),
        CheckConstraint("round >= 0", name="round_non_negative"),
        CheckConstraint("version >= 1", name="version_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(16), index=True)
    round: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    total_base_minor: Mapped[int | None] = mapped_column(BigInteger)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    owner: Mapped[User] = relationship(foreign_keys=[owner_id])
    lines: Mapped[list["ExpenseLine"]] = relationship(
        back_populates="report",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by=lambda: [ExpenseLine.expense_date, ExpenseLine.created_at, ExpenseLine.id],
    )
    steps: Mapped[list["ApprovalStep"]] = relationship(
        back_populates="report",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by=lambda: [ApprovalStep.round, ApprovalStep.position],
    )
    reimbursement: Mapped["Reimbursement | None"] = relationship(
        back_populates="report", passive_deletes=True
    )


class ExpenseLine(Base):
    __tablename__ = "expense_lines"
    __table_args__ = (
        CheckConstraint(f"category IN ({sql_in(ExpenseCategory)})", name="category_valid"),
        CheckConstraint("char_length(description) BETWEEN 1 AND 300", name="description_length"),
        CheckConstraint("amount_minor > 0", name="amount_positive"),
        CheckConstraint(
            "(rate_used IS NULL AND rate_effective_date IS NULL AND base_amount_minor IS NULL)"
            " OR (rate_used IS NOT NULL AND rate_effective_date IS NOT NULL"
            " AND base_amount_minor IS NOT NULL)",
            name="conversion_complete",
        ),
        Index(
            "ix_expense_lines_frozen_rate",
            "currency",
            "rate_effective_date",
            postgresql_where=text("rate_used IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    report_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), index=True
    )
    expense_date: Mapped[date] = mapped_column(Date)
    category: Mapped[str] = mapped_column(String(16))
    description: Mapped[str] = mapped_column(String(300))
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(ForeignKey("currencies.code"))
    receipt_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("receipts.id"), unique=True)
    rate_used: Mapped[Decimal | None] = mapped_column(RATE_TYPE)
    rate_effective_date: Mapped[date | None] = mapped_column(Date)
    base_amount_minor: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    report: Mapped[Report] = relationship(back_populates="lines")
    receipt: Mapped[Receipt | None] = relationship()


class ApprovalStep(Base):
    __tablename__ = "approval_steps"
    __table_args__ = (
        UniqueConstraint("report_id", "round", "position", name="uq_approval_steps_slot"),
        CheckConstraint(f"kind IN ({sql_in(StepKind)})", name="kind_valid"),
        CheckConstraint(f"status IN ({sql_in(StepStatus)})", name="status_valid"),
        CheckConstraint("round >= 1 AND position >= 1", name="slot_positive"),
        CheckConstraint(
            "(kind = 'manager' AND approver_id IS NOT NULL)"
            " OR (kind = 'finance' AND approver_id IS NULL)",
            name="approver_matches_kind",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    report_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), index=True
    )
    round: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16))
    approver_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(16))
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    comment: Mapped[str | None] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    report: Mapped[Report] = relationship(back_populates="steps")
    approver: Mapped[User | None] = relationship(foreign_keys=[approver_id])
    decider: Mapped[User | None] = relationship(foreign_keys=[decided_by])


class Reimbursement(Base):
    __tablename__ = "reimbursements"
    __table_args__ = (
        CheckConstraint("amount_base_minor >= 0", name="amount_non_negative"),
        CheckConstraint(
            "char_length(payment_reference) BETWEEN 1 AND 64", name="payment_reference_length"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    report_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), unique=True
    )
    amount_base_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(ForeignKey("currencies.code"))
    payment_reference: Mapped[str] = mapped_column(String(64))
    paid_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    report: Mapped[Report] = relationship(back_populates="reimbursement")
