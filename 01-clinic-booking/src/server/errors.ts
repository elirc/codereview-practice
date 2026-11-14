import type { ZodError } from "zod";

export const ERROR_STATUS = {
  validation_failed: 400,
  invalid_json: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  csrf_failed: 403,
  not_found: 404,
  email_taken: 409,
  slot_taken: 409,
  patient_conflict: 409,
  invalid_state: 409,
  exception_exists: 409,
  not_a_slot: 422,
  in_past: 422,
  too_soon: 422,
  beyond_horizon: 422,
  daily_limit: 422,
  idempotency_key_reused: 422,
  cancellation_window_closed: 422,
  already_started: 422,
  not_started: 422,
  rule_overlap: 422,
  provider_not_in_clinic: 422,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface FieldError {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = ERROR_STATUS[code];
  }
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return { error: { code, message, ...(details ? { details } : {}), requestId } };
}

export function validationError(
  fields: FieldError[],
  message = "The request contains invalid fields.",
): AppError {
  return new AppError("validation_failed", message, { fields });
}

export function zodFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function notFound(what = "Resource"): AppError {
  return new AppError("not_found", `${what} not found.`);
}

export function forbidden(): AppError {
  return new AppError("forbidden", "You are not allowed to perform this action.");
}

export function unauthenticated(): AppError {
  return new AppError("unauthenticated", "Sign in to continue.");
}

export function invalidState(): AppError {
  return new AppError("invalid_state", "The appointment is no longer in a state that allows this.");
}
