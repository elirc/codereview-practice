import { Type } from '@sinclair/typebox';
import {
  CursorParam,
  Email,
  Limit,
  OrgParams,
  Page,
  StrictObject,
  Uuid,
} from '../../lib/schemas.js';
import { Role } from '../auth/schemas.js';

export const MembersParams = OrgParams({});

export const MemberParams = OrgParams({
  userId: Type.Union([Type.Literal('me'), Uuid]),
});

export const ListMembersQuery = StrictObject({
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  limit: Type.Optional(Limit),
  cursor: Type.Optional(CursorParam),
});

export const AddMemberBody = StrictObject({ email: Email, role: Role });

export const UpdateMemberBody = StrictObject({ role: Role });

export const Member = Type.Object({
  userId: Type.String(),
  name: Type.String(),
  email: Type.String(),
  role: Role,
  joinedAt: Type.String(),
});

export const MemberPage = Page(Member);
