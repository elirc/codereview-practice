import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Product",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("sku", models.CharField(max_length=64, unique=True)),
                ("name", models.CharField(max_length=200)),
                ("price_minor", models.BigIntegerField()),
                ("active", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["sku"],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("price_minor__gt", 0)), name="product_price_positive"
                    )
                ],
            },
        ),
    ]
