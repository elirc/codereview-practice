"""seed supported currencies

Revision ID: 0002
Revises: 0001
Create Date: 2026-03-02 10:05:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CURRENCIES = [
    {"code": "USD", "exponent": 2},
    {"code": "EUR", "exponent": 2},
    {"code": "GBP", "exponent": 2},
    {"code": "CAD", "exponent": 2},
    {"code": "JPY", "exponent": 0},
    {"code": "KWD", "exponent": 3},
]

currencies = sa.table(
    "currencies",
    sa.column("code", sa.String),
    sa.column("exponent", sa.SmallInteger),
)


def upgrade() -> None:
    op.bulk_insert(currencies, CURRENCIES)


def downgrade() -> None:
    codes = [row["code"] for row in CURRENCIES]
    op.execute(currencies.delete().where(currencies.c.code.in_(codes)))
