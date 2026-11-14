import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/auth/cookie";
import { REQUEST_ID_HEADER, normalizeRequestId } from "@/http/request-id-header";

export function middleware(request: NextRequest) {
  const requestId = normalizeRequestId(request.headers.get(REQUEST_ID_HEADER));
  const { pathname } = request.nextUrl;

  // Convenience redirect only; every page, action and route checks the session itself.
  if (
    pathname.startsWith("/admin") &&
    pathname !== "/admin/login" &&
    !request.cookies.has(SESSION_COOKIE)
  ) {
    const response = NextResponse.redirect(new URL("/admin/login", request.url));
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  }

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
