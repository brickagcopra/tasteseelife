import { createHmac } from 'node:crypto';

import type { RequestContext } from '@taste-and-see/auth-sdk';

import { buildCanonicalInput, encodeBase64Url } from './canonical';
import { TRUST_HEADERS, TRUST_HEADER_VERSION, type TrustHeaders } from './headers';

/**
 * Sign a `RequestContext` into the trust-header envelope that
 * propagates the gateway-verified actor identity to a downstream
 * service.
 *
 * Pure function — no DI, no module imports beyond the canonical input
 * builder. The api-gateway wraps this in a NestJS `@Injectable()` that
 * supplies the signing secret from its env; downstream services never
 * call this function (they consume `verifyTrustHeaders` instead).
 *
 * HMAC-SHA256 over the canonical input keyed on
 * `INTERNAL_TRUST_SIGNING_SECRET`. Symmetric: the downstream verifier
 * recomputes the signature from the same canonical input + the same
 * shared secret + checks the timestamp is within
 * `INTERNAL_TRUST_MAX_AGE_SECONDS`.
 */
export function signTrustHeaders(
  actor: RequestContext,
  options: {
    readonly signingSecret: string;
    readonly now?: Date;
  },
): TrustHeaders {
  const now = options.now ?? new Date();
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const userId = actor.userId;
  const mfa: 'true' | 'false' = actor.mfaVerified ? 'true' : 'false';
  const sessionId = actor.sessionId ?? '';
  const rolesEncoded = encodeBase64Url(JSON.stringify(actor.roles));
  const tenantScopeEncoded = encodeBase64Url(JSON.stringify(actor.tenantScope));

  const canonical = buildCanonicalInput({
    version: TRUST_HEADER_VERSION,
    timestamp,
    userId,
    mfa,
    sessionId,
    rolesEncoded,
    tenantScopeEncoded,
  });
  const signature = createHmac('sha256', options.signingSecret).update(canonical).digest('hex');

  return {
    [TRUST_HEADERS.VERSION]: String(TRUST_HEADER_VERSION),
    [TRUST_HEADERS.TIMESTAMP]: timestamp,
    [TRUST_HEADERS.USER_ID]: userId,
    [TRUST_HEADERS.MFA]: mfa,
    [TRUST_HEADERS.SESSION_ID]: sessionId,
    [TRUST_HEADERS.ROLES]: rolesEncoded,
    [TRUST_HEADERS.TENANT_SCOPE]: tenantScopeEncoded,
    [TRUST_HEADERS.SIGNATURE]: signature,
  };
}
