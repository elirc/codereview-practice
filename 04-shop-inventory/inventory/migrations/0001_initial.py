import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("catalog", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="StockItem",
            fields=[
                (
                    "product",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        primary_key=True,
                        related_name="stock",
                        serialize=False,
                        to="catalog.product",
                    ),
                ),
                ("on_hand", models.BigIntegerField(default=0)),
                ("reserved", models.BigIntegerField(default=0)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("on_hand__gte", 0)), name="stock_on_hand_non_negative"
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("reserved__gte", 0)),
                        name="stock_reserved_non_negative",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("reserved__lte", models.F("on_hand"))),
                        name="stock_reserved_within_on_hand",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StockMovement",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("receive", "Receive"),
                            ("adjust", "Adjust"),
                            ("reserve", "Reserve"),
                            ("release", "Release"),
                            ("commit", "Commit"),
                            ("restock", "Restock"),
                        ],
                        max_length=16,
                    ),
                ),
                ("on_hand_delta", models.BigIntegerField(default=0)),
                ("reserved_delta", models.BigIntegerField(default=0)),
                ("reason", models.CharField(blank=True, default="", max_length=200)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "actor",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="stock_movements",
                        to="catalog.product",
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["product", "created_at"], name="movement_product_created_idx"
                    )
                ],
            },
        ),
    ]
