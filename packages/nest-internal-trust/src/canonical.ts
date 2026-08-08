/**
 * Canonical input + base64url helpers shared between the trust-header
 * signer (gateway-side) and verifier (downstream services).
 *
 * The canonical input is the exact byte sequence the HMAC is computed
 * over. Producer and verifier MUST build it identically — any drift
 * means valid envelopes fail verification. Keeping the builder pure
 * (no DI, no module imports beyond constants) makes drift impossible
 * unless both sides change simultaneously, which is the point.
 */

/**
 * Build the canonical signing input. Newline-separated for
 * unambiguous parsing; every field is constrained to character sets
 * that cannot contain newlines (UUID-ish ids, "true"/"false", base64url
 * alphabet, decimal integers) so a malicious field value cannot inject
 * a newline to forge a different canonical input.
 *
 * Field order is fixed:
 *
 *   v{version}
 *   {timestamp}
 *   {userId}
 *   {mfa}
 *   {sessionId}
 *   {rolesEncoded}
 *   {tenantScopeEncoded}
 *
 * Any change here MUST bump `TRUST_HEADER_VERSION` so old verifiers
 * reject new envelopes rather than silently failing verification.
 */
export function buildCanonicalInput(parts: {
  readonly version: number;
  readonly timestamp: string;
  readonly userId: string;
  readonly mfa: 'true' | 'false';
  readonly sessionId: string;
  readonly rolesEncoded: string;
  readonly tenantScopeEncoded: string;
}): string {
  return [
    `v${parts.version}`,
    parts.timestamp,
    parts.userId,
    parts.mfa,
    parts.sessionId,
    parts.rolesEncoded,
    parts.tenantScopeEncoded,
  ].join('\n');
}

/**
 * Encode a UTF-8 string as base64url (RFC 4648 §5 — base64 with
 * `-`/`_` substituted for `+`/`/` and trailing `=` padding stripped).
 *
 * Headers carrying JSON payloads use base64url to avoid header-value
 * edge cases (line folds, quoted-printable surprises) without paying
 * the percent-encoding bloat.
 */
export function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Decode a base64url string back to UTF-8.
 *
 * Returns `null` if the input is malformed (non-alphabet characters,
 * length that cannot decode cleanly). Callers translate `null` into a
 * verification failure rather than throwing — the verifier surface
 * uses a discriminated union for every failure mode.
 */
export function decodeBase64Url(value: string): string | null {
  if (value === '') return '';
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const remainder = padded.length % 4;
  const fullyPadded = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
  try {
    return Buffer.from(fullyPadded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}
