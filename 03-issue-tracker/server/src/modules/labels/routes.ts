import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { EmptyBody } from '../../lib/schemas.js';
import {
  CreateLabelBody,
  Label,
  LabelList,
  LabelParams,
  LabelsParams,
  UpdateLabelBody,
} from './schemas.js';
import { createLabel, deleteLabel, listLabels, updateLabel } from './service.js';

export const labelRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/labels',
    { schema: { params: LabelsParams, response: { 200: LabelList } } },
    async (request) => listLabels(app.deps, request.tenant),
  );

  app.post(
    '/labels',
    { schema: { params: LabelsParams, body: CreateLabelBody, response: { 201: Label } } },
    async (request, reply) => {
      const label = await createLabel(app.deps, request.tenant, request.body);
      reply.code(201);
      return label;
    },
  );

  app.patch(
    '/labels/:labelId',
    { schema: { params: LabelParams, body: UpdateLabelBody, response: { 200: Label } } },
    async (request) =>
      updateLabel(app.deps, request.tenant, request.params.labelId, request.body),
  );

  app.delete(
    '/labels/:labelId',
    { schema: { params: LabelParams, body: EmptyBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await deleteLabel(app.deps, request.tenant, request.params.labelId);
      return reply.code(204).send();
    },
  );
};
