import uuid

from django.conf import settings
from django.db import models


class Refund(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"
        SUCCEEDED = "succeeded"
        FAILED = "failed"

    class Source(models.TextChoices):
        STAFF = "staff"
        SYSTEM = "system"
        PROVIDER = "provider"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey("orders.Order", on_delete=models.PROTECT, related_name="refunds")
    amount_minor = models.BigIntegerField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    reason = models.CharField(max_length=200)
    provider_refund_id = models.CharField(max_length=255, blank=True, default="")
    source = models.CharField(max_length=16, choices=Source.choices)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )
    failure_reason = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount_minor__gt=0),
                name="refund_amount_positive",
            ),
            models.UniqueConstraint(
                fields=["provider_refund_id"],
                condition=~models.Q(provider_refund_id=""),
                name="refund_provider_id_unique",
            ),
        ]

    def __str__(self) -> str:
        return f"Refund {self.id} ({self.status})"


class RefundLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    refund = models.ForeignKey(Refund, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(
        "orders.OrderLine",
        on_delete=models.PROTECT,
        related_name="refund_lines",
    )
    quantity = models.IntegerField()
    restock = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0),
                name="refund_line_quantity_positive",
            ),
            models.UniqueConstraint(
                fields=["refund", "order_line"],
                name="refund_line_order_line_unique",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.order_line_id} x{self.quantity}"


class WebhookEvent(models.Model):
    class Status(models.TextChoices):
        RECEIVED = "received"
        PROCESSED = "processed"
        IGNORED = "ignored"
        FAILED = "failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider_event_id = models.CharField(max_length=255, unique=True)
    type = models.CharField(max_length=100)
    payload = models.JSONField()
    provider_created_at = models.DateTimeField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.RECEIVED)
    attempts = models.PositiveIntegerField(default=0)
    last_error = models.TextField(blank=True, default="")
    received_at = models.DateTimeField()
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-received_at"]
        indexes = [
            models.Index(fields=["status", "received_at"], name="webhook_status_received_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.type} {self.provider_event_id} ({self.status})"
