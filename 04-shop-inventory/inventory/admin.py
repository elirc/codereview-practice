from django.contrib import admin

from core.admin import ReadOnlyAdmin

from .models import StockItem, StockMovement


@admin.register(StockItem)
class StockItemAdmin(ReadOnlyAdmin):
    list_display = ["product", "on_hand", "reserved", "updated_at"]
    list_select_related = ["product"]
    search_fields = ["product__sku"]


@admin.register(StockMovement)
class StockMovementAdmin(ReadOnlyAdmin):
    list_display = [
        "created_at",
        "product",
        "kind",
        "on_hand_delta",
        "reserved_delta",
        "order",
        "refund",
        "actor",
    ]
    list_filter = ["kind"]
    list_select_related = ["product", "order", "actor"]
    search_fields = ["product__sku", "order__number"]
