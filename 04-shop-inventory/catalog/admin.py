from django.contrib import admin

from core.admin import ReadOnlyAdmin

from .models import Product


@admin.register(Product)
class ProductAdmin(ReadOnlyAdmin):
    list_display = ["sku", "name", "price_minor", "active", "updated_at"]
    list_filter = ["active"]
    search_fields = ["sku", "name"]
