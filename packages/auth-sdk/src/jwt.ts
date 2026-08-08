import jwt, { type Algorithm, type Secret, type VerifyOptions } from 'jsonwebtoken';
import { z } from 'zod';

import type { RequestContext } from './context';

/**
 * Zod schema for an access-token payload as issued by `service-identity`.
 *
 * Standard JWT claims (`sub`, `iat`, `exp`, optional `aud`, `iss`) plus
 * platform-specific claims:
 *   - `sid` — session id (rotating refresh-token family identifier)
 *   - `mfa` — boolean, `true` when the session has cleared MFA verification
 *   - `roles` — denormalised role assignments (with permissions)
 *   - `tenantScope` — current request scope baked into the token
 *
 * `.passthrough()` allows future-additive claims without breaking older
 * verifiers, matching the `add fields, never repurpose` evolution rule
 * in CLAUDE.md §5.3.
 */
const TokenScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('tenant'), tenantId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('household'), householdId: z.string().min(1) }).strict(),
]);

const RoleAssignmentSchema = z
  .object({
    name: z.string().min(1),
    scope: TokenScopeSchema,
    permissions: z.array(z.string().min(1)),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const AccessTokenPayloadSchema = z
  .object({
    sub: z.string().min(1),
    iat: z.number(),
    exp: z.number(),
    aud: z.union([z.string(), z.array(z.string())]).optional(),
    iss: z.string().optional(),
    sid: z.string().optional(),
    mfa: z.boolean().optional(),
    /**
     * RFC 8693-inspired impersonation marker (TS-297). Present ONLY on
     * tokens minted by the admin impersonation surface: `sub` is the
     * IMPERSONATED user (so downstream authorisation naturally acts as
     * them) and this claim carries the OPERATOR's user id so every
     * consumer can preserve the true actor identity. Absent on all
     * ordinary sessions.
     */
    actorOnBehalfOf: z.string().min(1).optional(),
    roles: z.array(RoleAssignmentSchema),
    tenantScope: TokenScopeSchema,
  })
  .passthrough();

export type AccessTokenPayload = z.infer<typeof AccessTokenPayloadSchema>;

export interface VerifyAccessTokenOptions {
  /** HS256 secret string or RS256 PEM-encoded public key (Buffer or string). */
  readonly secret: Secret;
  /**
   * Allowed signing algorithms. Defaults to `['HS256']`. **Always specify
   * RS256 explicitly** when the issuer is `service-identity` in production —
   * never accept the algorithm declared in the token header alone (the
   * "algorithm confusion" CVE class).
   */
  readonly algorithms?: readonly Algorithm[];
  readonly audience?: string | readonly string[];
  readonly issuer?: string | readonly string[];
  /** Clock-skew tolerance in seconds. Defaults to 0 (strict). */
  readonly clockTolerance?: number;
}

/**
 * Verify an access token's signature, expiry, and (optionally)
 * audience/issuer claims, then validate the payload shape against the
 * platform schema. Returns the `RequestContext` directly so callers do not
 * have to map fields themselves.
 *
 * Throws `InvalidTokenError` for any failure mode — caller gets one error
 * type to handle and a `cause` chain pointing at the underlying cause
 * (signature mismatch, schema mismatch, expired, etc.).
 */
export function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions,
): RequestContext {
  const verifyOptions: VerifyOptions = {
    algorithms: [...(options.algorithms ?? ['HS256'])],
    clockTolerance: options.clockTolerance ?? 0,
  };
  if (options.audience !== undefined) {
    // `Array.isArray` doesn't narrow `readonly string[]` cleanly under
    // strict mode — the false branch keeps `readonly string[]` in the
    // union, which is not assignable to jsonwebtoken's mutable
    // `(string | RegExp)[]`. `typeof === 'string'` narrows soundly:
    // string in the true branch, `readonly string[]` in the false branch
    // (which we spread into a fresh mutable copy).
    verifyOptions.audience =
      typeof options.audience === 'string' ? options.audience : [...options.audience];
  }
  if (options.issuer !== undefined) {
    verifyOptions.issuer =
      typeof options.issuer === 'string' ? options.issuer : [...options.issuer];
  }

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, options.secret, verifyOptions);
  } catch (err) {
    throw new InvalidTokenError(err instanceof Error ? err.message : 'jwt verification failed', {
      cause: err,
    });
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new InvalidTokenError('decoded payload is not an object');
  }

  const parsed = AccessTokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new InvalidTokenError('payload failed schema validation', {
      cause: parsed.error,
    });
  }

  const payload = parsed.data;
  return {
    userId: payload.sub,
    sessionId: payload.sid,
    mfaVerified: payload.mfa ?? false,
    ...(payload.actorOnBehalfOf !== undefined && {
      actorOnBehalfOf: payload.actorOnBehalfOf,
    }),
    roles: payload.roles,
    tenantScope: payload.tenantScope,
  };
}

export class InvalidTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`invalid access token: ${message}`, options);
    this.name = 'InvalidTokenError';
  }
}
