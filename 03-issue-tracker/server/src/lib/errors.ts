export type ErrorDetails = Record<string, unknown>;

/** A failure with a stable code that the error handler turns into the JSON envelope. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function unauthenticated(): AppError {
  return new AppError(401, 'unauthenticated', 'You need to sign in to do that.');
}

export function forbidden(): AppError {
  return new AppError(403, 'forbidden', 'You do not have permission to do that.');
}

export function notFound(): AppError {
  return new AppError(404, 'not_found', 'The requested resource was not found.');
}

export function invalidReference(field: string): AppError {
  return new AppError(422, 'invalid_reference', `${field} does not refer to a valid record.`, {
    field,
  });
}

export function validationFailed(fields: { path: string; message: string }[]): AppError {
  return new AppError(400, 'validation_failed', 'The request is invalid.', { fields });
}

export function conflict(code: string, message: string, details?: ErrorDetails): AppError {
  return new AppError(409, code, message, details);
}

export function unprocessable(code: string, message: string, details?: ErrorDetails): AppError {
  return new AppError(422, code, message, details);
}
