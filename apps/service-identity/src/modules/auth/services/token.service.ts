import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { GLOBAL_SCOPE, type RoleAssignment, type TenantScope } from '@taste-and-see/auth-sdk';
import jwt, { type SignOptions } from 'jsonwebtoken';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Token issuance primitives for service-identity.
 *
 * Two distinct token types live here:
 *
 *   1. **Access tokens** — short-lived (15 min) HS256 JWTs whose payload
 *      shape matches `@taste-and-see/auth-sdk` `AccessTokenPayloadSchema`.
 *      Issued by `service-identity`, verified by every consumer (gateway,
 *      services). The `sid` claim is the refresh-token family id, so a
 *      revoked family is observable to verifiers via session lookup.
 *
 *   2. **Refresh tokens** — opaque 256-bit cryptographically-random
 *      strings, base64url-encoded for URL/cookie safety. NOT JWTs — there
 *      is no need to encode arbitrary claims into a refresh token; its
 *      sole job is to be presented and exchanged. We store SHA-256 of the
 *      raw token in the DB, and compare hashes (constant-time-ish via
 *      Postgres equality on the unique index) on `/refresh`.
 *
 * The two-token model is the standard OAuth 2.0 pattern (RFC 6749 §1.5)
 * tightened with rotation + reuse detection (OWASP ASVS V3.2.4 / CLAUDE.md
 * §3.1). Why opaque refresh tokens instead of refresh-as-JWT?
 *   - JWTs are bearer tokens; once issued they're valid until expiry. A
 *     revoked family must be detected at every refresh, which requires
 *     a server-side state lookup anyway. Encoding state into the token
 *     itself adds no benefit and increases token size.
 *   - SHA-256 hashing is sub-millisecond (vs. 250-400ms bcrypt) — fine
 *     for the on-every-refresh hot path because the input is already
 *     high-entropy (256 bits of CSPRNG output).
 */
@Injectable()
export class TokenService {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  /**
   * Sign an access token. The payload shape mirrors auth-sdk's
   * `AccessTokenPayloadSchema` so the cross-service verification contract
   * stays in one place.
   *
   * `roles` is the denormalised list of `RoleAssignment` entries the user
   * holds at issuance time; verifiers consume it without round-tripping
   * to the identity service. `tenantScope` is the request scope baked
   * into the token (CLAUDE.md §3.2). Both default to platform-safe
   * values (empty roles + `global` scope) so callers that have not yet
   * migrated to TS-024 / TS-141 keep working — the schema's
   * `.passthrough()` plus the consumer-side narrowing make either
   * change additive.
   */
  signAccessToken(args: {
    readonly userId: string;
    readonly sessionId: string;
    readonly mfaVerified?: boolean;
    /**
     * TS-297: operator user id for impersonation sessions — becomes
     * the `actorOnBehalfOf` claim (`sub` is the impersonated user).
     * Omit for every ordinary session.
     */
    readonly actorOnBehalfOf?: string;
    readonly roles?: readonly RoleAssignment[];
    readonly tenantScope?: TenantScope;
  }): { readonly token: string; readonly expiresInSeconds: number } {
    const expiresInSeconds = this.env.JWT_ACCESS_TTL_SECONDS;
    // Project to plain objects so jsonwebtoken doesn't accidentally
    // serialise non-enumerable fields. The auth-sdk schema only
    // requires name/scope/permissions/expiresAt; anything extra is
    // dropped at the boundary.
    const roles = (args.roles ?? []).map((r) => ({
      name: r.name,
      scope: r.scope,
      permissions: [...r.permissions],
      ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
    }));
    const payload = {
      sub: args.userId,
      sid: args.sessionId,
      mfa: args.mfaVerified ?? false,
      ...(args.actorOnBehalfOf !== undefined && {
        actorOnBehalfOf: args.actorOnBehalfOf,
      }),
      roles,
      tenantScope: args.tenantScope ?? GLOBAL_SCOPE,
    };
    const options: SignOptions = {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
      issuer: this.env.JWT_ISSUER,
      audience: this.env.JWT_AUDIENCE,
    };
    const token = jwt.sign(payload, this.env.JWT_ACCESS_SECRET, options);
    return { token, expiresInSeconds };
  }

  /**
   * Generate a fresh opaque refresh token + its at-rest hash.
   *
   * The raw value is 32 bytes (256 bits) of CSPRNG output — the same
   * entropy budget as the access token's HMAC key. base64url encoding is
   * URL-safe and cookie-safe (no `+`, `/`, `=` to dodge percent-encoding).
   *
   * Returns `{ raw, hash }` — the caller hands `raw` to the client (set as
   * the cookie) and persists `hash` in the DB. The raw value never leaves
   * the cookie/client boundary; subsequent `/refresh` requests carry the
   * raw value back, which is hashed on receipt and compared.
   */
  generateRefreshToken(): { readonly raw: string; readonly hash: string } {
    const raw = randomBytes(32).toString('base64url');
    const hash = hashRefreshToken(raw);
    return { raw, hash };
  }

  /**
   * SHA-256 of a presented refresh token, base64url-encoded. The output
   * matches what `generateRefreshToken()` stored, so the unique-index
   * lookup is a deterministic equality check.
   */
  hashRefreshToken(raw: string): string {
    return hashRefreshToken(raw);
  }

  /** Refresh-token absolute expiry from now. */
  refreshTokenExpiresAt(now: Date = new Date()): Date {
    return new Date(now.getTime() + this.env.JWT_REFRESH_TTL_SECONDS * 1000);
  }

  /** Refresh cookie's max-age in seconds (mirrors the absolute expiry). */
  get refreshCookieMaxAgeSeconds(): number {
    return this.env.JWT_REFRESH_TTL_SECONDS;
  }
}

/**
 * Module-private hash helper. Exported via the service method but kept as
 * a free function so unit tests can verify the format without a DI
 * container.
 */
function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url');
}
