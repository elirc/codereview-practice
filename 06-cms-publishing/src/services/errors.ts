export type ErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "invalid_credentials"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "invalid_state"
  | "invalid_revision"
  | "schedule_in_past"
  | "schedule_too_far"
  | "slug_taken"
  | "email_taken"
  | "invalid_media_reference"
  | "media_in_use"
  | "file_too_large"
  | "unsupported_media_type"
  | "internal_error";

/** An expected, client-facing failure. Mapped to a status code in one place (`src/http/errors.ts`). */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function notFoundError(message = "Not found."): DomainError {
  return new DomainError("not_found", message);
}

export function forbiddenError(message = "You are not allowed to do that."): DomainError {
  return new DomainError("forbidden", message);
}
