/**
 * Trust-header wire-format constants.
 *
 * Source of truth for the header names + canonical version that the
 * gateway-side signer (`signTrustHeaders`) emits and every downstream
 * verifier (`verifyTrustHeaders`) consumes. Lives in a shared package
 * so producer and verifier cannot drift — a rename or reorder breaks
 * the canonical input on both sides simultaneously, which is exactly
 * what we want.
 */

/**
 * Trust-header schema version. Increment when the canonical signing
 * input shape changes (field added, removed, reordered, or its
 * encoding changes). Verifiers reject envelopes carrying an
 * unrecognised version.
 */
export const TRUST_HEADER_VERSION = 1;

/**
 * Header names. Lowercased — both Node's `http` module and Express
 * normalise incoming headers to lowercase before dispatch, so the
 * verifier's lookup is unambiguous.
 *
 * `x-ts-` prefix marks them as Taste & See platform-internal headers
 * (vs. standard HTTP semantics). The WAF / ingress strips any client-
 * supplied `x-ts-*` headers from public-facing traffic so an attacker
 * cannot forge them by setting them on the wire.
 */
export const TRUST_HEADERS = Object.freeze({
  VERSION: 'x-ts-trust-version',
  TIMESTAMP: 'x-ts-trust-timestamp',
  USER_ID: 'x-ts-actor-user-id',
  MFA: 'x-ts-actor-mfa',
  SESSION_ID: 'x-ts-actor-session-id',
  ROLES: 'x-ts-actor-roles',
  TENANT_SCOPE: 'x-ts-actor-tenant-scope',
  SIGNATURE: 'x-ts-trust-signature',
} as const);

/**
 * The flat, on-the-wire shape of the trust headers attached to every
 * gateway → downstream service call.
 *
 * Field discipline:
 *
 *   - Every value is a string (HTTP header). Roles + tenantScope are
 *     base64url-encoded JSON so downstream code can decode them back to
 *     the rich shapes without inheriting JSON-parsing edge cases at the
 *     header level (e.g. line breaks in values).
 *
 *   - The signature MUST cover every other field — modifying any field
 *     in transit invalidates the signature.
 *
 *   - The timestamp bounds replay: downstream verifiers reject
 *     signatures older than `INTERNAL_TRUST_MAX_AGE_SECONDS`.
 */
export interface TrustHeaders {
  readonly [TRUST_HEADERS.VERSION]: string;
  readonly [TRUST_HEADERS.TIMESTAMP]: string;
  readonly [TRUST_HEADERS.USER_ID]: string;
  readonly [TRUST_HEADERS.MFA]: 'true' | 'false';
  readonly [TRUST_HEADERS.SESSION_ID]: string;
  readonly [TRUST_HEADERS.ROLES]: string;
  readonly [TRUST_HEADERS.TENANT_SCOPE]: string;
  readonly [TRUST_HEADERS.SIGNATURE]: string;
}
