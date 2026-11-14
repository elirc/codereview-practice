from django.urls import path

from . import views

urlpatterns = [
    path(
        "orders/<str:number>/refunds/",
        views.OrderRefundListCreateView.as_view(),
        name="order-refunds",
    ),
    path("webhook-events/", views.WebhookEventListView.as_view(), name="webhook-event-list"),
    path(
        "webhook-events/<str:event_id>/",
        views.WebhookEventDetailView.as_view(),
        name="webhook-event-detail",
    ),
    path(
        "webhook-events/<str:event_id>/retry/",
        views.WebhookEventRetryView.as_view(),
        name="webhook-event-retry",
    ),
]
