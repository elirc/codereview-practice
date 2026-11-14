import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("orders", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Refund",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("amount_minor", models.BigIntegerField()),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("succeeded", "Succeeded"),
                            ("failed", "Failed"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("reason", models.CharField(max_length=200)),
                ("provider_refund_id", models.CharField(blank=True, default="", max_length=255)),
                (
                    "source",
                    models.CharField(
                        choices=[
                            ("staff", "Staff"),
                            ("system", "System"),
                            ("provider", "Provider"),
                        ],
                        max_length=16,
                    ),
                ),
                ("failure_reason", models.CharField(blank=True, default="", max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "order",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="refunds",
                        to="orders.order",
                    ),
                ),
            ],
            options={
                "ordering": ["created_at"],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("amount_minor__gt", 0)), name="refund_amount_positive"
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(("provider_refund_id", ""), _negated=True),
                        fields=("provider_refund_id",),
                        name="refund_provider_id_unique",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="RefundLine",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("quantity", models.IntegerField()),
                ("restock", models.BooleanField(default=False)),
                (
                    "order_line",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="refund_lines",
                        to="orders.orderline",
                    ),
                ),
                (
                    "refund",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="lines",
                        to="payments.refund",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("quantity__gt", 0)),
                        name="refund_line_quantity_positive",
                    ),
                    models.UniqueConstraint(
                        fields=("refund", "order_line"), name="refund_line_order_line_unique"
                    ),
                ],
            },
        ),
    ]
