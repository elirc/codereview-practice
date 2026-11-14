import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("payments", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="WebhookEvent",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("provider_event_id", models.CharField(max_length=255, unique=True)),
                ("type", models.CharField(max_length=100)),
                ("payload", models.JSONField()),
                ("provider_created_at", models.DateTimeField()),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("received", "Received"),
                            ("processed", "Processed"),
                            ("ignored", "Ignored"),
                            ("failed", "Failed"),
                        ],
                        default="received",
                        max_length=16,
                    ),
                ),
                ("attempts", models.PositiveIntegerField(default=0)),
                ("last_error", models.TextField(blank=True, default="")),
                ("received_at", models.DateTimeField()),
                ("processed_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "ordering": ["-received_at"],
                "indexes": [
                    models.Index(
                        fields=["status", "received_at"], name="webhook_status_received_idx"
                    )
                ],
            },
        ),
    ]
