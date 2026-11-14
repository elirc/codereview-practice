import uuid

from django.db import models


class Order(models.Model):
    class Status(models.TextChoices):
        PENDING_PAYMENT = "pending_payment"
        PAID = "paid"
        FULFILLED = "fulfilled"
        CANCELLED = "cancelled"
        EXPIRED = "expired"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    number = models.CharField(max_length=20, unique=True)
    public_token = models.CharField(max_length=64, unique=True)
    email = models.EmailField()
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING_PAYMENT,
    )
    total_minor = models.BigIntegerField()
    currency = models.CharField(max_length=3)
    payment_intent_id = models.CharField(max_length=255, blank=True, default="")
    reservation_expires_at = models.DateTimeField()
    paid_at = models.DateTimeField(null=True, blank=True)
    amount_paid_minor = models.BigIntegerField(default=0)
    last_payment_event_at = models.DateTimeField(null=True, blank=True)
    payment_failure_reason = models.CharField(max_length=500, blank=True, default="")
    needs_review = models.BooleanField(default=False)
    review_reason = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(total_minor__gt=0),
                name="order_total_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(amount_paid_minor__gte=0),
                name="order_amount_paid_non_negative",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    status__in=["pending_payment", "paid", "fulfilled", "cancelled", "expired"],
                ),
                name="order_status_valid",
            ),
            models.UniqueConstraint(
                fields=["payment_intent_id"],
                condition=~models.Q(payment_intent_id=""),
                name="order_payment_intent_unique",
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "reservation_expires_at"],
                name="order_status_expiry_idx",
            ),
        ]

    def __str__(self) -> str:
        return self.number


class OrderLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="+")
    sku = models.CharField(max_length=64)
    name = models.CharField(max_length=200)
    unit_price_minor = models.BigIntegerField()
    quantity = models.IntegerField()
    refunded_quantity = models.IntegerField(default=0)

    class Meta:
        ordering = ["sku"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0),
                name="order_line_quantity_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(refunded_quantity__gte=0)
                & models.Q(refunded_quantity__lte=models.F("quantity")),
                name="order_line_refunded_within_quantity",
            ),
            models.UniqueConstraint(fields=["order", "product"], name="order_line_product_unique"),
        ]

    def __str__(self) -> str:
        return f"{self.order_id} {self.sku} x{self.quantity}"

    @property
    def line_total_minor(self) -> int:
        return self.unit_price_minor * self.quantity
