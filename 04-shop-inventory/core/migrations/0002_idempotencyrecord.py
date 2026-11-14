import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_staff_groups"),
    ]

    operations = [
        migrations.CreateModel(
            name="IdempotencyRecord",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("scope", models.CharField(max_length=64)),
                ("key", models.CharField(max_length=128)),
                ("request_hash", models.CharField(max_length=64)),
                ("response_status", models.PositiveSmallIntegerField(blank=True, null=True)),
                ("response_body", models.JSONField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(
                        fields=("scope", "key"), name="idempotency_scope_key_unique"
                    )
                ],
            },
        ),
    ]
