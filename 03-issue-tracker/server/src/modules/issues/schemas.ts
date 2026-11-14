import { Type } from '@sinclair/typebox';
import { Nullable, OrgParams, StrictObject, UserSummary, Uuid } from '../../lib/schemas.js';
import { Label } from '../labels/schemas.js';
import { ProjectKeyParam } from '../projects/schemas.js';

export const IssueStatus = Type.Union([
  Type.Literal('backlog'),
  Type.Literal('todo'),
  Type.Literal('in_progress'),
  Type.Literal('done'),
  Type.Literal('cancelled'),
]);

export const Priority = Type.Integer({ minimum: 0, maximum: 4 });

const Title = Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' });
const Description = Type.String({ maxLength: 20_000 });
const Version = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
export const LabelIds = Type.Array(Uuid, { maxItems: 20, uniqueItems: true });

export const IssueNumberParam = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });

export const ProjectIssuesParams = OrgParams({ projectKey: ProjectKeyParam });
export const IssueParams = OrgParams({ projectKey: ProjectKeyParam, number: IssueNumberParam });

export const CreateIssueBody = StrictObject({
  title: Title,
  description: Type.Optional(Description),
  status: Type.Optional(IssueStatus),
  priority: Type.Optional(Priority),
  assigneeId: Type.Optional(Nullable(Uuid)),
  labelIds: Type.Optional(LabelIds),
});

export const PatchIssueBody = StrictObject({
  version: Version,
  title: Type.Optional(Title),
  description: Type.Optional(Description),
  status: Type.Optional(IssueStatus),
  priority: Type.Optional(Priority),
  assigneeId: Type.Optional(Nullable(Uuid)),
  projectKey: Type.Optional(ProjectKeyParam),
});

export const PutLabelsBody = StrictObject({ version: Version, labelIds: LabelIds });

const issueFields = {
  id: Type.String(),
  identifier: Type.String(),
  projectKey: Type.String(),
  number: Type.Integer(),
  title: Type.String(),
  status: IssueStatus,
  priority: Type.Integer(),
  assignee: Nullable(UserSummary),
  labels: Type.Array(Label),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
};

export const IssueSummary = Type.Object(issueFields);

export const IssueDetail = Type.Object({
  ...issueFields,
  description: Type.String(),
  reporter: UserSummary,
});
