from django.contrib import admin

from core.admin import ReadOnlyAdmin, ReadOnlyTabularInline

from .models import Refund, RefundLine, WebhookEvent


class RefundLineInline(ReadOnlyTabularInline):
    model = RefundLine
    fields = ["order_line", "quantity", "restock"]


@admin.register(Refund)
class RefundAdmin(ReadOnlyAdmin):
    list_display = ["id", "order", "amount_minor", "status", "source", "created_at"]
    list_filter = ["status", "source"]
    list_select_related = ["order"]
    search_fields = ["order__number", "provider_refund_id"]
    inlines = [RefundLineInline]


@admin.register(WebhookEvent)
class WebhookEventAdmin(ReadOnlyAdmin):
    list_display = ["provider_event_id", "type", "status", "attempts", "received_at"]
    list_filter = ["status", "type"]
    search_fields = ["provider_event_id"]
