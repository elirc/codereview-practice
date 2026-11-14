"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-03-02 10:00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TIMESTAMP = sa.DateTime(timezone=True)
RATE = sa.Numeric(20, 10)


def upgrade() -> None:
    op.create_table(
        "currencies",
        sa.Column("code", sa.String(3), nullable=False),
        sa.Column("exponent", sa.SmallInteger(), nullable=False),
        sa.PrimaryKeyConstraint("code", name="pk_currencies"),
        sa.CheckConstraint("exponent IN (0, 2, 3)", name="ck_currencies_exponent_valid"),
    )

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(120), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("manager_id", sa.Uuid(), nullable=True),
        sa.Column("approval_limit_minor", sa.BigInteger(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.ForeignKeyConstraint(["manager_id"], ["users.id"], name="fk_users_manager_id_users"),
        sa.CheckConstraint(
            "role IN ('employee', 'manager', 'finance', 'admin')", name="ck_users_role_valid"
        ),
        sa.CheckConstraint(
            "approval_limit_minor >= 0", name="ck_users_approval_limit_non_negative"
        ),
        sa.CheckConstraint("email = lower(email)", name="ck_users_email_lower_case"),
        sa.CheckConstraint(
            "manager_id IS NULL OR manager_id <> id", name="ck_users_not_own_manager"
        ),
    )
    op.create_index("ix_users_manager_id", "users", ["manager_id"])

    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("expires_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sessions"),
        sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_sessions_user_id_users", ondelete="CASCADE"
        ),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])

    op.create_table(
        "exchange_rates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("from_currency", sa.String(3), nullable=False),
        sa.Column("effective_date", sa.Date(), nullable=False),
        sa.Column("rate", RATE, nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_exchange_rates"),
        sa.ForeignKeyConstraint(
            ["from_currency"],
            ["currencies.code"],
            name="fk_exchange_rates_from_currency_currencies",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_exchange_rates_created_by_users"
        ),
        sa.UniqueConstraint(
            "from_currency", "effective_date", name="uq_exchange_rates_currency_date"
        ),
        sa.CheckConstraint("rate > 0", name="ck_exchange_rates_rate_positive"),
    )

    op.create_table(
        "receipts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("storage_key", sa.String(255), nullable=False),
        sa.Column("original_filename", sa.String(200), nullable=False),
        sa.Column("content_type", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_receipts"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name="fk_receipts_owner_id_users"),
        sa.UniqueConstraint("storage_key", name="uq_receipts_storage_key"),
        sa.CheckConstraint("size_bytes > 0", name="ck_receipts_size_positive"),
    )
    op.create_index("ix_receipts_owner_id", "receipts", ["owner_id"])

    op.create_table(
        "reports",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("total_base_minor", sa.BigInteger(), nullable=True),
        sa.Column("submitted_at", TIMESTAMP, nullable=True),
        sa.Column("decided_at", TIMESTAMP, nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_reports"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name="fk_reports_owner_id_users"),
        sa.CheckConstraint(
            "status IN ('draft', 'submitted', 'approved', 'rejected', 'reimbursed')",
            name="ck_reports_status_valid",
        ),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 120", name="ck_reports_title_length"),
        sa.CheckConstraint("round >= 0", name="ck_reports_round_non_negative"),
        sa.CheckConstraint("version >= 1", name="ck_reports_version_positive"),
    )
    op.create_index("ix_reports_owner_id", "reports", ["owner_id"])
    op.create_index("ix_reports_status", "reports", ["status"])

    op.create_table(
        "expense_lines",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("expense_date", sa.Date(), nullable=False),
        sa.Column("category", sa.String(16), nullable=False),
        sa.Column("description", sa.String(300), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("receipt_id", sa.Uuid(), nullable=True),
        sa.Column("rate_used", RATE, nullable=True),
        sa.Column("rate_effective_date", sa.Date(), nullable=True),
        sa.Column("base_amount_minor", sa.BigInteger(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_expense_lines"),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["reports.id"],
            name="fk_expense_lines_report_id_reports",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["currency"], ["currencies.code"], name="fk_expense_lines_currency_currencies"
        ),
        sa.ForeignKeyConstraint(
            ["receipt_id"], ["receipts.id"], name="fk_expense_lines_receipt_id_receipts"
        ),
        sa.UniqueConstraint("receipt_id", name="uq_expense_lines_receipt_id"),
        sa.CheckConstraint(
            "category IN ('travel', 'meals', 'lodging', 'supplies', 'other')",
            name="ck_expense_lines_category_valid",
        ),
        sa.CheckConstraint(
            "char_length(description) BETWEEN 1 AND 300",
            name="ck_expense_lines_description_length",
        ),
        sa.CheckConstraint("amount_minor > 0", name="ck_expense_lines_amount_positive"),
        sa.CheckConstraint(
            "(rate_used IS NULL AND rate_effective_date IS NULL AND base_amount_minor IS NULL)"
            " OR (rate_used IS NOT NULL AND rate_effective_date IS NOT NULL"
            " AND base_amount_minor IS NOT NULL)",
            name="ck_expense_lines_conversion_complete",
        ),
    )
    op.create_index("ix_expense_lines_report_id", "expense_lines", ["report_id"])
    op.create_index(
        "ix_expense_lines_frozen_rate",
        "expense_lines",
        ["currency", "rate_effective_date"],
        postgresql_where=sa.text("rate_used IS NOT NULL"),
    )

    op.create_table(
        "approval_steps",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("approver_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", TIMESTAMP, nullable=True),
        sa.Column("comment", sa.String(1000), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_approval_steps"),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["reports.id"],
            name="fk_approval_steps_report_id_reports",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["approver_id"], ["users.id"], name="fk_approval_steps_approver_id_users"
        ),
        sa.ForeignKeyConstraint(
            ["decided_by"], ["users.id"], name="fk_approval_steps_decided_by_users"
        ),
        sa.UniqueConstraint("report_id", "round", "position", name="uq_approval_steps_slot"),
        sa.CheckConstraint("kind IN ('manager', 'finance')", name="ck_approval_steps_kind_valid"),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'skipped')",
            name="ck_approval_steps_status_valid",
        ),
        sa.CheckConstraint("round >= 1 AND position >= 1", name="ck_approval_steps_slot_positive"),
        sa.CheckConstraint(
            "(kind = 'manager' AND approver_id IS NOT NULL)"
            " OR (kind = 'finance' AND approver_id IS NULL)",
            name="ck_approval_steps_approver_matches_kind",
        ),
    )
    op.create_index("ix_approval_steps_report_id", "approval_steps", ["report_id"])
    op.create_index("ix_approval_steps_approver_id", "approval_steps", ["approver_id"])

    op.create_table(
        "reimbursements",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("amount_base_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("payment_reference", sa.String(64), nullable=False),
        sa.Column("paid_by", sa.Uuid(), nullable=False),
        sa.Column("paid_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_reimbursements"),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["reports.id"],
            name="fk_reimbursements_report_id_reports",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["currency"], ["currencies.code"], name="fk_reimbursements_currency_currencies"
        ),
        sa.ForeignKeyConstraint(["paid_by"], ["users.id"], name="fk_reimbursements_paid_by_users"),
        sa.UniqueConstraint("report_id", name="uq_reimbursements_report_id"),
        sa.CheckConstraint("amount_base_minor >= 0", name="ck_reimbursements_amount_non_negative"),
        sa.CheckConstraint(
            "char_length(payment_reference) BETWEEN 1 AND 64",
            name="ck_reimbursements_payment_reference_length",
        ),
    )

    op.create_table(
        "audit_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("at", TIMESTAMP, nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column("entity_type", sa.String(32), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("before", postgresql.JSONB(), nullable=True),
        sa.Column("after", postgresql.JSONB(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_audit_events"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], name="fk_audit_events_actor_id_users"),
    )
    op.create_index("ix_audit_events_entity", "audit_events", ["entity_type", "entity_id"])
    op.create_index("ix_audit_events_report_id", "audit_events", ["report_id"])

    op.execute(
        """
        CREATE FUNCTION audit_events_reject_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'audit_events rows cannot be %', lower(TG_OP)
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_events_append_only
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events")
    op.execute("DROP FUNCTION IF EXISTS audit_events_reject_change()")
    op.drop_table("audit_events")
    op.drop_table("reimbursements")
    op.drop_table("approval_steps")
    op.drop_table("expense_lines")
    op.drop_table("reports")
    op.drop_table("receipts")
    op.drop_table("exchange_rates")
    op.drop_table("sessions")
    op.drop_table("users")
    op.drop_table("currencies")
