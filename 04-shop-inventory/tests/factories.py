import factory
from django.contrib.auth.models import Group, User

from catalog.models import Product
from inventory.models import StockItem
from inventory.services import receive_stock

TEST_PASSWORD = "correct-horse-battery"


class UserFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = User

    username = factory.Sequence(lambda n: f"user{n}")
    email = factory.LazyAttribute(lambda user: f"{user.username}@shop.test")
    password = factory.django.Password(TEST_PASSWORD)


class ProductFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Product

    sku = factory.Sequence(lambda n: f"SKU-{n:05d}")
    name = factory.Sequence(lambda n: f"Product {n}")
    price_minor = 1500
    active = True


def staff_user(role: str, **kwargs) -> User:
    user = UserFactory(**kwargs)
    group, _ = Group.objects.get_or_create(name=role)
    user.groups.add(group)
    return user


def stocked_product(on_hand: int = 0, **kwargs) -> Product:
    """Create a product with its stock row, receiving ``on_hand`` units through the ledger."""
    product = ProductFactory(**kwargs)
    StockItem.objects.create(product=product)
    if on_hand:
        receive_stock(product, quantity=on_hand, reason="initial stock", actor=None)
    return product
