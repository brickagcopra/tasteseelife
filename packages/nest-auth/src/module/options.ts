import {
  validateTrustHeaderOptions,
  type ValidatedTrustHeaderOptions,
} from '@taste-and-see/nest-internal-trust';

/**
 * Module-options shape for `NestAuthModule.forRoot(...)`.
 *
 * The three fields mirror the per-service env contract that the lifted
 * services previously bound directly via `ENV_TOKEN`:
 *
 *   - `jwtAccessSecret` — HS256 verification secret. Same value as
 *     service-identity's `JWT_ACCESS_SECRET`. Phase 1 contract is one
 *     shared symmetric secret across the issuer (service-identity) and
 *     every verifier; Phase 2 (TS-022-followup-2) flips to RS256 with a
 *     fanned-out public key, at which point this option grows a
 *     `publicKey` discriminated union.
 *
 *   - `jwtIssuer` — pinned `iss` claim (e.g.
 *     `taste-and-see/service-identity`). Mismatch fails verification.
 *
 *   - `jwtAudience` — pinned `aud` claim (e.g. `taste-and-see/api`).
 *     Mismatch fails verification.
 *
 * Options are validated once at module bootstrap; misconfigured values
 * throw a `NestAuthConfigError` before any request reaches the guard.
 */
export interface NestAuthModuleOptions {
  readonly jwtAccessSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  /**
   * Enables the gateway trust-header path on `AccessTokenGuard`
   * (TS-140-followup-1a). See that guard's doc-block for the full
   * reasoning; in short, the api-gateway does NOT forward the caller's
   * bearer token to a downstream service — it mints a signed
   * `x-ts-trust-*` envelope instead — so a service that only accepts a
   * bearer is unreachable through the gateway.
   *
   * **Optional, and absent means unchanged.** A service that has not
   * been migrated keeps bearer-only behaviour exactly as before, so the
   * rollout is per-service and independently revertable, as
   * TS-140-followup-1a requires.
   *
   * `signingSecret` MUST equal the gateway's
   * `INTERNAL_TRUST_SIGNING_SECRET`; `maxAgeSeconds` bounds the replay
   * window and should mirror the gateway's `INTERNAL_TRUST_MAX_AGE_SECONDS`.
   */
  readonly internalTrust?: {
    readonly signingSecret: string;
    readonly maxAgeSeconds: number;
    readonly futureToleranceSeconds?: number;
  };
}

export interface ValidatedNestAuthOptions {
  readonly jwtAccessSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly internalTrust: ValidatedTrustHeaderOptions | null;
}

export class NestAuthConfigError extends Error {
  constructor(message: string) {
    super(`@taste-and-see/nest-auth: ${message}`);
    this.name = 'NestAuthConfigError';
  }
}

export function validateNestAuthOptions(options: NestAuthModuleOptions): ValidatedNestAuthOptions {
  if (typeof options.jwtAccessSecret !== 'string' || options.jwtAccessSecret.length < 32) {
    throw new NestAuthConfigError(
      'jwtAccessSecret must be a string of at least 32 characters (HMAC-SHA256 block size)',
    );
  }
  if (typeof options.jwtIssuer !== 'string' || options.jwtIssuer.length === 0) {
    throw new NestAuthConfigError('jwtIssuer must be a non-empty string');
  }
  if (typeof options.jwtAudience !== 'string' || options.jwtAudience.length === 0) {
    throw new NestAuthConfigError('jwtAudience must be a non-empty string');
  }
  // Validated eagerly, by the shared package that owns the shape, so a
  // service that mis-wires the trust secret fails at bootstrap rather
  // than returning 401 to every gateway-borne request in production.
  const internalTrust =
    options.internalTrust === undefined ? null : validateTrustHeaderOptions(options.internalTrust);

  return Object.freeze({
    jwtAccessSecret: options.jwtAccessSecret,
    jwtIssuer: options.jwtIssuer,
    jwtAudience: options.jwtAudience,
    internalTrust,
  });
}
