import { cookies } from 'next/headers';

import { loadEnv } from './env';

/**
 * Session cookie helpers (TS-121).
 *
 * The family portal owns its own HttpOnly cookies — `tas_family_access`
 * (15-min access token, mirrors service-identity's JWT lifetime) and
 * `tas_family_refresh` (30-day rotating refresh token re-cookied from
 * the upstream `Set-Cookie` header that api-gateway propagates).
 *
 * Cookies are scoped to the portal's own origin so the browser only
 * sends them on portal requests; the server actions in turn read them
 * and forward the access token as `Authorization: Bearer ...` to the
 * gateway. The browser NEVER sees the raw token (CLAUDE.md §3.1 — no
 * tokens in localStorage / JS-readable cookies).
 *
 * Refresh-rotation cookie pass-through: when an upstream auth response
 * carries a `Set-Cookie` for a refresh token, the server action calls
 * `extractRefreshFromUpstreamSetCookie` to pull the raw value out of
 * the upstream header. The value is then re-issued as the portal's
 * own `tas_family_refresh` cookie via `writeSession`. The cookie's
 * attributes (HttpOnly, Secure, SameSite=Lax, Max-Age) match
 * service-identity's policy.
 */

/** Access-token cookie max age — must not exceed service-identity's JWT TTL (15 min). */
const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
/** Refresh-token cookie max age — mirrors service-identity's 30-day rotating window. */
const REFRESH_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The household this session is currently acting in (TS-505d2-followup-5a1).
 *
 * **Why a cookie at all.** The gateway resolves a household tenant scope from
 * the caller's active memberships, and auto-resolves it when there is exactly
 * one — the overwhelming majority. A member of two households (the adult
 * child paying for two parents) is deliberately left `global` until the
 * client names one with `X-Household-Id`, because picking one silently would
 * act on the wrong parent's household. This cookie is that choice.
 *
 * **Why a hard-coded name rather than an env var**, unlike the two session
 * cookies above: those must match values another system chose, this one never
 * leaves the portal.
 *
 * **HttpOnly even though it is not a secret.** It is not a credential — the
 * gateway validates it against the caller's own memberships on every request,
 * so a tampered value is a 403 and never a leak. It is HttpOnly because every
 * gateway call in this portal is made server-side (see `lib/api.ts`), so
 * nothing in the browser needs to read it, and a cookie no script can touch
 * is one fewer thing an XSS can flip.
 *
 * **Session-lifetime, deliberately.** It names a household, so it must not
 * outlive the session that chose it — `clearSession` drops it, and the max
 * age matches the refresh window rather than being a permanent preference.
 */
const HOUSEHOLD_COOKIE_NAME = 'tas_family_household';

export interface SessionTokens {
  readonly accessToken: string;
  /** Optional — refresh token is only minted by login + refresh, not by signup. */
  readonly refreshToken?: string;
}

export async function readAccessToken(): Promise<string | null> {
  const env = loadEnv();
  const jar = await cookies();
  const value = jar.get(env.SESSION_COOKIE_NAME)?.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export async function readRefreshToken(): Promise<string | null> {
  const env = loadEnv();
  const jar = await cookies();
  const value = jar.get(env.REFRESH_COOKIE_NAME)?.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export async function writeSession(tokens: SessionTokens): Promise<void> {
  const env = loadEnv();
  const jar = await cookies();
  const isProd = process.env.NODE_ENV === 'production';

  jar.set(env.SESSION_COOKIE_NAME, tokens.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
  });

  if (tokens.refreshToken !== undefined && tokens.refreshToken.length > 0) {
    jar.set(env.REFRESH_COOKIE_NAME, tokens.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
    });
  }
}

/**
 * The household id this session chose, or `null` when it has not chosen one
 * (the single-membership case, which the gateway resolves on its own, and the
 * no-membership case).
 */
export async function readSelectedHouseholdId(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(HOUSEHOLD_COOKIE_NAME)?.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export async function writeSelectedHouseholdId(householdId: string): Promise<void> {
  const jar = await cookies();
  jar.set(HOUSEHOLD_COOKIE_NAME, householdId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // Tied to the refresh window: the choice should survive a page
    // navigation and a browser restart within the session's life, and
    // should not outlive the session itself.
    maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
  });
}

/**
 * Forget the chosen household.
 *
 * Called on logout with the rest of the session, and by the picker when the
 * gateway reports the choice is no longer valid — a member removed from a
 * household would otherwise keep sending a header that 403s, with no obvious
 * way back.
 */
export async function clearSelectedHouseholdId(): Promise<void> {
  const jar = await cookies();
  jar.delete(HOUSEHOLD_COOKIE_NAME);
}

export async function clearSession(): Promise<void> {
  const env = loadEnv();
  const jar = await cookies();
  jar.delete(env.SESSION_COOKIE_NAME);
  jar.delete(env.REFRESH_COOKIE_NAME);
  // The household choice names a household — it must not survive a logout
  // into whoever logs in next on this browser.
  jar.delete(HOUSEHOLD_COOKIE_NAME);
}

/**
 * Parse the raw `Set-Cookie` header values returned by api-gateway and
 * extract the named cookie's value. Returns `null` if not present.
 *
 * The upstream gateway forwards service-identity's `Set-Cookie` headers
 * verbatim, so the cookie shape we look for is the service-identity
 * REFRESH_COOKIE_NAME (`tas_refresh`). The portal re-issues the same
 * raw token under its own cookie name + attributes so the cookie jar
 * stays scoped to the portal's origin (cross-domain cookies are a
 * non-starter on the production multi-domain topology).
 */
export function extractCookieFromUpstreamSetCookie(
  setCookies: readonly string[],
  cookieName: string,
): string | null {
  for (const raw of setCookies) {
    const firstSegment = raw.split(';')[0]?.trim();
    if (firstSegment === undefined) continue;
    const eq = firstSegment.indexOf('=');
    if (eq <= 0) continue;
    const name = firstSegment.slice(0, eq).trim();
    if (name !== cookieName) continue;
    const value = firstSegment.slice(eq + 1).trim();
    if (value.length === 0) return null;
    return value;
  }
  return null;
}
