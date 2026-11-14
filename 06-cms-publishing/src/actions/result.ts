import { describeError, type ErrorBody } from "@/http/errors";
import { getRequestId } from "@/http/request-id";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

/** Runs a server action body and folds any thrown error into the action result shape. */
export async function runAction<T>(
  action: string,
  work: () => Promise<T>,
): Promise<ActionResult<T>> {
  const requestId = await getRequestId();
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    return { ok: false, error: describeError(err, requestId, { action }).body };
  }
}
