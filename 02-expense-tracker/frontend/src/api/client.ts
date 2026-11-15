import { z } from "zod";

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string().nullable().optional(),
  }),
});

export type FieldError = { path: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  get fieldErrors(): FieldError[] {
    const fields = this.details.fields;
    return Array.isArray(fields) ? (fields as FieldError[]) : [];
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function send(method: Method, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Requested-With": "fetch",
  };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: payload,
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json());
    if (parsed.success) {
      const { code, message, details, requestId } = parsed.data.error;
      return new ApiError(response.status, code, message, details ?? {}, requestId ?? null);
    }
  } catch {
    // Fall through to a generic error when the body is not JSON.
  }
  return new ApiError(response.status, "http_error", `Request failed (${response.status}).`);
}

export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await send("GET", path);
  return schema.parse(await response.json());
}

export async function apiSend<T>(
  method: Exclude<Method, "GET">,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const response = await send(method, path, body);
  return schema.parse(await response.json());
}

export async function apiSendNoContent(method: Exclude<Method, "GET">, path: string) {
  await send(method, path);
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = error.fieldErrors.map((f) => `${f.path || "request"}: ${f.message}`);
    return fields.length > 0 ? `${error.message} ${fields.join("; ")}` : error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
