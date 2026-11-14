from typing import Any

from django.db import IntegrityError, transaction

from core.errors import ValidationFailed
from inventory.services import create_stock_item

from .models import Product


def create_product(*, sku: str, name: str, price_minor: int, active: bool = True) -> Product:
    try:
        with transaction.atomic():
            product = Product.objects.create(
                sku=sku,
                name=name,
                price_minor=price_minor,
                active=active,
            )
            create_stock_item(product)
    except IntegrityError as exc:
        if Product.objects.filter(sku=sku).exists():
            raise ValidationFailed(
                [{"path": "sku", "message": "A product with this SKU already exists."}],
            ) from exc
        raise
    return product


def update_product(product: Product, changes: dict[str, Any]) -> Product:
    """Apply already-validated field changes."""
    for field, value in changes.items():
        setattr(product, field, value)
    if changes:
        product.save(update_fields=[*changes.keys(), "updated_at"])
    return product
