import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { env } from "./env";
import { AppError, errorEnvelope, validationError, zodFieldErrors } from "./errors";
import { logger, type Logger } from "./logger";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RouteContext<P> {
  req: Request;
  params: P;
  requestId: string;
  log: Logger;
}

type Params = Record<string, string>;

/**
 * Wraps an App Router handler with request ids, request logging, the CSRF policy for
 * mutating methods and the single mapping from thrown errors to the error envelope.
 */
export function route<P extends Params = Params>(
  handler: (ctx: RouteContext<P>) => Promise<Response>,
) {
  return async (req: Request, segment: { params: Promise<P> }): Promise<Response> => {
    const inbound = req.headers.get("x-request-id");
    const requestId = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
    const log = logger.child({ requestId });
    const startedAt = performance.now();

    let response: Response;
    try {
      if (MUTATING_METHODS.has(req.method)) assertSameOriginJson(req);
      const params = segment?.params ? await segment.params : ({} as P);
      response = await handler({ req, params, requestId, log });
    } catch (err) {
      response = errorResponse(err, requestId, log);
    }

    response.headers.set("x-request-id", requestId);
    log.info(
      {
        method: req.method,
        path: new URL(req.url).pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "request completed",
    );
    return response;
  };
}

function assertSameOriginJson(req: Request): void {
  const contentType = req.headers.get("content-type") ?? "";
  const origin = req.headers.get("origin");
  if (!contentType.toLowerCase().startsWith("application/json") || origin !== env.APP_ORIGIN) {
    throw new AppError("csrf_failed", "The request was rejected by the cross-site request policy.");
  }
}

export function errorResponse(err: unknown, requestId: string, log: Logger): Response {
  if (err instanceof AppError) {
    return NextResponse.json(errorEnvelope(err.code, err.message, requestId, err.details), {
      status: err.status,
    });
  }
  log.error({ err }, "unhandled error");
  return NextResponse.json(
    errorEnvelope("internal_error", "Something went wrong. Please try again.", requestId),
    { status: 500 },
  );
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export async function readJson<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new AppError("invalid_json", "The request body is not valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw validationError(zodFieldErrors(result.error));
  return result.data;
}

export function readQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.output<S> {
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  const result = schema.safeParse(query);
  if (!result.success) throw validationError(zodFieldErrors(result.error));
  return result.data;
}
