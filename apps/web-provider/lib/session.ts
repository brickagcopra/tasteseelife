import { cookies } from 'next/headers';

import { loadEnv } from './env';

/**
 * Session cookie helpers (TS-122).
 *
 * Mirrors `apps/web-family/lib/session.ts` exactly — the provider portal
 * owns its own HttpOnly cookies (`tas_provider_access` for the 15-min
 * access token, `tas_provider_refresh` for the 30-day rotating refresh
 * token re-cookied from the upstream `Set-Cookie` header that
 * api-gateway propagates). The cookie jar stays on the portal's own
 * origin; the server actions read the access token via `next/headers`
 * `cookies()` and forward it as `Authorization: Bearer ...` to the
 * gateway BFF. The browser NEVER sees the raw token (CLAUDE.md §3.1 —
 * no tokens in localStorage / JS-readable cookies).
 *
 * Refresh-rotation cookie pass-through: when an upstream auth response
 * carries a `Set-Cookie` for a refresh token, the server action calls
 * `extractCookieFromUpstreamSetCookie` to pull the raw value out of the
 * upstream header. The value is then re-issued as the portal's own
 * `tas_provider_refresh` cookie via `writeSession`. The cookie's
 * attributes (HttpOnly, Secure, SameSite=Lax, Max-Age) match
 * service-identity's policy.
 */

/** Access-token cookie max age — must not exceed service-identity's JWT TTL (15 min). */
const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
/** Refresh-token cookie max age — mirrors service-identity's 30-day rotating window. */
const REFRESH_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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

export async function clearSession(): Promise<void> {
  const env = loadEnv();
  const jar = await cookies();
  jar.delete(env.SESSION_COOKIE_NAME);
  jar.delete(env.REFRESH_COOKIE_NAME);
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
