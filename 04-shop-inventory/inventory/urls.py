from django.urls import path

from . import views

urlpatterns = [
    path(
        "products/<str:sku>/stock/receive/",
        views.ReceiveStockView.as_view(),
        name="stock-receive",
    ),
    path(
        "products/<str:sku>/stock/adjust/",
        views.AdjustStockView.as_view(),
        name="stock-adjust",
    ),
    path(
        "products/<str:sku>/stock/movements/",
        views.StockMovementListView.as_view(),
        name="stock-movements",
    ),
]
