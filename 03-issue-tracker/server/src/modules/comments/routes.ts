import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { EmptyBody } from '../../lib/schemas.js';
import {
  Comment,
  CommentBodyInput,
  CommentPage,
  CommentParams,
  CommentsParams,
  ListCommentsQuery,
} from './schemas.js';
import { addComment, deleteComment, editComment, listComments } from './service.js';

const COMMENTS_PATH = '/projects/:projectKey/issues/:number/comments';

export const commentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    COMMENTS_PATH,
    {
      schema: {
        params: CommentsParams,
        querystring: ListCommentsQuery,
        response: { 200: CommentPage },
      },
    },
    async (request) => listComments(app.deps, request.tenant, request.params, request.query),
  );

  app.post(
    COMMENTS_PATH,
    { schema: { params: CommentsParams, body: CommentBodyInput, response: { 201: Comment } } },
    async (request, reply) => {
      const comment = await addComment(
        app.deps,
        request.tenant,
        request.params,
        request.body.body,
      );
      reply.code(201);
      return comment;
    },
  );

  app.patch(
    `${COMMENTS_PATH}/:commentId`,
    { schema: { params: CommentParams, body: CommentBodyInput, response: { 200: Comment } } },
    async (request) =>
      editComment(
        app.deps,
        request.tenant,
        request.params,
        request.params.commentId,
        request.body.body,
      ),
  );

  app.delete(
    `${COMMENTS_PATH}/:commentId`,
    { schema: { params: CommentParams, body: EmptyBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await deleteComment(app.deps, request.tenant, request.params, request.params.commentId);
      return reply.code(204).send();
    },
  );
};
