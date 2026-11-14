from django.contrib import admin

from core.admin import ReadOnlyAdmin, ReadOnlyTabularInline

from .models import Order, OrderLine


class OrderLineInline(ReadOnlyTabularInline):
    model = OrderLine
    fields = ["sku", "name", "unit_price_minor", "quantity", "refunded_quantity"]


@admin.register(Order)
class OrderAdmin(ReadOnlyAdmin):
    list_display = [
        "number",
        "email",
        "status",
        "total_minor",
        "amount_paid_minor",
        "needs_review",
        "created_at",
    ]
    list_filter = ["status", "needs_review"]
    search_fields = ["number", "email", "payment_intent_id"]
    exclude = ["public_token"]
    inlines = [OrderLineInline]
