import factory

from catalog.models import Product
from inventory.models import StockItem
from inventory.services import receive_stock


class ProductFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Product

    sku = factory.Sequence(lambda n: f"SKU-{n:05d}")
    name = factory.Sequence(lambda n: f"Product {n}")
    price_minor = 1500
    active = True


def stocked_product(on_hand: int = 0, **kwargs) -> Product:
    """Create a product with its stock row, receiving ``on_hand`` units through the ledger."""
    product = ProductFactory(**kwargs)
    StockItem.objects.create(product=product)
    if on_hand:
        receive_stock(product, quantity=on_hand, reason="initial stock", actor=None)
    return product
