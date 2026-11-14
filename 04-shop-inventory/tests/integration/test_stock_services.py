import pytest
from django.db import transaction

from catalog.models import Product
from catalog.services import create_product, update_product
from core.errors import ValidationFailed
from inventory.exceptions import AdjustmentBelowReserved
from inventory.models import StockMovement
from inventory.services import adjust_stock, apply_movement, lock_stock, receive_stock
from tests.factories import stocked_product
from tests.helpers import assert_ledger_balanced, stock_of

pytestmark = pytest.mark.django_db


def _reserve(product: Product, quantity: int) -> None:
    with transaction.atomic():
        item = lock_stock([product.pk])[product.pk]
        apply_movement(item, kind=StockMovement.Kind.RESERVE, reserved_delta=quantity)


def test_create_product_creates_an_empty_stock_row():
    product = create_product(sku="MUG-01", name="Mug", price_minor=1200)

    item = stock_of(product)
    assert (item.on_hand, item.reserved, item.available) == (0, 0, 0)


def test_create_product_rejects_a_duplicate_sku():
    create_product(sku="MUG-01", name="Mug", price_minor=1200)

    with pytest.raises(ValidationFailed) as excinfo:
        create_product(sku="MUG-01", name="Other mug", price_minor=900)

    assert excinfo.value.details["fields"][0]["path"] == "sku"
    assert Product.objects.count() == 1


def test_update_product_changes_only_given_fields():
    product = create_product(sku="MUG-01", name="Mug", price_minor=1200)

    update_product(product, {"price_minor": 1500})

    product.refresh_from_db()
    assert (product.name, product.price_minor) == ("Mug", 1500)


def test_receive_increases_on_hand_and_records_a_movement():
    product = stocked_product()

    receive_stock(product, quantity=7, reason="delivery 42", actor=None)

    assert stock_of(product).on_hand == 7
    movement = StockMovement.objects.get(product=product)
    assert (movement.kind, movement.on_hand_delta, movement.reserved_delta) == ("receive", 7, 0)
    assert movement.reason == "delivery 42"
    assert_ledger_balanced(product)


def test_adjust_down_to_exactly_reserved_is_allowed():
    product = stocked_product(on_hand=10)
    _reserve(product, 4)

    adjust_stock(product, delta=-6, reason="breakage", actor=None)

    item = stock_of(product)
    assert (item.on_hand, item.reserved, item.available) == (4, 4, 0)
    assert_ledger_balanced(product)


def test_adjust_below_reserved_is_refused_and_changes_nothing():
    product = stocked_product(on_hand=10)
    _reserve(product, 4)

    with pytest.raises(AdjustmentBelowReserved):
        adjust_stock(product, delta=-7, reason="breakage", actor=None)

    assert stock_of(product).on_hand == 10
    assert not StockMovement.objects.filter(kind=StockMovement.Kind.ADJUST).exists()
    assert_ledger_balanced(product)


def test_adjust_up_adds_stock():
    product = stocked_product(on_hand=2)

    adjust_stock(product, delta=3, reason="found in back room", actor=None)

    assert stock_of(product).on_hand == 5
    assert_ledger_balanced(product)
