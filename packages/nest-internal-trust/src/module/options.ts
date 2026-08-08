/**
 * Module-options shape for `TrustHeaderGuardModule.forRoot(...)`.
 *
 * `signingSecret` MUST match the api-gateway's
 * `INTERNAL_TRUST_SIGNING_SECRET`. The two are read from the same
 * shared secret (Vault / cloud secrets manager per CLAUDE.md §3.5);
 * key rotation requires both sides to flip simultaneously, which the
 * env-rotation runbook enforces.
 *
 * `maxAgeSeconds` mirrors the gateway's
 * `INTERNAL_TRUST_MAX_AGE_SECONDS`. Defaults to 60 seconds — long
 * enough for a typical gateway → downstream call with retries, short
 * enough that a captured envelope cannot be replayed beyond the
 * window. Verifiers can tighten further per-service.
 *
 * `futureToleranceSeconds` allows a small clock-skew tolerance on
 * future-timestamped envelopes (5s by default). Set to 0 to make the
 * future-timestamp check strict.
 */
export interface TrustHeaderModuleOptions {
  readonly signingSecret: string;
  readonly maxAgeSeconds: number;
  readonly futureToleranceSeconds?: number;
}

export interface ValidatedTrustHeaderOptions {
  readonly signingSecret: string;
  readonly maxAgeSeconds: number;
  readonly futureToleranceSeconds: number;
}

export class TrustHeaderConfigError extends Error {
  constructor(message: string) {
    super(`@taste-and-see/nest-internal-trust: ${message}`);
    this.name = 'TrustHeaderConfigError';
  }
}

export function validateTrustHeaderOptions(
  options: TrustHeaderModuleOptions,
): ValidatedTrustHeaderOptions {
  if (typeof options.signingSecret !== 'string' || options.signingSecret.length < 32) {
    throw new TrustHeaderConfigError('signingSecret must be a string of at least 32 characters');
  }
  if (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds <= 0) {
    throw new TrustHeaderConfigError('maxAgeSeconds must be a positive integer');
  }
  if (options.maxAgeSeconds > 3600) {
    throw new TrustHeaderConfigError(
      'maxAgeSeconds must be <= 3600 (1h ceiling on replay-attack window)',
    );
  }
  const futureTolerance = options.futureToleranceSeconds ?? 5;
  if (!Number.isInteger(futureTolerance) || futureTolerance < 0) {
    throw new TrustHeaderConfigError('futureToleranceSeconds must be a non-negative integer');
  }
  if (futureTolerance > 60) {
    throw new TrustHeaderConfigError(
      'futureToleranceSeconds must be <= 60 (clock skew should never be a minute)',
    );
  }
  return Object.freeze({
    signingSecret: options.signingSecret,
    maxAgeSeconds: options.maxAgeSeconds,
    futureToleranceSeconds: futureTolerance,
  });
}
