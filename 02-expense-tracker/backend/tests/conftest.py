import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.core.config import Settings

DEFAULT_TEST_DATABASE_URL = "postgresql+psycopg://expense:expense@localhost:5452/expense_test"
START_OF_TEST_TIME = datetime(2026, 3, 16, 9, 0, tzinfo=UTC)


class SteppingClock:
    """Deterministic clock that advances one second on every read."""

    def __init__(self, start: datetime = START_OF_TEST_TIME) -> None:
        self._current = start

    def now(self) -> datetime:
        value = self._current
        self._current = value + timedelta(seconds=1)
        return value

    def set(self, value: datetime) -> None:
        self._current = value


@pytest.fixture
def test_settings(tmp_path: Path) -> Settings:
    return Settings(
        app_env="test",
        database_url=os.environ.get("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL),
        base_currency="USD",
        receipt_storage_dir=tmp_path / "receipts",
        session_ttl_hours=12,
        log_level="WARNING",
    )


@pytest.fixture
def clock() -> SteppingClock:
    return SteppingClock()
