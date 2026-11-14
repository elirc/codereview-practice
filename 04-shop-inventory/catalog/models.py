import uuid

from django.db import models


class Product(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sku = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=200)
    price_minor = models.BigIntegerField()
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sku"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(price_minor__gt=0),
                name="product_price_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.sku} {self.name}"
