from datetime import datetime, timedelta

from django.contrib.auth.models import Group, User
from django.core.management.base import BaseCommand
from django.db import transaction

from catalog.models import Product
from catalog.services import create_product
from core import clock
from core.permissions import CLERK, MANAGER
from inventory.services import receive_stock
from orders import services as order_services
from orders.models import Order

USERS = [
    ("manager", "manager-pass-123", MANAGER, False),
    ("clerk", "clerk-pass-123", CLERK, False),
    ("admin", "admin-pass-123", None, True),
]

PRODUCTS = [
    ("MUG-BLUE", "Blue enamel mug", 1200, 40),
    ("MUG-RED", "Red enamel mug", 1200, 3),
    ("TEA-EARL", "Earl Grey, 100 g", 650, 25),
    ("TEA-GREEN", "Sencha green tea, 100 g", 800, 0),
    ("POT-CAST", "Cast iron teapot", 5400, 6),
]

SEED_CUSTOMER = "seed.customer@example.com"


class Command(BaseCommand):
    help = "Create demo users, products, stock and orders. Safe to run repeatedly."

    def handle(self, *args, **options) -> None:
        users = {username: self._user(username, *spec) for username, *spec in USERS}
        for sku, *spec in PRODUCTS:
            self._product(sku, *spec, actor=users["manager"])
        if not Order.objects.filter(email=SEED_CUSTOMER).exists():
            self._orders(actor=users["clerk"])
        self.stdout.write(self.style.SUCCESS("Seed data is in place."))

    def _user(self, username: str, password: str, role: str | None, superuser: bool) -> User:
        user = User.objects.filter(username=username).first()
        if user is None:
            create = User.objects.create_superuser if superuser else User.objects.create_user
            user = create(username=username, email=f"{username}@shop.test", password=password)
        if role is not None:
            group, _ = Group.objects.get_or_create(name=role)
            user.groups.add(group)
        return user

    def _product(self, sku: str, name: str, price: int, stock: int, *, actor: User) -> None:
        if Product.objects.filter(sku=sku).exists():
            return
        product = create_product(sku=sku, name=name, price_minor=price)
        if stock:
            receive_stock(product, quantity=stock, reason="opening stock", actor=actor)

    def _orders(self, *, actor: User) -> None:
        now = clock.now()

        def place(lines: list[tuple[str, int]], placed_at: datetime) -> Order:
            order = order_services.place_order(
                email=SEED_CUSTOMER,
                lines=[order_services.LineRequest(sku=sku, quantity=qty) for sku, qty in lines],
                now=placed_at,
            )
            order, _ = order_services.request_payment(order.number, now=placed_at)
            return order

        place([("MUG-BLUE", 2), ("TEA-EARL", 1)], now)

        paid = place([("POT-CAST", 1), ("TEA-EARL", 2)], now)
        with transaction.atomic():
            locked = Order.objects.select_for_update().get(pk=paid.pk)
            order_services.pay_pending_order(locked, amount_paid_minor=locked.total_minor, now=now)

        cancelled = place([("MUG-RED", 1)], now)
        order_services.cancel_order(cancelled.pk, now=now, actor=actor)

        stale = place([("MUG-BLUE", 1)], now - timedelta(hours=2))
        order_services.expire_order(stale.pk, now=now)
