import { cookies } from 'next/headers';

import { loadEnv } from './env';

/**
 * Session cookie helpers (TS-123).
 *
 * Mirrors `apps/web-provider/lib/session.ts` with two admin-specific
 * additions:
 *
 *   1. `writeMfaChallengeCookie` / `readMfaChallengeCookie` /
 *      `clearMfaChallengeCookie` — the login → MFA-verify hop carries
 *      the challenge token (a single-use JWT minted by service-identity)
 *      in a short-lived HttpOnly cookie so the verify form does not have
 *      to ferry it through the URL or re-prompt for credentials. The
 *      cookie is cleared on successful verify OR when the user lands
 *      on `/login` again.
 *
 *   2. Cookie names diverge from web-family / web-provider so an
 *      operator who is also a family member keeps two sessions in the
 *      same browser without one stomping the other.
 *
 * The portal owns its own HttpOnly cookies — the gateway forwards
 * upstream `Set-Cookie` headers verbatim, the server action parses out
 * the refresh-token value, and re-issues under the portal's own name
 * + path (CLAUDE.md §3.1 — no tokens in localStorage / JS-readable
 * cookies).
 */

const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/**
 * MFA challenge cookie lifetime — keep it tight. Service-identity
 * issues the challenge JWT with a 5-minute default TTL; matching the
 * cookie lifetime to that bound avoids leaving a stale dangling
 * cookie if the user abandons the verify step.
 */
const MFA_CHALLENGE_COOKIE_MAX_AGE_SECONDS = 5 * 60;

export interface SessionTokens {
  readonly accessToken: string;
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

export async function writeMfaChallengeCookie(challengeToken: string): Promise<void> {
  const env = loadEnv();
  const jar = await cookies();
  const isProd = process.env.NODE_ENV === 'production';
  jar.set(env.MFA_CHALLENGE_COOKIE_NAME, challengeToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: MFA_CHALLENGE_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function readMfaChallengeCookie(): Promise<string | null> {
  const env = loadEnv();
  const jar = await cookies();
  const value = jar.get(env.MFA_CHALLENGE_COOKIE_NAME)?.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export async function clearMfaChallengeCookie(): Promise<void> {
  const env = loadEnv();
  const jar = await cookies();
  jar.delete(env.MFA_CHALLENGE_COOKIE_NAME);
}

/**
 * TS-297 impersonation session cookies. The operator's OWN admin
 * session cookies are untouched — the impersonation token lives in its
 * own HttpOnly cookie pair so the admin console keeps working as the
 * operator while the banner (and future diagnostic reads) act through
 * the impersonated token. Swapping a portal origin's cookies wholesale
 * is TS-126-followup-2.
 */
export async function writeImpersonationCookies(args: {
  readonly accessToken: string;
  readonly accessTokenMaxAgeSeconds: number;
  readonly sessionFamilyId: string;
  readonly familyMaxAgeSeconds: number;
}): Promise<void> {
  const env = loadEnv();
  const jar = await cookies();
  const isProd = process.env.NODE_ENV === 'production';
  jar.set(env.IMPERSONATION_COOKIE_NAME, args.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: args.accessTokenMaxAgeSeconds,
  });
  jar.set(env.IMPERSONATION_FAMILY_COOKIE_NAME, args.sessionFamilyId, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: args.familyMaxAgeSeconds,
  });
}

export async function readImpersonationAccessToken(): Promise<string | null> {
  const env = loadEnv();
  const jar = await cookies();
  const value = jar.get(env.IMPERSONATION_COOKIE_NAME)?.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export async function readImpersonationFamilyId(): Promise<string | null> {
  const env = loadEnv();
  const jar = await cookies();
  const value = jar.get(env.IMPERSONATION_FAMILY_COOKIE_NAME)?.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export async function clearImpersonationCookies(): Promise<void> {
  const env = loadEnv();
  const jar = await cookies();
  jar.delete(env.IMPERSONATION_COOKIE_NAME);
  jar.delete(env.IMPERSONATION_FAMILY_COOKIE_NAME);
}

/**
 * Parse the raw `Set-Cookie` header values returned by api-gateway and
 * extract the named cookie's value. Returns `null` if not present.
 *
 * The upstream gateway forwards service-identity's `Set-Cookie` headers
 * verbatim, so the cookie shape we look for is the service-identity
 * REFRESH_COOKIE_NAME (`tas_refresh`). The portal re-issues the same
 * raw token under its own cookie name + attributes so the cookie jar
 * stays scoped to the portal's origin.
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
