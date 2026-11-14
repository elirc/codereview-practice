from django.urls import path

from . import views

urlpatterns = [
    path("orders/", views.OrderListCreateView.as_view(), name="order-list"),
    path("orders/<str:number>/", views.OrderDetailView.as_view(), name="order-detail"),
    path("orders/<str:number>/cancel/", views.OrderCancelView.as_view(), name="order-cancel"),
    path("orders/<str:number>/fulfil/", views.OrderFulfilView.as_view(), name="order-fulfil"),
]
