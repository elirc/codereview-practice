from rest_framework import serializers

from .models import StockMovement

MAX_STOCK_CHANGE = 1_000_000
MAX_STOCKTAKE_LINES = 500


class ReceiveStockSerializer(serializers.Serializer):
    quantity = serializers.IntegerField(min_value=1, max_value=MAX_STOCK_CHANGE)
    reason = serializers.CharField(max_length=200, required=False, allow_blank=True, default="")


class AdjustStockSerializer(serializers.Serializer):
    delta = serializers.IntegerField(min_value=-MAX_STOCK_CHANGE, max_value=MAX_STOCK_CHANGE)
    reason = serializers.CharField(min_length=1, max_length=200)

    def validate_delta(self, value: int) -> int:
        if value == 0:
            raise serializers.ValidationError("Delta must not be zero.")
        return value


class StockCountSerializer(serializers.Serializer):
    sku = serializers.CharField(max_length=64)
    counted = serializers.IntegerField(min_value=0, max_value=MAX_STOCK_CHANGE)


class StocktakeSerializer(serializers.Serializer):
    counts = StockCountSerializer(many=True, allow_empty=False)
    reason = serializers.CharField(min_length=1, max_length=200)

    def validate_counts(self, value: list[dict]) -> list[dict]:
        if len(value) > MAX_STOCKTAKE_LINES:
            raise serializers.ValidationError(
                f"At most {MAX_STOCKTAKE_LINES} products may be counted at once.",
            )
        skus = [count["sku"] for count in value]
        if len(set(skus)) != len(skus):
            raise serializers.ValidationError("Each SKU may appear only once.")
        return value


class StockLevelSerializer(serializers.Serializer):
    sku = serializers.CharField(source="product.sku")
    on_hand = serializers.IntegerField()
    reserved = serializers.IntegerField()
    available = serializers.IntegerField()


class StockMovementSerializer(serializers.ModelSerializer):
    actor = serializers.CharField(source="actor.username", default=None, read_only=True)

    class Meta:
        model = StockMovement
        fields = [
            "id",
            "kind",
            "on_hand_delta",
            "reserved_delta",
            "reason",
            "actor",
            "created_at",
        ]
