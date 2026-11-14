import uuid
from collections.abc import Iterable
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any

from app.models import AuditEvent
from app.services.context import ServiceContext

JsonDict = dict[str, Any]


def to_jsonable(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    return value


def snapshot(entity: object, fields: Iterable[str]) -> JsonDict:
    return {name: to_jsonable(getattr(entity, name)) for name in fields}


def changed_fields(before: JsonDict, after: JsonDict) -> tuple[JsonDict, JsonDict]:
    """Reduce two snapshots to the keys whose values differ."""
    keys = [key for key in after if before.get(key) != after[key]]
    return {key: before.get(key) for key in keys}, {key: after[key] for key in keys}


def record(
    ctx: ServiceContext,
    *,
    entity_type: str,
    entity_id: uuid.UUID,
    action: str,
    before: JsonDict | None = None,
    after: JsonDict | None = None,
    report_id: uuid.UUID | None = None,
) -> None:
    """Add an audit event to the caller's unit of work; it commits with the change."""
    ctx.db.add(
        AuditEvent(
            at=ctx.now,
            actor_id=ctx.actor.id,
            request_id=ctx.request_id,
            entity_type=entity_type,
            entity_id=entity_id,
            report_id=report_id,
            action=action,
            before=before,
            after=after,
        )
    )
