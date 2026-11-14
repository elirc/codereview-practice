import { headers } from "next/headers";
import { REQUEST_ID_HEADER, normalizeRequestId } from "./request-id-header";

/** The id assigned by middleware, or a new one for requests middleware does not see. */
export async function getRequestId(): Promise<string> {
  const requestHeaders = await headers();
  return normalizeRequestId(requestHeaders.get(REQUEST_ID_HEADER));
}
