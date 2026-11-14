import { Type } from '@sinclair/typebox';
import { Email, StrictObject } from '../../lib/schemas.js';

export const Role = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
  Type.Literal('viewer'),
]);

export const RegisterBody = StrictObject({
  email: Email,
  name: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});

export const LoginBody = StrictObject({
  email: Type.String({ minLength: 1, maxLength: 320 }),
  password: Type.String({ minLength: 1, maxLength: 200 }),
});

export const User = Type.Object({
  id: Type.String(),
  email: Type.String(),
  name: Type.String(),
});

export const MeResponse = Type.Object({
  user: User,
  memberships: Type.Array(
    Type.Object({ orgSlug: Type.String(), orgName: Type.String(), role: Role }),
  ),
});
