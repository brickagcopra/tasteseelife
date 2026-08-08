import { NextResponse, type NextRequest } from 'next/server';

/**
 * Admin-console auth middleware (TS-123).
 *
 * Mirrors `apps/web-provider/middleware.ts`. Three-layer auth gate
 * (paired with `app/(protected)/layout.tsx` + a role-check at the
 * dashboard render boundary):
 *
 *   1. Middleware (this file) — runs at the edge before the route
 *      renders. Checks for the presence of the access-token cookie on
 *      every protected path and redirects to `/login` if missing.
 *
 *   2. `app/(protected)/layout.tsx` — server-component gate that
 *      re-reads the cookie inside the request handler. Catches the
 *      rare case where middleware allows through but the cookie is
 *      empty / has no value (partial write, cookie eviction race).
 *
 *   3. The dashboard render boundary calls `/api/v1/me`, verifies
 *      `mfaVerified` is true AND that the actor holds an admin role
 *      from auth-sdk's `ADMIN_ROLE_NAMES`. Non-admins authenticated
 *      via a portal share (the gateway accepts a valid family-portal
 *      token here too — the trust boundary is the role check, not
 *      the cookie name) are bounced.
 *
 * Public surfaces (`/login`, `/login/verify`) skip the gate entirely.
 * The matcher below excludes Next.js internals so static-asset
 * requests don't pay the cost.
 *
 * Cookie name reads from `SESSION_COOKIE_NAME` env so deployments can
 * override the default `tas_admin_access`. Importing `lib/env.ts`
 * directly would pull more dependencies into the Edge bundle for no
 * win — the literal is the canonical default.
 */

const ACCESS_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'tas_admin_access';

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(ACCESS_COOKIE_NAME);
  const hasSession = typeof cookie?.value === 'string' && cookie.value.length > 0;

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') {
      loginUrl.searchParams.set('next', `${pathname}${search}`);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/login' || pathname.startsWith('/login/')) return true;
  return false;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
