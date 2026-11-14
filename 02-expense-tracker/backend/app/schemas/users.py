import uuid
from typing import Annotated

from pydantic import Field, StringConstraints, model_validator

from app.domain.enums import Role
from app.schemas.common import MAX_BIGINT, OutModel, StrictModel


class UserOut(OutModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: Role
    manager_id: uuid.UUID | None
    approval_limit_minor: int
    active: bool


class UserSummary(OutModel):
    id: uuid.UUID
    full_name: str


class UserUpdate(StrictModel):
    role: Role | None = None
    manager_id: uuid.UUID | None = None
    approval_limit_minor: Annotated[int, Field(ge=0, le=MAX_BIGINT)] | None = None
    active: bool | None = None

    @model_validator(mode="after")
    def _only_manager_may_be_cleared(self) -> "UserUpdate":
        for name in ("role", "approval_limit_minor", "active"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class LoginIn(StrictModel):
    email: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=254)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=1024)]


class MeOut(OutModel):
    user: UserOut
    base_currency: str
