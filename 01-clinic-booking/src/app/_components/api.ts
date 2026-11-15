export interface ApiError {
  code: string;
  message: string;
  details?: { fields?: { path: string; message: string }[] } & Record<string, unknown>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface ApiRequestInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

/** Sends a same-origin JSON request to the API and unwraps the error envelope. */
export async function apiRequest<T = unknown>(
  path: string,
  init: ApiRequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, error: { code: "network_error", message: "Could not reach the server." } };
  }

  const payload = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: payload as T };
  const error = (payload as { error?: ApiError } | null)?.error;
  return {
    ok: false,
    error: error ?? { code: "internal_error", message: `Request failed (${response.status}).` },
  };
}

export function describeError(error: ApiError): string {
  const fields = error.details?.fields ?? [];
  if (fields.length === 0) return error.message;
  const list = fields.map((field) => `${field.path || "request"}: ${field.message}`).join("; ");
  return `${error.message} ${list}`;
}
