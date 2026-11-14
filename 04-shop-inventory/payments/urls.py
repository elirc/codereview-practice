from django.urls import path

from . import views

urlpatterns = [
    path(
        "orders/<str:number>/refunds/",
        views.OrderRefundListCreateView.as_view(),
        name="order-refunds",
    ),
]
