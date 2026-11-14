import pytest

from core.jobs import backoff_seconds


@pytest.mark.parametrize(
    ("retries", "expected"),
    [(0, 5), (1, 10), (2, 20), (5, 160), (6, 320), (7, 600), (12, 600)],
)
def test_backoff_doubles_from_five_seconds_and_is_capped(retries, expected):
    assert backoff_seconds(retries) == expected
