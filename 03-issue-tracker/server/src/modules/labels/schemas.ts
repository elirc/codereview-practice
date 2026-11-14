import { Type } from '@sinclair/typebox';
import { OrgParams, StrictObject, Uuid } from '../../lib/schemas.js';

const LabelName = Type.String({ minLength: 1, maxLength: 40, pattern: '\\S' });
const Color = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });

export const LabelsParams = OrgParams({});
export const LabelParams = OrgParams({ labelId: Uuid });

export const CreateLabelBody = StrictObject({ name: LabelName, color: Color });

export const UpdateLabelBody = Type.Object(
  { name: Type.Optional(LabelName), color: Type.Optional(Color) },
  { additionalProperties: false, minProperties: 1 },
);

export const Label = Type.Object({
  id: Type.String(),
  name: Type.String(),
  color: Type.String(),
});

export const LabelList = Type.Object({ items: Type.Array(Label) });
