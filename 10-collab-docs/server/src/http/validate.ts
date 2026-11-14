import { z } from 'zod';
import { errors } from './errors.js';

/** Parses input with a schema and returns the typed value, or throws `validation_failed`. */
export function validate<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw errors.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const uuid = z.string().uuid();

export const emptyBody = z.object({}).strict();
