import uuid

from django.conf import settings
from django.db import models


class StockItem(models.Model):
    product = models.OneToOneField(
        "catalog.Product",
        on_delete=models.PROTECT,
        primary_key=True,
        related_name="stock",
    )
    on_hand = models.BigIntegerField(default=0)
    reserved = models.BigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(on_hand__gte=0),
                name="stock_on_hand_non_negative",
            ),
            models.CheckConstraint(
                condition=models.Q(reserved__gte=0),
                name="stock_reserved_non_negative",
            ),
            models.CheckConstraint(
                condition=models.Q(reserved__lte=models.F("on_hand")),
                name="stock_reserved_within_on_hand",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.product_id}: {self.on_hand} on hand, {self.reserved} reserved"

    @property
    def available(self) -> int:
        return self.on_hand - self.reserved


class StockMovement(models.Model):
    class Kind(models.TextChoices):
        RECEIVE = "receive"
        ADJUST = "adjust"
        RESERVE = "reserve"
        RELEASE = "release"
        COMMIT = "commit"
        RESTOCK = "restock"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey(
        "catalog.Product",
        on_delete=models.PROTECT,
        related_name="stock_movements",
    )
    kind = models.CharField(max_length=16, choices=Kind.choices)
    on_hand_delta = models.BigIntegerField(default=0)
    reserved_delta = models.BigIntegerField(default=0)
    order = models.ForeignKey(
        "orders.Order",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="stock_movements",
    )
    reason = models.CharField(max_length=200, blank=True, default="")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["product", "created_at"], name="movement_product_created_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.kind} {self.product_id} ({self.on_hand_delta:+}/{self.reserved_delta:+})"
