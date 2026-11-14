import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from 'fastify';
import { AppError, type ErrorDetails } from '../lib/errors.js';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
    requestId: string;
  };
}

const CLIENT_ERROR_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'bad_request', message: 'The request could not be understood.' },
  404: { code: 'not_found', message: 'The requested resource was not found.' },
  405: { code: 'method_not_allowed', message: 'This method is not allowed.' },
  413: { code: 'payload_too_large', message: 'The request body is too large.' },
  415: { code: 'unsupported_media_type', message: 'The request content type is not supported.' },
};

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
  details?: ErrorDetails,
): FastifyReply {
  const body: ErrorEnvelope = { error: { code, message, requestId: request.id } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return reply.code(statusCode).type('application/json; charset=utf-8').send(body);
}

function validationPath(context: string, issue: FastifySchemaValidationError): string {
  const segments = issue.instancePath.split('/').filter((segment) => segment.length > 0);
  const params = issue.params as Record<string, unknown>;
  const extra = params.additionalProperty ?? params.missingProperty;
  if (typeof extra === 'string') {
    segments.push(extra);
  }
  return [context, ...segments].join('.');
}

/** Installs the single place where errors become JSON responses. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return sendError(reply, request, 404, 'not_found', 'The requested resource was not found.');
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, request, error.statusCode, error.code, error.message, error.details);
    }

    if (error.validation) {
      const context = error.validationContext ?? 'body';
      const fields = error.validation.map((issue) => ({
        path: validationPath(context, issue),
        message: issue.message ?? 'is invalid',
      }));
      return sendError(reply, request, 400, 'validation_failed', 'The request is invalid.', {
        fields,
      });
    }

    const status = error.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const mapped = CLIENT_ERROR_CODES[status] ?? CLIENT_ERROR_CODES[400];
      return sendError(reply, request, status, mapped.code, mapped.message);
    }

    request.log.error({ err: error }, 'unhandled error');
    return sendError(reply, request, 500, 'internal_error', 'Something went wrong on our side.');
  });
}
