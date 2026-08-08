import { DEFAULT_REDACT_PATHS } from '@taste-and-see/logger';
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_KEY_PATTERNS, SENSITIVE_KEY_NAMES, isSensitiveKey } from './redaction';

describe('SENSITIVE_KEY_NAMES', () => {
  it('derives every entry from the logger paths, so the two lists cannot drift', () => {
    // The property that matters is not "these names are present" — it is
    // "adding a name to the logger protects Sentry too". Assert the
    // derivation covers the whole source list rather than spot-checking.
    const derived = DEFAULT_REDACT_PATHS.map((p) => {
      const bracket = /\[["']([^"']+)["']\]$/.exec(p);
      if (bracket?.[1] !== undefined) return bracket[1].toLowerCase();
      return (p.split('.').pop() ?? '').toLowerCase();
    }).filter((s) => s.length > 0 && s !== '*');

    for (const name of derived) {
      expect(SENSITIVE_KEY_NAMES.has(name), `logger path last-segment "${name}" not derived`).toBe(
        true,
      );
    }
  });

  it('collapses the pino wildcard form to the bare key name', () => {
    // `*.accessToken` and `accessToken` must both yield `accesstoken`; the
    // Sentry walk is depth-agnostic and has no notion of a wildcard level.
    expect(SENSITIVE_KEY_NAMES.has('accesstoken')).toBe(true);
    expect(SENSITIVE_KEY_NAMES.has('*.accesstoken')).toBe(false);
  });

  it('unwraps the bracket-quoted header form', () => {
    // `res.headers["set-cookie"]` — the only path shape in the logger list
    // that a naive `split('.').pop()` gets wrong.
    expect(SENSITIVE_KEY_NAMES.has('set-cookie')).toBe(true);
  });

  it('adds the Sentry-only keys pino never sees', () => {
    expect(SENSITIVE_KEY_NAMES.has('cookies')).toBe(true);
  });
});

describe('isSensitiveKey', () => {
  it('matches regardless of case, because headers arrive lowercased and body fields do not', () => {
    expect(isSensitiveKey('passwordHash')).toBe(true);
    expect(isSensitiveKey('PASSWORDHASH')).toBe(true);
    expect(isSensitiveKey('Authorization')).toBe(true);
  });

  it('covers the health and personal fields the platform treats as PII', () => {
    for (const key of [
      'ssn',
      'dateOfBirth',
      'email',
      'phoneNumber',
      'dementiaStatus',
      'medications',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('covers internal credential headers by pattern, not by enumeration', () => {
    // These three shapes exist in the gateway today and a fourth is one
    // service away. A list would need editing; the pattern does not.
    expect(isSensitiveKey('x-internal-api-key')).toBe(true);
    expect(isSensitiveKey('x-household-memberships-internal-api-key')).toBe(true);
    expect(isSensitiveKey('x-search-secret')).toBe(true);
    expect(isSensitiveKey('x-some-future-service-internal-api-key')).toBe(true);
  });

  it('censors the trust-header signature but keeps the rest of the trust envelope', () => {
    // The signature is the only forgeable part. Who was acting, in what
    // scope, is what makes the report actionable — dropping it would trade a
    // real debugging capability for no privacy gain.
    expect(isSensitiveKey('x-ts-trust-signature')).toBe(true);
    expect(isSensitiveKey('x-ts-actor-user-id')).toBe(false);
    expect(isSensitiveKey('x-ts-actor-roles')).toBe(false);
    expect(isSensitiveKey('x-ts-actor-tenant-scope')).toBe(false);
  });

  it('leaves ordinary diagnostic keys alone', () => {
    for (const key of ['bookingId', 'status', 'traceId', 'providerId', 'severity', 'url']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('over-redacts substring matches on purpose', () => {
    // Documented, deliberate: `tokenCount` is censored. An over-redacted
    // field costs a debugging round trip; an under-redacted one is a §17.2
    // violation that has already shipped. If this ever needs to change, the
    // fix is a narrower pattern — not a per-key exemption list.
    expect(isSensitiveKey('tokenCount')).toBe(true);
    expect(isSensitiveKey('tokenizer')).toBe(true);
  });

  it('exposes patterns that are all lowercase, since matching lowercases the key', () => {
    for (const pattern of CREDENTIAL_KEY_PATTERNS) {
      expect(pattern).toBe(pattern.toLowerCase());
    }
  });
});
