from rest_framework import serializers

from payments.services.refunds import refund_progress

from .models import Order, OrderLine
from .services import LineRequest, merge_lines

MAX_DISTINCT_LINES = 50
MAX_SUBMITTED_LINES = 200
MAX_LINE_QUANTITY = 999


class CheckoutLineSerializer(serializers.Serializer):
    sku = serializers.CharField(max_length=64)
    quantity = serializers.IntegerField(min_value=1, max_value=MAX_LINE_QUANTITY)


class CheckoutSerializer(serializers.Serializer):
    email = serializers.EmailField()
    lines = CheckoutLineSerializer(many=True, allow_empty=False)

    def validate_lines(self, value: list[dict]) -> list[LineRequest]:
        if len(value) > MAX_SUBMITTED_LINES:
            raise serializers.ValidationError(f"At most {MAX_SUBMITTED_LINES} lines may be sent.")
        requested = [LineRequest(sku=line["sku"], quantity=line["quantity"]) for line in value]
        merged = merge_lines(requested)
        if len(merged) > MAX_DISTINCT_LINES:
            raise serializers.ValidationError(
                f"An order may contain at most {MAX_DISTINCT_LINES} different products.",
            )
        too_many = [line.sku for line in merged if line.quantity > MAX_LINE_QUANTITY]
        if too_many:
            raise serializers.ValidationError(
                f"Quantity per product may not exceed {MAX_LINE_QUANTITY}: {', '.join(too_many)}.",
            )
        return merged


class OrderLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = OrderLine
        fields = ["id", "sku", "name", "unit_price_minor", "quantity", "refunded_quantity"]


class PublicOrderSerializer(serializers.ModelSerializer):
    lines = OrderLineSerializer(many=True, read_only=True)

    class Meta:
        model = Order
        fields = [
            "number",
            "status",
            "email",
            "currency",
            "total_minor",
            "reservation_expires_at",
            "paid_at",
            "lines",
            "created_at",
        ]


class StaffOrderSerializer(PublicOrderSerializer):
    refunded_minor = serializers.SerializerMethodField()
    refund_state = serializers.SerializerMethodField()

    class Meta(PublicOrderSerializer.Meta):
        fields = [
            "id",
            *PublicOrderSerializer.Meta.fields,
            "amount_paid_minor",
            "refunded_minor",
            "refund_state",
            "payment_intent_id",
            "last_payment_event_at",
            "payment_failure_reason",
            "needs_review",
            "review_reason",
            "updated_at",
        ]

    def get_refunded_minor(self, obj: Order) -> int:
        return refund_progress(obj)[0]

    def get_refund_state(self, obj: Order) -> str:
        return refund_progress(obj)[1]


class OrderFilterSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=Order.Status.choices, required=False)
    needs_review = serializers.BooleanField(required=False)
    email = serializers.EmailField(required=False)
