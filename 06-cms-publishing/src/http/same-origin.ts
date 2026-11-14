import { forbiddenError } from "@/services/errors";

/** Throws `forbidden` when the request's Origin header does not match its host. */
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
