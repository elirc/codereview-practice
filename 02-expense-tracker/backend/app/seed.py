"""Idempotent demo data. Run after migrations: `python -m app.seed`."""

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import SystemClock
from app.core.config import get_settings
from app.core.db import build_engine, build_session_factory
from app.core.logging import configure_logging, get_logger
from app.core.security import hash_password
from app.domain.enums import ExpenseCategory
from app.models import ExchangeRate, Report, User
from app.schemas.reports import LineCreate
from app.services import reports, workflow
from app.services.context import ServiceContext

SEED_PASSWORD = "expense-demo-1"
RATE_START = date(2025, 1, 1)
RATES = {"EUR": "1.0850", "GBP": "1.2700", "CAD": "0.7400", "JPY": "0.0067", "KWD": "3.2500"}

log = get_logger("app.seed")


@dataclass(frozen=True)
class SeedUser:
    email: str
    name: str
    role: str
    manager: str | None
    limit: int


USERS = (
    SeedUser("admin@example.com", "Avery Admin", "admin", None, 0),
    SeedUser("finance@example.com", "Farah Finance", "finance", None, 0),
    SeedUser("finance2@example.com", "Felix Finance", "finance", None, 0),
    SeedUser("director@example.com", "Dana Director", "manager", None, 1_000_000),
    SeedUser("manager@example.com", "Milo Manager", "manager", "director@example.com", 50_000),
    SeedUser("employee@example.com", "Emma Employee", "employee", "manager@example.com", 0),
    SeedUser("employee2@example.com", "Eli Employee", "employee", "manager@example.com", 0),
)


def _upsert_users(db: Session, now: datetime) -> dict[str, User]:
    password_hash = hash_password(SEED_PASSWORD)
    existing = {u.email: u for u in db.scalars(select(User))}
    for seed in USERS:
        if seed.email in existing:
            continue
        user = User(
            id=uuid.uuid4(),
            email=seed.email,
            password_hash=password_hash,
            full_name=seed.name,
            role=seed.role,
            manager_id=existing[seed.manager].id if seed.manager else None,
            approval_limit_minor=seed.limit,
            active=True,
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        existing[seed.email] = user
    db.commit()
    return existing


def _ensure_rates(db: Session, creator: User, now: datetime) -> None:
    for currency, rate in RATES.items():
        exists = db.scalar(
            select(ExchangeRate.id).where(
                ExchangeRate.from_currency == currency, ExchangeRate.effective_date == RATE_START
            )
        )
        if exists is None:
            db.add(
                ExchangeRate(
                    id=uuid.uuid4(),
                    from_currency=currency,
                    effective_date=RATE_START,
                    rate=Decimal(rate),
                    created_by=creator.id,
                    created_at=now,
                    updated_at=now,
                )
            )
    db.commit()


@dataclass(frozen=True)
class SeedLine:
    days_ago: int
    category: str
    description: str
    amount_minor: int
    currency: str


class _Seeder:
    def __init__(self, db: Session, users: dict[str, User], base_currency: str) -> None:
        self.db = db
        self.users = users
        self.base_currency = base_currency
        self.clock = SystemClock()

    def ctx(self, email: str) -> ServiceContext:
        return ServiceContext(
            db=self.db,
            actor=self.users[email],
            request_id="seed",
            now=self.clock.now(),
            base_currency=self.base_currency,
        )

    def report(self, owner: str, title: str, *lines: SeedLine) -> Report:
        report = reports.create_report(self.ctx(owner), title)
        today = self.clock.now().date()
        for line in lines:
            body = LineCreate(
                expected_version=report.version,
                expense_date=today - timedelta(days=line.days_ago),
                category=ExpenseCategory(line.category),
                description=line.description,
                amount_minor=line.amount_minor,
                currency=line.currency,
            )
            reports.add_line(self.ctx(owner), report.id, body)
        return report

    def submit(self, owner: str, report: Report) -> None:
        workflow.submit(self.ctx(owner), report.id, report.version)

    def decide(self, email: str, report: Report, approve: bool, comment: str | None = None) -> None:
        self.db.refresh(report)
        step = next(s for s in report.steps if s.round == report.round and s.status == "pending")
        workflow.decide(
            self.ctx(email),
            report.id,
            step.id,
            approve=approve,
            expected_version=report.version,
            comment=comment,
        )


def _seed_reports(seeder: _Seeder) -> None:
    employee = "employee@example.com"
    employee2 = "employee2@example.com"
    manager = "manager@example.com"

    seeder.report(
        employee,
        "Team offsite supplies",
        SeedLine(3, "supplies", "Whiteboard markers", 1899, "USD"),
        SeedLine(2, "meals", "Team lunch", 2350, "USD"),
    )

    berlin = seeder.report(
        employee,
        "Client visit Berlin",
        SeedLine(20, "travel", "Airport train", 1450, "EUR"),
        SeedLine(19, "meals", "Dinner with client", 2200, "EUR"),
    )
    seeder.submit(employee, berlin)

    tokyo = seeder.report(
        employee2,
        "Conference Tokyo",
        SeedLine(30, "lodging", "Capsule hotel night", 3000, "JPY"),
        SeedLine(29, "travel", "Metro pass", 1500, "JPY"),
    )
    seeder.submit(employee2, tokyo)
    seeder.decide(manager, tokyo, approve=True, comment="Agreed in advance")

    training = seeder.report(
        employee, "Training course", SeedLine(40, "other", "Course materials", 1900, "GBP")
    )
    seeder.submit(employee, training)
    seeder.decide(manager, training, approve=True)
    seeder.decide("finance@example.com", training, approve=True)

    taxis = seeder.report(
        employee2, "Taxi receipts", SeedLine(12, "travel", "Taxi to client", 1800, "CAD")
    )
    seeder.submit(employee2, taxis)
    seeder.decide(manager, taxis, approve=False, comment="Please use the rail pass.")


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    engine = build_engine(settings.database_url)
    session_factory = build_session_factory(engine)
    with session_factory() as db:
        now = SystemClock().now()
        users = _upsert_users(db, now)
        _ensure_rates(db, users["finance@example.com"], now)
        if db.scalar(select(func.count()).select_from(Report)) == 0:
            _seed_reports(_Seeder(db, users, settings.base_currency))
            log.info("seed_reports_created")
        else:
            log.info("seed_reports_skipped", reason="reports already exist")
    engine.dispose()


if __name__ == "__main__":
    main()
