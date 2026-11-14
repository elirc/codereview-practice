import pytest

from inventory.models import StockMovement
from tests.factories import stocked_product
from tests.helpers import assert_ledger_balanced, stock_of

pytestmark = pytest.mark.django_db


def test_clerk_receives_stock_and_the_actor_is_recorded(clerk_client, clerk):
    product = stocked_product(sku="MUG-01")

    response = clerk_client.post(
        "/api/products/MUG-01/stock/receive/",
        {"quantity": 12, "reason": "PO-77"},
        format="json",
    )

    assert response.status_code == 200
    assert response.data == {"sku": "MUG-01", "on_hand": 12, "reserved": 0, "available": 12}
    movement = StockMovement.objects.get(product=product, kind="receive")
    assert movement.actor == clerk
    assert_ledger_balanced(product)


def test_receive_rejects_non_positive_quantity(clerk_client):
    stocked_product(sku="MUG-01")

    response = clerk_client.post(
        "/api/products/MUG-01/stock/receive/",
        {"quantity": 0},
        format="json",
    )

    assert response.status_code == 400
    assert response.data["error"]["details"]["fields"][0]["path"] == "quantity"


def test_receive_for_unknown_product_is_not_found(clerk_client):
    response = clerk_client.post(
        "/api/products/NOPE/stock/receive/",
        {"quantity": 1},
        format="json",
    )

    assert response.status_code == 404


def test_manager_adjusts_stock_with_a_reason(manager_client):
    product = stocked_product(on_hand=10, sku="MUG-01")

    response = manager_client.post(
        "/api/products/MUG-01/stock/adjust/",
        {"delta": -3, "reason": "stocktake"},
        format="json",
    )

    assert response.status_code == 200
    assert stock_of(product).on_hand == 7
    assert_ledger_balanced(product)


def test_adjust_requires_a_reason_and_a_non_zero_delta(manager_client):
    stocked_product(on_hand=10, sku="MUG-01")

    response = manager_client.post(
        "/api/products/MUG-01/stock/adjust/",
        {"delta": 0, "reason": ""},
        format="json",
    )

    assert response.status_code == 400
    paths = {field["path"] for field in response.data["error"]["details"]["fields"]}
    assert paths == {"delta", "reason"}


def test_adjust_that_would_drop_below_zero_is_refused(manager_client):
    product = stocked_product(on_hand=2, sku="MUG-01")

    response = manager_client.post(
        "/api/products/MUG-01/stock/adjust/",
        {"delta": -3, "reason": "stocktake"},
        format="json",
    )

    assert response.status_code == 422
    assert response.data["error"]["code"] == "adjustment_below_reserved"
    assert stock_of(product).on_hand == 2


def test_movements_are_listed_newest_first(clerk_client):
    stocked_product(on_hand=4, sku="MUG-01")
    clerk_client.post("/api/products/MUG-01/stock/receive/", {"quantity": 2}, format="json")

    response = clerk_client.get("/api/products/MUG-01/stock/movements/")

    assert response.status_code == 200
    assert [row["on_hand_delta"] for row in response.data["results"]] == [2, 4]


@pytest.mark.parametrize(
    ("client_name", "receive", "adjust", "movements"),
    [
        ("anon_client", 401, 401, 401),
        ("clerk_client", 200, 403, 200),
        ("manager_client", 200, 200, 200),
    ],
)
def test_stock_permissions_by_role(request, client_name, receive, adjust, movements):
    stocked_product(on_hand=5, sku="MUG-01")
    client = request.getfixturevalue(client_name)

    base = "/api/products/MUG-01/stock"
    assert client.post(f"{base}/receive/", {"quantity": 1}, format="json").status_code == receive
    adjust_body = {"delta": 1, "reason": "count"}
    assert client.post(f"{base}/adjust/", adjust_body, format="json").status_code == adjust
    assert client.get(f"{base}/movements/").status_code == movements


def test_stocktake_records_the_difference_for_each_counted_product(manager_client, manager):
    mug = stocked_product(on_hand=10, sku="MUG-01")
    tea = stocked_product(on_hand=4, sku="TEA-01")
    pot = stocked_product(on_hand=2, sku="POT-01")

    response = manager_client.post(
        "/api/stock/stocktake/",
        {
            "counts": [
                {"sku": "MUG-01", "counted": 8},
                {"sku": "TEA-01", "counted": 6},
                {"sku": "POT-01", "counted": 2},
            ],
            "reason": "quarterly count",
        },
        format="json",
    )

    assert response.status_code == 200
    levels = {row["sku"]: row["on_hand"] for row in response.data["results"]}
    assert levels == {"MUG-01": 8, "TEA-01": 6, "POT-01": 2}
    adjustments = StockMovement.objects.filter(kind="adjust").order_by("on_hand_delta")
    assert [(m.product_id, m.on_hand_delta) for m in adjustments] == [(mug.pk, -2), (tea.pk, 2)]
    assert all(m.actor == manager and m.reason == "quarterly count" for m in adjustments)
    for product in (mug, tea, pot):
        assert_ledger_balanced(product)


def test_stocktake_rejects_unknown_skus(manager_client):
    stocked_product(on_hand=10, sku="MUG-01")

    response = manager_client.post(
        "/api/stock/stocktake/",
        {
            "counts": [{"sku": "MUG-01", "counted": 8}, {"sku": "NOPE", "counted": 1}],
            "reason": "count",
        },
        format="json",
    )

    assert response.status_code == 422
    assert response.data["error"]["details"] == {"skus": ["NOPE"]}
    assert not StockMovement.objects.filter(kind="adjust").exists()


def test_anonymous_cannot_submit_a_stocktake(anon_client):
    response = anon_client.post(
        "/api/stock/stocktake/",
        {"counts": [{"sku": "MUG-01", "counted": 1}], "reason": "count"},
        format="json",
    )

    assert response.status_code == 401
