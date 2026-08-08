import { createHmac, timingSafeEqual } from 'node:crypto';

import type { RequestContext, RoleAssignment, TenantScope } from '@taste-and-see/auth-sdk';
import { z } from 'zod';

import { buildCanonicalInput, decodeBase64Url } from './canonical';
import { TRUST_HEADERS, TRUST_HEADER_VERSION, type TrustHeaders } from './headers';

/**
 * Discriminated-union result returned by `verifyTrustHeaders`.
 *
 * Every failure mode is a distinct variant so the caller (NestJS
 * guard, integration test, ad-hoc diagnostic tool) can branch and
 * surface a meaningful audit log without inspecting the message
 * string. The guard collapses every `kind !== 'ok'` to a generic 401
 * for the wire — keeping the rich variant on the server side for
 * trace / metric labels.
 *
 * Note: only the `'ok'` variant carries a payload. Every failure
 * variant intentionally omits the recovered actor identity — a
 * tampered envelope MUST NOT influence downstream behaviour even by
 * accident.
 */
export type VerifyTrustHeadersResult =
  | { readonly kind: 'ok'; readonly actor: RequestContext }
  | { readonly kind: 'missing_header'; readonly header: string }
  | { readonly kind: 'unknown_version'; readonly version: string }
  | { readonly kind: 'malformed_timestamp' }
  | { readonly kind: 'timestamp_expired'; readonly ageSeconds: number }
  | { readonly kind: 'timestamp_in_future'; readonly skewSeconds: number }
  | { readonly kind: 'malformed_mfa' }
  | { readonly kind: 'malformed_signature' }
  | { readonly kind: 'signature_mismatch' }
  | { readonly kind: 'malformed_roles' }
  | { readonly kind: 'malformed_tenant_scope' };

export interface VerifyTrustHeadersOptions {
  readonly signingSecret: string;
  /**
   * Maximum age in seconds the envelope's timestamp can be before
   * the verifier rejects it as `timestamp_expired`. Bounds replay
   * attacks. Producer-side clock skew is bounded by the
   * `timestamp_in_future` check (allows a small symmetric tolerance).
   */
  readonly maxAgeSeconds: number;
  /**
   * Clock skew tolerance applied to future-timestamped envelopes.
   * Defaults to 5 seconds — verifiers and signers running on
   * loosely-synced clocks shouldn't reject envelopes minted within
   * sub-second of the verifier's clock. Replay protection is unaffected
   * (the symmetric `maxAgeSeconds` window still applies).
   */
  readonly futureToleranceSeconds?: number;
  /** Optional clock override for tests. Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Look up a single trust header from a permissive bag of headers.
 * Express normalises incoming headers to lowercase keys so the
 * direct lookup is enough; we still handle string-array values for
 * compatibility with the Node `http` types (a duplicate header
 * arrives as `string[]`).
 */
function readHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    // Multiple values for a trust header is an attack signal — pick
    // the first and treat the others as missing so the verifier
    // surface stays predictable.
    return raw[0] ?? null;
  }
  return null;
}

const TenantScopeSchema: z.ZodType<TenantScope> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('tenant'), tenantId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('household'), householdId: z.string().min(1) }).strict(),
]);

const RoleAssignmentSchema: z.ZodType<RoleAssignment> = z
  .object({
    name: z.string().min(1),
    scope: TenantScopeSchema,
    permissions: z.array(z.string().min(1)).readonly(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const RolesArraySchema = z.array(RoleAssignmentSchema).readonly();

/**
 * Verify the trust-header envelope minted by the api-gateway.
 *
 * Steps (in order — each rejects early to keep the failure shape
 * predictable):
 *
 *   1. Every header present.
 *   2. Version matches `TRUST_HEADER_VERSION`.
 *   3. Timestamp parses + falls inside the freshness window.
 *   4. MFA flag is exactly `'true'` or `'false'`.
 *   5. Signature is hex of the expected length.
 *   6. Recompute HMAC + constant-time compare.
 *   7. Decode + Zod-validate roles + tenant scope.
 *   8. Return `RequestContext` ready to attach to the request.
 *
 * Pure function — no DI, no Nest dependency. The guard wraps this.
 */
export function verifyTrustHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  options: VerifyTrustHeadersOptions,
): VerifyTrustHeadersResult {
  for (const name of Object.values(TRUST_HEADERS)) {
    const value = readHeader(headers, name);
    if (value === null) {
      return { kind: 'missing_header', header: name };
    }
  }

  const version = readHeader(headers, TRUST_HEADERS.VERSION) ?? '';
  if (version !== String(TRUST_HEADER_VERSION)) {
    return { kind: 'unknown_version', version };
  }

  const timestampRaw = readHeader(headers, TRUST_HEADERS.TIMESTAMP) ?? '';
  if (!/^\d+$/.test(timestampRaw)) {
    return { kind: 'malformed_timestamp' };
  }
  const timestampSeconds = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { kind: 'malformed_timestamp' };
  }

  const now = options.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const ageSeconds = nowSeconds - timestampSeconds;
  const futureTolerance = options.futureToleranceSeconds ?? 5;
  if (ageSeconds < -futureTolerance) {
    return { kind: 'timestamp_in_future', skewSeconds: -ageSeconds };
  }
  if (ageSeconds > options.maxAgeSeconds) {
    return { kind: 'timestamp_expired', ageSeconds };
  }

  const mfaRaw = readHeader(headers, TRUST_HEADERS.MFA) ?? '';
  if (mfaRaw !== 'true' && mfaRaw !== 'false') {
    return { kind: 'malformed_mfa' };
  }
  const mfa: 'true' | 'false' = mfaRaw;

  const signatureRaw = readHeader(headers, TRUST_HEADERS.SIGNATURE) ?? '';
  if (!/^[0-9a-f]{64}$/.test(signatureRaw)) {
    return { kind: 'malformed_signature' };
  }

  const userId = readHeader(headers, TRUST_HEADERS.USER_ID) ?? '';
  const sessionIdRaw = readHeader(headers, TRUST_HEADERS.SESSION_ID) ?? '';
  const rolesEncoded = readHeader(headers, TRUST_HEADERS.ROLES) ?? '';
  const tenantScopeEncoded = readHeader(headers, TRUST_HEADERS.TENANT_SCOPE) ?? '';

  const canonical = buildCanonicalInput({
    version: TRUST_HEADER_VERSION,
    timestamp: timestampRaw,
    userId,
    mfa,
    sessionId: sessionIdRaw,
    rolesEncoded,
    tenantScopeEncoded,
  });
  const expected = createHmac('sha256', options.signingSecret).update(canonical).digest('hex');

  // Constant-time compare. Both inputs are 64-char hex strings, so
  // `Buffer.from(..., 'hex')` always produces 32-byte buffers — the
  // pre-check on signatureRaw length plus the deterministic
  // length of `expected` keeps `timingSafeEqual` from throwing.
  const signatureBuf = Buffer.from(signatureRaw, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (signatureBuf.length !== expectedBuf.length) {
    return { kind: 'signature_mismatch' };
  }
  if (!timingSafeEqual(signatureBuf, expectedBuf)) {
    return { kind: 'signature_mismatch' };
  }

  // Signature has now been verified — every other failure below is
  // a "the envelope is genuine but its payload is malformed" path,
  // which usually indicates producer-side drift rather than an
  // attack. The verifier surfaces them as distinct variants so the
  // producer side can be diagnosed in trace logs.
  const rolesJson = decodeBase64Url(rolesEncoded);
  if (rolesJson === null) {
    return { kind: 'malformed_roles' };
  }
  let rolesParsed: unknown;
  try {
    rolesParsed = JSON.parse(rolesJson);
  } catch {
    return { kind: 'malformed_roles' };
  }
  const rolesValidated = RolesArraySchema.safeParse(rolesParsed);
  if (!rolesValidated.success) {
    return { kind: 'malformed_roles' };
  }

  const scopeJson = decodeBase64Url(tenantScopeEncoded);
  if (scopeJson === null) {
    return { kind: 'malformed_tenant_scope' };
  }
  let scopeParsed: unknown;
  try {
    scopeParsed = JSON.parse(scopeJson);
  } catch {
    return { kind: 'malformed_tenant_scope' };
  }
  const scopeValidated = TenantScopeSchema.safeParse(scopeParsed);
  if (!scopeValidated.success) {
    return { kind: 'malformed_tenant_scope' };
  }

  // `sessionId` on the wire is the empty string when the access
  // token did not carry one (signer's documented behaviour). Recover
  // that to `undefined` on the RequestContext so downstream code
  // sees the same shape it would from a direct `verifyAccessToken`.
  const actor: RequestContext = {
    userId,
    sessionId: sessionIdRaw === '' ? undefined : sessionIdRaw,
    mfaVerified: mfa === 'true',
    roles: rolesValidated.data,
    tenantScope: scopeValidated.data,
  };

  return { kind: 'ok', actor };
}

/**
 * Re-export the verifier's input shape for use by callers that build
 * `TrustHeaders`-shaped objects themselves (rare — typically the
 * verifier consumes raw `req.headers`). Useful in integration tests.
 */
export type { TrustHeaders };
