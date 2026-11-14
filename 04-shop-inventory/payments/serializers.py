from decimal import Decimal

from rest_framework import serializers

from .models import Refund, RefundLine, WebhookEvent

MAX_REFUND_MINOR = 10**12
MAX_EVENT_TIMESTAMP = 253402300799
REFUND_KINDS = ("lines", "amount_minor", "percent")


class RefundLineInputSerializer(serializers.Serializer):
    order_line_id = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1, max_value=999)
    restock = serializers.BooleanField(default=False)


class RefundCreateSerializer(serializers.Serializer):
    lines = RefundLineInputSerializer(many=True, required=False, allow_empty=False)
    amount_minor = serializers.IntegerField(
        min_value=1,
        max_value=MAX_REFUND_MINOR,
        required=False,
    )
    percent = serializers.DecimalField(
        max_digits=5,
        decimal_places=2,
        min_value=Decimal("0.01"),
        max_value=Decimal("100"),
        required=False,
    )
    reason = serializers.CharField(min_length=1, max_length=200)

    def validate(self, attrs: dict) -> dict:
        if sum(kind in attrs for kind in REFUND_KINDS) != 1:
            raise serializers.ValidationError(
                "Provide exactly one of lines, amount_minor or percent.",
            )
        line_ids = [line["order_line_id"] for line in attrs.get("lines", [])]
        if len(set(line_ids)) != len(line_ids):
            raise serializers.ValidationError({"lines": ["Each order line may appear only once."]})
        return attrs


class RefundQuoteQuerySerializer(serializers.Serializer):
    percent = serializers.DecimalField(
        max_digits=5,
        decimal_places=2,
        min_value=Decimal("0.01"),
        max_value=Decimal("100"),
    )


class RefundLineSerializer(serializers.ModelSerializer):
    order_line_id = serializers.UUIDField(read_only=True)
    sku = serializers.CharField(source="order_line.sku", read_only=True)

    class Meta:
        model = RefundLine
        fields = ["order_line_id", "sku", "quantity", "restock"]


class RefundSerializer(serializers.ModelSerializer):
    order_number = serializers.CharField(source="order.number", read_only=True)
    currency = serializers.CharField(source="order.currency", read_only=True)
    created_by = serializers.CharField(source="created_by.username", default=None, read_only=True)
    lines = RefundLineSerializer(many=True, read_only=True)

    class Meta:
        model = Refund
        fields = [
            "id",
            "order_number",
            "amount_minor",
            "currency",
            "status",
            "source",
            "reason",
            "provider_refund_id",
            "failure_reason",
            "created_by",
            "lines",
            "created_at",
            "updated_at",
        ]


class EventDataSerializer(serializers.Serializer):
    payment_intent_id = serializers.CharField(max_length=255)
    amount_minor = serializers.IntegerField(min_value=0, max_value=MAX_REFUND_MINOR)
    currency = serializers.CharField(max_length=16)
    refund_id = serializers.CharField(max_length=255, allow_blank=True, default="")
    refund_reference = serializers.CharField(max_length=255, allow_blank=True, default="")
    failure_reason = serializers.CharField(max_length=500, allow_blank=True, default="")


class WebhookEnvelopeSerializer(serializers.Serializer):
    id = serializers.CharField(max_length=255)
    type = serializers.CharField(max_length=100)
    created = serializers.IntegerField(min_value=0, max_value=MAX_EVENT_TIMESTAMP)
    data = serializers.DictField()


class WebhookEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = WebhookEvent
        fields = [
            "id",
            "provider_event_id",
            "type",
            "status",
            "attempts",
            "last_error",
            "provider_created_at",
            "received_at",
            "processed_at",
            "payload",
        ]


class WebhookEventFilterSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=WebhookEvent.Status.choices, required=False)
    type = serializers.CharField(max_length=100, required=False)
