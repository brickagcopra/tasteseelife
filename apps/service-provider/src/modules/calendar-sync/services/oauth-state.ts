import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed OAuth `state` token (TS-206).
 *
 * The Google OAuth callback (`GET .../calendar/google/callback`) is an
 * **unauthenticated** browser redirect — it carries no access token. The
 * signed `state` is therefore the CSRF + identity boundary: it binds the
 * consent flow to the `providerId` + actor that initiated it, and is
 * HMAC-SHA256-signed under `GOOGLE_CALENDAR_OAUTH_STATE_SECRET` so a
 * forged or tampered state is rejected before any token exchange.
 *
 * Token shape: `base64url(payloadJson) . base64url(hmac)` — two
 * dot-separated base64url segments. The payload carries:
 *   - `providerId` / `actorUserId` — who the flow is for.
 *   - `nonce` — replay-distinguishing randomness.
 *   - `exp` — epoch-seconds expiry (TTL-bounded; an abandoned / replayed
 *     link past `exp` is rejected).
 *
 * Pure functions (no DI, no ambient clock) so they're trivially unit-
 * testable: `verifyOAuthState` takes `nowSeconds` explicitly.
 */

export interface OAuthStatePayload {
  readonly providerId: string;
  readonly actorUserId: string;
  readonly nonce: string;
  /** Epoch seconds. */
  readonly exp: number;
}

export type OAuthStateVerifyResult =
  | { readonly ok: true; readonly payload: OAuthStatePayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' };

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function hmac(secret: string, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

/**
 * Sign a state payload. The caller assembles the payload (including a
 * fresh `nonce` and the resolved `exp`); this function serialises +
 * signs it.
 */
export function signOAuthState(secret: string, payload: OAuthStatePayload): string {
  const payloadSegment = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signatureSegment = base64url(hmac(secret, payloadSegment));
  return `${payloadSegment}.${signatureSegment}`;
}

/**
 * Verify + decode a state token. Returns the typed payload on success,
 * or a discriminated failure reason. Uses a constant-time comparison for
 * the signature so a timing side-channel cannot probe the HMAC.
 */
export function verifyOAuthState(
  secret: string,
  token: string,
  nowSeconds: number,
): OAuthStateVerifyResult {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadSegment = token.slice(0, dot);
  const signatureSegment = token.slice(dot + 1);

  const expected = base64url(hmac(secret, payloadSegment));
  const provided = signatureSegment;
  // Length-guard before timingSafeEqual (which throws on length mismatch).
  if (expected.length !== provided.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isOAuthStatePayload(parsed)) {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.exp <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload: parsed };
}

function isOAuthStatePayload(value: unknown): value is OAuthStatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerId === 'string' &&
    candidate.providerId.length > 0 &&
    typeof candidate.actorUserId === 'string' &&
    candidate.actorUserId.length > 0 &&
    typeof candidate.nonce === 'string' &&
    candidate.nonce.length > 0 &&
    typeof candidate.exp === 'number' &&
    Number.isFinite(candidate.exp)
  );
}
