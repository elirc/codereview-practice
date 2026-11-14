import { forbiddenError } from "@/services/errors";

/**
 * Rejects browser requests whose Origin does not match the host they were sent to.
 * Server actions get the same check from Next.js; route handlers that change state call this.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbiddenError("Cross-site request refused.");
  }
  if (!host || originHost !== host) throw forbiddenError("Cross-site request refused.");
}
