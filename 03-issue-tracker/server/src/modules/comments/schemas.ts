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
import { IssueNumberParam } from '../issues/schemas.js';
import { ProjectKeyParam } from '../projects/schemas.js';

const CommentBody = Type.String({ minLength: 1, maxLength: 10_000, pattern: '\\S' });

export const CommentsParams = OrgParams({ projectKey: ProjectKeyParam, number: IssueNumberParam });

export const CommentParams = OrgParams({
  projectKey: ProjectKeyParam,
  number: IssueNumberParam,
  commentId: Uuid,
});

export const ListCommentsQuery = StrictObject({
  limit: Type.Optional(Limit),
  cursor: Type.Optional(CursorParam),
});

export const CommentBodyInput = StrictObject({ body: CommentBody });

export const Comment = Type.Object({
  id: Type.String(),
  body: Type.String(),
  author: UserSummary,
  createdAt: Type.String(),
  editedAt: Nullable(Type.String()),
});

export const CommentPage = Page(Comment);
