import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { EmptyBody } from '../../lib/schemas.js';
import {
  CreateProjectBody,
  Project,
  ProjectList,
  ProjectParams,
  ProjectsParams,
  UpdateProjectBody,
} from './schemas.js';
import { archiveProject, createProject, listProjects, renameProject } from './service.js';

export const projectRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/projects',
    { schema: { params: ProjectsParams, response: { 200: ProjectList } } },
    async (request) => listProjects(app.deps, request.tenant),
  );

  app.post(
    '/projects',
    { schema: { params: ProjectsParams, body: CreateProjectBody, response: { 201: Project } } },
    async (request, reply) => {
      const project = await createProject(app.deps, request.tenant, request.body);
      reply.code(201);
      return project;
    },
  );

  app.patch(
    '/projects/:projectKey',
    { schema: { params: ProjectParams, body: UpdateProjectBody, response: { 200: Project } } },
    async (request) =>
      renameProject(app.deps, request.tenant, request.params.projectKey, request.body),
  );

  app.post(
    '/projects/:projectKey/archive',
    { schema: { params: ProjectParams, body: EmptyBody, response: { 200: Project } } },
    async (request) => archiveProject(app.deps, request.tenant, request.params.projectKey),
  );
};
