import { Type } from '@sinclair/typebox';
import {
  CursorParam,
  Limit,
  Nullable,
  OrgParams,
  Page,
  StrictObject,
  UserSummary,
  Uuid,
} from '../../lib/schemas.js';
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

export const IssuesParams = OrgParams({});
export const ProjectIssuesParams = OrgParams({ projectKey: ProjectKeyParam });
export const IssueParams = OrgParams({ projectKey: ProjectKeyParam, number: IssueNumberParam });

export const IssueSort = Type.Union([
  Type.Literal('created'),
  Type.Literal('updated'),
  Type.Literal('priority'),
]);

export const ListIssuesQuery = StrictObject({
  projectKey: Type.Optional(ProjectKeyParam),
  status: Type.Optional(Type.Array(IssueStatus, { maxItems: 5 })),
  assigneeId: Type.Optional(Type.Union([Type.Literal('none'), Uuid])),
  labelId: Type.Optional(Type.Array(Uuid, { maxItems: 20 })),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' })),
  sort: Type.Optional(IssueSort),
  limit: Type.Optional(Limit),
  cursor: Type.Optional(CursorParam),
});

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

export const BulkStatusBody = StrictObject({
  issueIds: Type.Array(Uuid, { minItems: 1, maxItems: 100, uniqueItems: true }),
  status: IssueStatus,
});

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

export const IssuePage = Page(IssueSummary);

export const BulkStatusResult = Type.Object({ items: Type.Array(IssueSummary) });
