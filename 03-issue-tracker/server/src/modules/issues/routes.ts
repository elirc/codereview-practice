import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { EmptyBody } from '../../lib/schemas.js';
import {
  BulkStatusBody,
  BulkStatusResult,
  CreateIssueBody,
  IssueDetail,
  IssuePage,
  IssueParams,
  IssuesParams,
  ListIssuesQuery,
  PatchIssueBody,
  ProjectIssuesParams,
  PutLabelsBody,
} from './schemas.js';
import {
  bulkUpdateStatus,
  createIssue,
  deleteIssue,
  getIssue,
  listIssues,
  patchIssue,
  replaceLabels,
} from './service.js';

const ISSUE_PATH = '/projects/:projectKey/issues/:number';

export const issueRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/issues',
    {
      schema: { params: IssuesParams, querystring: ListIssuesQuery, response: { 200: IssuePage } },
    },
    async (request) => listIssues(app.deps, request.tenant, request.query),
  );

  app.post(
    '/issues/bulk-status',
    { schema: { params: IssuesParams, body: BulkStatusBody, response: { 200: BulkStatusResult } } },
    async (request) => bulkUpdateStatus(app.deps, request.tenant, request.body),
  );

  app.post(
    '/projects/:projectKey/issues',
    {
      schema: {
        params: ProjectIssuesParams,
        body: CreateIssueBody,
        response: { 201: IssueDetail },
      },
    },
    async (request, reply) => {
      const issue = await createIssue(
        app.deps,
        request.tenant,
        request.params.projectKey,
        request.body,
      );
      reply.code(201);
      return issue;
    },
  );

  app.get(
    ISSUE_PATH,
    { schema: { params: IssueParams, response: { 200: IssueDetail } } },
    async (request) => getIssue(app.deps, request.tenant, request.params),
  );

  app.patch(
    ISSUE_PATH,
    { schema: { params: IssueParams, body: PatchIssueBody, response: { 200: IssueDetail } } },
    async (request) => patchIssue(app.deps, request.tenant, request.params, request.body),
  );

  app.put(
    `${ISSUE_PATH}/labels`,
    { schema: { params: IssueParams, body: PutLabelsBody, response: { 200: IssueDetail } } },
    async (request) => replaceLabels(app.deps, request.tenant, request.params, request.body),
  );

  app.delete(
    ISSUE_PATH,
    { schema: { params: IssueParams, body: EmptyBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await deleteIssue(app.deps, request.tenant, request.params);
      return reply.code(204).send();
    },
  );
};
