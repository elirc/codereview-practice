from django.contrib.auth.base_user import AbstractBaseUser
from django.contrib.auth.models import AnonymousUser
from rest_framework.permissions import BasePermission

MANAGER = "manager"
CLERK = "clerk"


def role_of(user: AbstractBaseUser | AnonymousUser | None) -> str | None:
    """Return the staff role of ``user``: ``manager``, ``clerk`` or ``None``."""
    if user is None or not user.is_authenticated:
        return None
    names = set(user.groups.filter(name__in=(MANAGER, CLERK)).values_list("name", flat=True))
    if MANAGER in names:
        return MANAGER
    if CLERK in names:
        return CLERK
    return None


def is_staff_member(user: AbstractBaseUser | AnonymousUser | None) -> bool:
    return role_of(user) is not None


class IsStaffMember(BasePermission):
    def has_permission(self, request, view) -> bool:
        return is_staff_member(request.user)


class IsManager(BasePermission):
    def has_permission(self, request, view) -> bool:
        return role_of(request.user) == MANAGER
