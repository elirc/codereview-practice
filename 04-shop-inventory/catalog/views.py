from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response

from core.permissions import IsManager, is_staff_member

from . import services
from .models import Product
from .serializers import (
    ProductCreateSerializer,
    ProductSerializer,
    ProductUpdateSerializer,
    StaffProductSerializer,
)


def _visible_products(request: Request) -> QuerySet[Product]:
    queryset = Product.objects.select_related("stock").order_by("sku")
    if not is_staff_member(request.user):
        queryset = queryset.filter(active=True)
    return queryset


def _serializer_for(request: Request) -> type[ProductSerializer]:
    return StaffProductSerializer if is_staff_member(request.user) else ProductSerializer


class ProductListCreateView(generics.ListAPIView):
    def get_permissions(self):
        if self.request.method == "POST":
            return [IsManager()]
        return [AllowAny()]

    def get_queryset(self) -> QuerySet[Product]:
        return _visible_products(self.request)

    def get_serializer_class(self) -> type[ProductSerializer]:
        return _serializer_for(self.request)

    def post(self, request: Request) -> Response:
        serializer = ProductCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        product = services.create_product(**serializer.validated_data)
        product = Product.objects.select_related("stock").get(pk=product.pk)
        return Response(StaffProductSerializer(product).data, status=status.HTTP_201_CREATED)


class ProductDetailView(generics.RetrieveAPIView):
    lookup_field = "sku"

    def get_permissions(self):
        if self.request.method == "PATCH":
            return [IsManager()]
        return [AllowAny()]

    def get_queryset(self) -> QuerySet[Product]:
        return _visible_products(self.request)

    def get_serializer_class(self) -> type[ProductSerializer]:
        return _serializer_for(self.request)

    def patch(self, request: Request, sku: str) -> Response:
        product = get_object_or_404(Product.objects.select_related("stock"), sku=sku)
        serializer = ProductUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        services.update_product(product, dict(serializer.validated_data))
        return Response(StaffProductSerializer(product).data)
