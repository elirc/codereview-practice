from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import generics
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from catalog.models import Product
from core.permissions import IsManager, IsStaffMember

from . import services
from .models import StockItem, StockMovement
from .serializers import (
    AdjustStockSerializer,
    ReceiveStockSerializer,
    StockLevelSerializer,
    StockMovementSerializer,
    StocktakeSerializer,
)


def _stock_response(product: Product, item: StockItem) -> Response:
    item.product = product
    return Response(StockLevelSerializer(item).data)


class ReceiveStockView(APIView):
    permission_classes = [IsStaffMember]

    def post(self, request: Request, sku: str) -> Response:
        product = get_object_or_404(Product, sku=sku)
        serializer = ReceiveStockSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        item = services.receive_stock(
            product,
            quantity=serializer.validated_data["quantity"],
            reason=serializer.validated_data["reason"],
            actor=request.user,
        )
        return _stock_response(product, item)


class AdjustStockView(APIView):
    permission_classes = [IsManager]

    def post(self, request: Request, sku: str) -> Response:
        product = get_object_or_404(Product, sku=sku)
        serializer = AdjustStockSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        item = services.adjust_stock(
            product,
            delta=serializer.validated_data["delta"],
            reason=serializer.validated_data["reason"],
            actor=request.user,
        )
        return _stock_response(product, item)


class StockMovementListView(generics.ListAPIView):
    permission_classes = [IsStaffMember]
    serializer_class = StockMovementSerializer

    def get_queryset(self) -> QuerySet[StockMovement]:
        product = get_object_or_404(Product, sku=self.kwargs["sku"])
        return (
            StockMovement.objects.filter(product=product)
            .select_related("actor")
            .order_by("-created_at", "-id")
        )


class StocktakeView(APIView):
    permission_classes = [IsStaffMember]

    def post(self, request: Request) -> Response:
        serializer = StocktakeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        counts = [services.StockCount(**count) for count in serializer.validated_data["counts"]]
        results = services.apply_stocktake(
            counts,
            reason=serializer.validated_data["reason"],
            actor=request.user,
        )
        levels = []
        for product, item in results:
            item.product = product
            levels.append(StockLevelSerializer(item).data)
        return Response({"results": levels})
