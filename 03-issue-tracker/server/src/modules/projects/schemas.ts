import { Type } from '@sinclair/typebox';
import { Nullable, OrgParams, StrictObject } from '../../lib/schemas.js';

const ProjectName = Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' });

/** Path segment for a project; unknown or malformed keys resolve to 404. */
export const ProjectKeyParam = Type.String({ minLength: 1, maxLength: 20 });

export const ProjectsParams = OrgParams({});
export const ProjectParams = OrgParams({ projectKey: ProjectKeyParam });

export const CreateProjectBody = StrictObject({
  key: Type.String({ pattern: '^[A-Z]{2,6}$' }),
  name: ProjectName,
});

export const UpdateProjectBody = StrictObject({ name: ProjectName });

export const Project = Type.Object({
  id: Type.String(),
  key: Type.String(),
  name: Type.String(),
  archivedAt: Nullable(Type.String()),
  createdAt: Type.String(),
});

export const ProjectList = Type.Object({ items: Type.Array(Project) });
