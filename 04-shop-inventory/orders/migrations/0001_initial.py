import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("catalog", "0001_initial"),
    ]

    operations = [
        migrations.RunSQL(
            sql="CREATE SEQUENCE order_number_seq START WITH 1",
            reverse_sql="DROP SEQUENCE order_number_seq",
        ),
        migrations.CreateModel(
            name="Order",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("number", models.CharField(max_length=20, unique=True)),
                ("public_token", models.CharField(max_length=64, unique=True)),
                ("email", models.EmailField(max_length=254)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending_payment", "Pending Payment"),
                            ("paid", "Paid"),
                            ("fulfilled", "Fulfilled"),
                            ("cancelled", "Cancelled"),
                            ("expired", "Expired"),
                        ],
                        default="pending_payment",
                        max_length=20,
                    ),
                ),
                ("total_minor", models.BigIntegerField()),
                ("currency", models.CharField(max_length=3)),
                ("payment_intent_id", models.CharField(blank=True, default="", max_length=255)),
                ("reservation_expires_at", models.DateTimeField()),
                ("paid_at", models.DateTimeField(blank=True, null=True)),
                ("amount_paid_minor", models.BigIntegerField(default=0)),
                ("last_payment_event_at", models.DateTimeField(blank=True, null=True)),
                ("needs_review", models.BooleanField(default=False)),
                ("review_reason", models.CharField(blank=True, default="", max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["status", "reservation_expires_at"], name="order_status_expiry_idx"
                    )
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("total_minor__gt", 0)), name="order_total_positive"
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("amount_paid_minor__gte", 0)),
                        name="order_amount_paid_non_negative",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "status__in",
                                ["pending_payment", "paid", "fulfilled", "cancelled", "expired"],
                            )
                        ),
                        name="order_status_valid",
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(("payment_intent_id", ""), _negated=True),
                        fields=("payment_intent_id",),
                        name="order_payment_intent_unique",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="OrderLine",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("sku", models.CharField(max_length=64)),
                ("name", models.CharField(max_length=200)),
                ("unit_price_minor", models.BigIntegerField()),
                ("quantity", models.IntegerField()),
                ("refunded_quantity", models.IntegerField(default=0)),
                (
                    "order",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="lines",
                        to="orders.order",
                    ),
                ),
                (
                    "product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="catalog.product",
                    ),
                ),
            ],
            options={
                "ordering": ["sku"],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("quantity__gt", 0)),
                        name="order_line_quantity_positive",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("refunded_quantity__gte", 0),
                            ("refunded_quantity__lte", models.F("quantity")),
                        ),
                        name="order_line_refunded_within_quantity",
                    ),
                    models.UniqueConstraint(
                        fields=("order", "product"), name="order_line_product_unique"
                    ),
                ],
            },
        ),
    ]
