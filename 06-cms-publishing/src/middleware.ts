import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, normalizeRequestId } from "@/http/request-id-header";

export function middleware(request: NextRequest) {
  const requestId = normalizeRequestId(request.headers.get(REQUEST_ID_HEADER));
  const forwarded = new Headers(request.headers);
  forwarded.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // The upload route reads the raw request stream itself, so it stays out of middleware.
  matcher: ["/((?!api/media|_next/static|_next/image|favicon.ico).*)"],
};
