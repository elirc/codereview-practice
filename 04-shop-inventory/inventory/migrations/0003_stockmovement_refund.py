import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("inventory", "0002_stockmovement_order"),
        ("payments", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="stockmovement",
            name="refund",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="stock_movements",
                to="payments.refund",
            ),
        ),
    ]
