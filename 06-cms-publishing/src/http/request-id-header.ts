export const REQUEST_ID_HEADER = "x-request-id";

const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Keeps a well-formed inbound request id, otherwise generates a fresh one. */
export function normalizeRequestId(value: string | null | undefined): string {
  if (value && ACCEPTED_REQUEST_ID.test(value)) return value;
  return crypto.randomUUID();
}
