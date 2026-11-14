from django.conf import settings
from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from core import clock, idempotency
from core.permissions import CLERK, IsStaffMember, role_of
from orders.models import Order

from .models import Refund
from .serializers import RefundCreateSerializer, RefundSerializer
from .services import refunds, webhooks


def _refunds() -> QuerySet[Refund]:
    return Refund.objects.select_related("order", "created_by").prefetch_related(
        "lines__order_line",
    )


class OrderRefundListCreateView(generics.ListAPIView):
    permission_classes = [IsStaffMember]
    serializer_class = RefundSerializer

    def get_queryset(self) -> QuerySet[Refund]:
        order = get_object_or_404(Order, number=self.kwargs["number"])
        return _refunds().filter(order=order).order_by("created_at")

    def post(self, request: Request, number: str) -> Response:
        key = idempotency.require_key(request.headers.get("Idempotency-Key"))
        serializer = RefundCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        lines = None
        if "lines" in data:
            lines = [refunds.RefundLineRequest(**line) for line in data["lines"]]
        refund_request = refunds.RefundRequest(
            reason=data["reason"],
            lines=lines,
            amount_minor=data.get("amount_minor"),
        )
        limit = settings.CLERK_REFUND_LIMIT_MINOR if role_of(request.user) == CLERK else None

        def create() -> tuple[int, dict]:
            refund = refunds.create_refund(
                order_number=number,
                request=refund_request,
                actor=request.user,
                limit_minor=limit,
            )
            return status.HTTP_202_ACCEPTED, RefundSerializer(_refunds().get(pk=refund.pk)).data

        result = idempotency.run(
            scope="refunds.create",
            key=key,
            payload={"order": number, "body": request.data},
            action=create,
        )
        return Response(result.body, status=result.status)


class PaymentWebhookView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request: Request) -> Response:
        outcome = webhooks.receive_webhook(
            body=request.body,
            signature_header=request.headers.get("X-Pay-Signature"),
            now=clock.now(),
        )
        return Response({"status": outcome})
