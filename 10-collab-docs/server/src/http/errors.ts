import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ErrorDetails = Record<string, unknown>;

/** A failure that maps to one error envelope response. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(statusCode: number, code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface FieldIssue {
  path: string;
  message: string;
}

export const errors = {
  validation: (fields: FieldIssue[]) =>
    new AppError(400, 'validation_failed', 'The request is invalid.', { fields }),
  unauthenticated: () => new AppError(401, 'unauthenticated', 'Sign in to continue.'),
  invalidCredentials: () =>
    new AppError(401, 'invalid_credentials', 'The email or password is incorrect.'),
  forbidden: (message = 'You are not allowed to do that.') =>
    new AppError(403, 'forbidden', message),
  notFound: (message = 'The resource was not found.') => new AppError(404, 'not_found', message),
  invalidState: (message: string, status = 409) => new AppError(status, 'invalid_state', message),
  externalSharingDisabled: () =>
    new AppError(
      422,
      'external_sharing_disabled',
      'This workspace does not allow sharing with people outside it.',
    ),
  userNotFound: () => new AppError(422, 'user_not_found', 'No user has that email address.'),
  notAMember: () =>
    new AppError(422, 'not_a_member', 'The user is not a member of this workspace.'),
  ownerRequired: (message = 'The workspace owner cannot be removed or demoted.') =>
    new AppError(422, 'owner_required', message),
  anchorUnknown: () =>
    new AppError(409, 'anchor_unknown', 'The anchored text has not reached the server yet.'),
  emptyAnchor: () => new AppError(422, 'empty_anchor', 'A comment must cover some text.'),
};

/** Sends the error envelope for the given status and code. */
export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details: ErrorDetails = {},
): FastifyReply {
  return reply.status(statusCode).send({
    error: { code, message, details, requestId: request.id },
  });
}

const frameworkMessages: Record<number, string> = {
  400: 'The request is invalid.',
  413: 'The request body is too large.',
  415: 'Requests must be sent as application/json.',
};

/** Installs the single error handler and the not-found handler. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(request, reply, error.statusCode, error.code, error.message, error.details);
    }
    const statusCode = (error as FastifyError).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const message = frameworkMessages[statusCode] ?? 'The request could not be processed.';
      const code = statusCode === 404 ? 'not_found' : 'validation_failed';
      return sendError(request, reply, statusCode, code, message);
    }
    request.log.error({ err: error }, 'request failed');
    return sendError(request, reply, 500, 'internal_error', 'Something went wrong.');
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(request, reply, 404, 'not_found', 'The resource was not found.'),
  );
}
