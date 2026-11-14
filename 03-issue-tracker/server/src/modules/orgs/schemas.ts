import { Type } from '@sinclair/typebox';
import { OrgParams, StrictObject } from '../../lib/schemas.js';
import { Role } from '../auth/schemas.js';

const OrgName = Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' });

export const CreateOrgBody = StrictObject({
  slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,38}$' }),
  name: OrgName,
});

export const UpdateOrgBody = StrictObject({ name: OrgName });

export const OrgOnlyParams = OrgParams({});

export const Org = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  role: Role,
});
