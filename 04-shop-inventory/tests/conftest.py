import pytest
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from tests.factories import staff_user


def client_for(user) -> APIClient:
    client = APIClient()
    if user is not None:
        token, _ = Token.objects.get_or_create(user=user)
        client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
    return client


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
