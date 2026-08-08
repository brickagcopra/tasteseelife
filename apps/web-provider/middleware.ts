import { NextResponse, type NextRequest } from 'next/server';

/**
 * Provider-portal auth middleware (TS-122).
 *
 * Mirrors `apps/web-family/middleware.ts`. Two-layer auth gate (paired
 * with `app/(protected)/layout.tsx`):
 *
 *   1. Middleware — runs at the edge before the route renders. Checks
 *      for the presence of the access-token cookie on every protected
 *      path and redirects to `/login` if missing. Cheap; defends
 *      static / pre-rendered surfaces too.
 *
 *   2. `(protected)/layout.tsx` — server-component gate that re-reads
 *      the cookie inside the request handler. Catches the rare case
 *      where middleware allows through but the cookie is empty / has
 *      no value (partial write, cookie eviction race, etc).
 *
 * Public surfaces (`/login`, `/signup`) skip the gate entirely. The
 * matcher below excludes Next.js's internals (`_next/*`,
 * `favicon.ico`, etc.) so static-asset requests don't pay the cost.
 *
 * The cookie name is the literal `tas_provider_access` — the
 * `loadEnv()` schema in `lib/env.ts` defaults to this name and
 * production deployments can override it via env. We don't import
 * `lib/env.ts` here because middleware runs in the Edge runtime where
 * pulling more dependencies into the middleware bundle adds cold-start
 * cost for no win — the literal is the canonical default.
 */

const ACCESS_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'tas_provider_access';

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
  if (pathname === '/signup' || pathname.startsWith('/signup/')) return true;
  return false;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
