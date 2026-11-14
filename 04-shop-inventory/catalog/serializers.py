from django.conf import settings
from rest_framework import serializers

from .models import Product

MAX_PRICE_MINOR = 10**12


class ProductSerializer(serializers.ModelSerializer):
    currency = serializers.SerializerMethodField()
    available = serializers.IntegerField(source="stock.available", read_only=True)

    class Meta:
        model = Product
        fields = ["sku", "name", "price_minor", "currency", "active", "available"]

    def get_currency(self, obj: Product) -> str:
        return settings.SHOP_CURRENCY


class StaffProductSerializer(ProductSerializer):
    on_hand = serializers.IntegerField(source="stock.on_hand", read_only=True)
    reserved = serializers.IntegerField(source="stock.reserved", read_only=True)

    class Meta(ProductSerializer.Meta):
        fields = [
            "id",
            *ProductSerializer.Meta.fields,
            "on_hand",
            "reserved",
            "created_at",
            "updated_at",
        ]


class ProductCreateSerializer(serializers.Serializer):
    sku = serializers.RegexField(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", max_length=64)
    name = serializers.CharField(max_length=200)
    price_minor = serializers.IntegerField(min_value=1, max_value=MAX_PRICE_MINOR)
    active = serializers.BooleanField(default=True)


class ProductUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    price_minor = serializers.IntegerField(min_value=1, max_value=MAX_PRICE_MINOR, required=False)
    active = serializers.BooleanField(required=False)
