import { NextResponse, type NextRequest } from 'next/server';

/**
 * Family-portal auth middleware (TS-121).
 *
 * Two-layer auth gate (paired with `app/(protected)/layout.tsx`):
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
 * The cookie name is the literal `tas_family_access` — the
 * `loadEnv()` schema in `lib/env.ts` defaults to this name and
 * production deployments can override it via env. We don't import
 * `lib/env.ts` here because middleware runs in the Edge runtime
 * where some Node-only APIs (the `zod` peer used in `lib/env.ts`)
 * are fine but pulling more dependencies into the middleware bundle
 * adds cold-start cost for no win — the literal is the canonical
 * default.
 */

const ACCESS_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'tas_family_access';

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(ACCESS_COOKIE_NAME);
  const hasSession = typeof cookie?.value === 'string' && cookie.value.length > 0;

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    // Preserve the originally-requested URL so post-login we can land
    // them where they intended (`next` param honoured by the login
    // page in a TS-121 follow-up).
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
  // TS-510-followup-2. A person arriving from a verification email has no
  // session yet — that is the entire point of the link. Without this, the
  // gate bounces them to `/login?next=/verify-email?token=…`, which both
  // breaks the flow and copies a live single-use credential into a
  // redirect URL that then rides the login page's history and referrer.
  if (pathname === '/verify-email') return true;
  return false;
}

export const config = {
  matcher: [
    // Skip Next.js internals + static assets entirely.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
