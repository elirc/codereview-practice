from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def test_health_returns_ok_and_echoes_request_id(test_settings: Settings) -> None:
    client = TestClient(create_app(test_settings))

    response = client.get("/api/health", headers={"X-Request-Id": "abc-123"})

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["X-Request-Id"] == "abc-123"


def test_unknown_route_uses_error_envelope(test_settings: Settings) -> None:
    client = TestClient(create_app(test_settings))

    response = client.get("/api/does-not-exist")

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "not_found"
    assert error["requestId"] == response.headers["X-Request-Id"]


def test_malformed_inbound_request_id_is_replaced(test_settings: Settings) -> None:
    client = TestClient(create_app(test_settings))

    response = client.get("/api/health", headers={"X-Request-Id": "bad id with spaces"})

    assert response.headers["X-Request-Id"] != "bad id with spaces"
    assert len(response.headers["X-Request-Id"]) == 36
