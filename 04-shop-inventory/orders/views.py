from typing import Any

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from core import clock, idempotency
from core.permissions import IsStaffMember, is_staff_member

from . import services
from .models import Order
from .serializers import (
    CheckoutSerializer,
    OrderFilterSerializer,
    PublicOrderSerializer,
    StaffOrderSerializer,
)


def _orders() -> QuerySet[Order]:
    return Order.objects.prefetch_related("lines")


class OrderListCreateView(generics.ListAPIView):
    serializer_class = StaffOrderSerializer

    def get_permissions(self):
        if self.request.method == "POST":
            return [AllowAny()]
        return [IsStaffMember()]

    def get_queryset(self) -> QuerySet[Order]:
        filters = OrderFilterSerializer(data=self.request.query_params.dict())
        filters.is_valid(raise_exception=True)
        queryset = _orders().order_by("-created_at")
        if "status" in filters.validated_data:
            queryset = queryset.filter(status=filters.validated_data["status"])
        if "needs_review" in filters.validated_data:
            queryset = queryset.filter(needs_review=filters.validated_data["needs_review"])
        if "email" in filters.validated_data:
            queryset = queryset.filter(email__iexact=filters.validated_data["email"])
        return queryset

    def post(self, request: Request) -> Response:
        key = idempotency.require_key(request.headers.get("Idempotency-Key"))
        serializer = CheckoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]
        lines = serializer.validated_data["lines"]
        now = clock.now()

        def reserve() -> tuple[int, dict[str, Any]]:
            order = services.place_order(email=email, lines=lines, now=now)
            return status.HTTP_201_CREATED, {"number": order.number}

        def pay(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
            order, intent = services.request_payment(body["number"], now=now)
            data = {
                **PublicOrderSerializer(order).data,
                "public_token": order.public_token,
                "client_secret": intent.client_secret,
            }
            return status.HTTP_201_CREATED, data

        result = idempotency.run(
            scope="orders.create",
            key=key,
            payload=request.data,
            action=reserve,
            finalize=pay,
        )
        return Response(result.body, status=result.status)


class OrderDetailView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request, number: str) -> Response:
        if is_staff_member(request.user):
            order = get_object_or_404(_orders(), number=number)
            return Response(StaffOrderSerializer(order).data)
        order = services.get_order_for_customer(number, request.query_params.get("token", ""))
        return Response(PublicOrderSerializer(order).data)


class OrderCancelView(APIView):
    permission_classes = [IsStaffMember]

    def post(self, request: Request, number: str) -> Response:
        order = get_object_or_404(Order, number=number)
        services.cancel_order(order.pk, now=clock.now(), actor=request.user)
        return Response(StaffOrderSerializer(_orders().get(pk=order.pk)).data)


class OrderFulfilView(APIView):
    permission_classes = [IsStaffMember]

    def post(self, request: Request, number: str) -> Response:
        order = get_object_or_404(Order, number=number)
        services.fulfil_order(order.pk)
        return Response(StaffOrderSerializer(_orders().get(pk=order.pk)).data)
