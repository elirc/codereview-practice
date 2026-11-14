import { Type, type TProperties, type TSchema } from '@sinclair/typebox';

export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export const Uuid = Type.String({ pattern: UUID_PATTERN });

export const Email = Type.String({ minLength: 3, maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+$' });

/** Request schemas reject unknown properties. */
export function StrictObject<T extends TProperties>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

export const EmptyBody = StrictObject({});

// Null comes first so Ajv's type coercion never turns null into an empty string.
export function Nullable<T extends TSchema>(schema: T) {
  return Type.Union([Type.Null(), schema]);
}

export const UserSummary = Type.Object({ id: Type.String(), name: Type.String() });

export const Limit = Type.Integer({ minimum: 1, maximum: 100, default: 25 });

export const CursorParam = Type.String({ minLength: 1, maxLength: 512 });

export function Page<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item), nextCursor: Nullable(Type.String()) });
}

export const OrgSlugParam = Type.String({ minLength: 1, maxLength: 64 });

/** Path params for routes under /orgs/:orgSlug. */
export function OrgParams<T extends TProperties>(properties: T) {
  return StrictObject({ orgSlug: OrgSlugParam, ...properties });
}
