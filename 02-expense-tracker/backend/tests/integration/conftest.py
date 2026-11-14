import os
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.main import create_app
from app.models import User
from tests.conftest import DEFAULT_TEST_DATABASE_URL, SteppingClock
from tests.integration.factories import signed_in_client

BACKEND_DIR = Path(__file__).resolve().parents[2]

MUTABLE_TABLES = (
    "audit_events",
    "reimbursements",
    "approval_steps",
    "expense_lines",
    "reports",
    "receipts",
    "exchange_rates",
    "sessions",
    "users",
)


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    database_url = os.environ.get("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)
    alembic_config = AlembicConfig(str(BACKEND_DIR / "alembic.ini"))
    alembic_config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    command.upgrade(alembic_config, "head")

    engine = create_engine(database_url, connect_args={"options": "-c timezone=UTC"})
    yield engine
    engine.dispose()


@pytest.fixture(autouse=True)
def _clean_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(text(f"TRUNCATE {', '.join(MUTABLE_TABLES)} RESTART IDENTITY CASCADE"))


@pytest.fixture
def db(engine: Engine) -> Iterator[Session]:
    with Session(engine, expire_on_commit=False) as session:
        yield session


@pytest.fixture
def app(test_settings: Settings, clock: SteppingClock, engine: Engine) -> Iterator[FastAPI]:
    application = create_app(test_settings, clock=clock)
    yield application
    application.state.engine.dispose()


@pytest.fixture
def client_for(app: FastAPI, db: Session) -> Callable[[User], TestClient]:
    def build(user: User) -> TestClient:
        return signed_in_client(app, db, user)

    return build
