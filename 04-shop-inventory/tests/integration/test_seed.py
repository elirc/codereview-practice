import pytest
from django.contrib.auth.models import User
from django.core.management import call_command

from catalog.models import Product
from core.permissions import role_of
from inventory.models import StockMovement
from orders.models import Order
from tests.helpers import assert_ledger_balanced

pytestmark = pytest.mark.django_db


def test_seed_is_idempotent_and_creates_every_role():
    call_command("seed")
    counts = (
        User.objects.count(),
        Product.objects.count(),
        Order.objects.count(),
        StockMovement.objects.count(),
    )

    call_command("seed")

    assert counts == (
        User.objects.count(),
        Product.objects.count(),
        Order.objects.count(),
        StockMovement.objects.count(),
    )
    assert role_of(User.objects.get(username="manager")) == "manager"
    assert role_of(User.objects.get(username="clerk")) == "clerk"
    assert User.objects.get(username="admin").is_superuser
    assert set(Order.objects.values_list("status", flat=True)) == {
        "pending_payment",
        "paid",
        "cancelled",
        "expired",
    }
    for product in Product.objects.all():
        assert_ledger_balanced(product)
