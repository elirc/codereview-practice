from datetime import datetime, timedelta

import pytest
from rest_framework.test import APIClient

from payments.provider import get_provider
from tests.factories import staff_user
from tests.helpers import NOW, client_for


class FixedClock:
    def __init__(self, now: datetime):
        self.current = now

    def __call__(self) -> datetime:
        return self.current

    def advance(self, **delta: float) -> datetime:
        self.current += timedelta(**delta)
        return self.current


@pytest.fixture(autouse=True)
def clock(monkeypatch) -> FixedClock:
    fixed = FixedClock(NOW)
    monkeypatch.setattr("core.clock.now", fixed)
    return fixed


@pytest.fixture(autouse=True)
def published(monkeypatch) -> list[tuple[str, tuple[str, ...]]]:
    """Tasks published by the code under test, recorded instead of sent to the broker."""
    calls: list[tuple[str, tuple[str, ...]]] = []
    monkeypatch.setattr("core.jobs.publish", lambda name, *args: calls.append((name, args)))
    return calls


@pytest.fixture(autouse=True)
def provider():
    get_provider.cache_clear()
    yield get_provider()
    get_provider.cache_clear()


@pytest.fixture
def manager(db):
    return staff_user("manager", username="mara")


@pytest.fixture
def clerk(db):
    return staff_user("clerk", username="colin")


@pytest.fixture
def anon_client() -> APIClient:
    return APIClient()


@pytest.fixture
def manager_client(manager) -> APIClient:
    return client_for(manager)


@pytest.fixture
def clerk_client(clerk) -> APIClient:
    return client_for(clerk)
