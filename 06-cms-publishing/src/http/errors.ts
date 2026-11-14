import { ZodError } from "zod";
import { logger } from "@/logger";
import { DomainError, type ErrorCode } from "@/services/errors";
import { REQUEST_ID_HEADER } from "./request-id-header";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  invalid_state: 409,
  slug_taken: 409,
  email_taken: 409,
  media_in_use: 409,
  file_too_large: 413,
  unsupported_media_type: 415,
  invalid_revision: 422,
  schedule_in_past: 422,
  schedule_too_far: 422,
  invalid_media_reference: 422,
  internal_error: 500,
};

export type ErrorBody = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
};

export type DescribedError = { status: number; body: ErrorBody };

/** Converts any thrown value into the project's error envelope. Unknown errors are logged and hidden. */
export function describeError(
  err: unknown,
  requestId: string,
  context: Record<string, unknown> = {},
): DescribedError {
  if (err instanceof DomainError) {
    const status = STATUS_BY_CODE[err.code];
    logger.info({ requestId, code: err.code, status, ...context }, "request refused");
    const body: ErrorBody = { code: err.code, message: err.message, requestId };
    if (err.details) body.details = err.details;
    return { status, body };
  }

  if (err instanceof ZodError) {
    const fields = err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    logger.info({ requestId, code: "validation_failed", ...context }, "request refused");
    return {
      status: 400,
      body: {
        code: "validation_failed",
        message: "The request is not valid.",
        details: { fields },
        requestId,
      },
    };
  }

  logger.error({ err, requestId, ...context }, "unhandled error");
  return {
    status: 500,
    body: { code: "internal_error", message: "Something went wrong.", requestId },
  };
}

export function errorResponse(
  err: unknown,
  requestId: string,
  context?: Record<string, unknown>,
): Response {
  const { status, body } = describeError(err, requestId, context);
  return Response.json(
    { error: body },
    { status, headers: { [REQUEST_ID_HEADER]: requestId, "Cache-Control": "no-store" } },
  );
}
