import pytest

from catalog.models import Product
from tests.factories import TEST_PASSWORD, stocked_product
from tests.helpers import stock_of

pytestmark = pytest.mark.django_db


def test_token_endpoint_issues_a_token_that_authenticates(anon_client, manager):
    response = anon_client.post(
        "/api/auth/token/",
        {"username": manager.username, "password": TEST_PASSWORD},
        format="json",
    )

    assert response.status_code == 200
    anon_client.credentials(HTTP_AUTHORIZATION=f"Token {response.data['token']}")
    assert anon_client.post("/api/products/", {}, format="json").status_code == 400


def test_token_endpoint_rejects_a_wrong_password(anon_client, manager):
    response = anon_client.post(
        "/api/auth/token/",
        {"username": manager.username, "password": "nope"},
        format="json",
    )

    assert response.status_code == 400
    assert response.data["error"]["code"] == "validation_failed"


def test_anonymous_product_list_shows_only_active_products_with_availability(anon_client):
    stocked_product(on_hand=5, sku="MUG-01")
    stocked_product(on_hand=5, sku="OLD-01", active=False)

    response = anon_client.get("/api/products/")

    assert response.status_code == 200
    assert [row["sku"] for row in response.data["results"]] == ["MUG-01"]
    row = response.data["results"][0]
    assert row["available"] == 5
    assert row["currency"] == "USD"
    assert "on_hand" not in row


def test_anonymous_cannot_read_an_inactive_product(anon_client):
    stocked_product(sku="OLD-01", active=False)

    response = anon_client.get("/api/products/OLD-01/")

    assert response.status_code == 404
    assert response.data["error"]["code"] == "not_found"


def test_staff_sees_inactive_products_and_counters(clerk_client):
    stocked_product(on_hand=3, sku="OLD-01", active=False)

    response = clerk_client.get("/api/products/OLD-01/")

    assert response.status_code == 200
    assert (response.data["on_hand"], response.data["reserved"]) == (3, 0)


def test_product_list_is_paginated_with_limit_and_offset(anon_client):
    for index in range(3):
        stocked_product(sku=f"P-{index}")

    response = anon_client.get("/api/products/?limit=2&offset=1")

    assert response.data["count"] == 3
    assert [row["sku"] for row in response.data["results"]] == ["P-1", "P-2"]


def test_manager_creates_a_product_with_empty_stock(manager_client):
    response = manager_client.post(
        "/api/products/",
        {"sku": "MUG-01", "name": "Mug", "price_minor": 1200},
        format="json",
    )

    assert response.status_code == 201
    assert response.data["available"] == 0
    assert stock_of(Product.objects.get(sku="MUG-01")).on_hand == 0


def test_create_product_validates_price_and_sku(manager_client):
    response = manager_client.post(
        "/api/products/",
        {"sku": "bad sku", "name": "Mug", "price_minor": 0},
        format="json",
    )

    assert response.status_code == 400
    paths = {field["path"] for field in response.data["error"]["details"]["fields"]}
    assert paths == {"sku", "price_minor"}


def test_duplicate_sku_is_a_validation_error(manager_client):
    stocked_product(sku="MUG-01")

    response = manager_client.post(
        "/api/products/",
        {"sku": "MUG-01", "name": "Mug", "price_minor": 1200},
        format="json",
    )

    assert response.status_code == 400
    assert response.data["error"]["details"]["fields"][0]["path"] == "sku"


def test_manager_patches_price_and_active_flag(manager_client):
    stocked_product(sku="MUG-01", price_minor=1200)

    response = manager_client.patch(
        "/api/products/MUG-01/",
        {"price_minor": 1400, "active": False, "sku": "IGNORED"},
        format="json",
    )

    assert response.status_code == 200
    product = Product.objects.get(sku="MUG-01")
    assert (product.price_minor, product.active) == (1400, False)


@pytest.mark.parametrize(
    ("client_name", "expected"),
    [("anon_client", 401), ("clerk_client", 403), ("manager_client", 201)],
)
def test_only_managers_create_products(request, client_name, expected):
    client = request.getfixturevalue(client_name)

    response = client.post(
        "/api/products/",
        {"sku": "MUG-01", "name": "Mug", "price_minor": 1200},
        format="json",
    )

    assert response.status_code == expected


@pytest.mark.parametrize(
    ("client_name", "expected"),
    [("anon_client", 401), ("clerk_client", 403), ("manager_client", 200)],
)
def test_only_managers_edit_products(request, client_name, expected):
    stocked_product(sku="MUG-01")
    client = request.getfixturevalue(client_name)

    response = client.patch("/api/products/MUG-01/", {"name": "Big mug"}, format="json")

    assert response.status_code == expected
