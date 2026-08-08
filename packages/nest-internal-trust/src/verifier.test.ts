import { createHmac } from 'node:crypto';

import type { RequestContext } from '@taste-and-see/auth-sdk';
import { describe, expect, it } from 'vitest';

import { buildCanonicalInput, encodeBase64Url } from './canonical';
import { TRUST_HEADERS, TRUST_HEADER_VERSION } from './headers';
import { signTrustHeaders } from './signer';
import { verifyTrustHeaders } from './verifier';

const SECRET = 't'.repeat(32);
const FIXED_NOW = new Date('2026-05-16T10:00:00.000Z'); // unix = 1778925600

const SAMPLE_ACTOR: RequestContext = {
  userId: 'usr_abc',
  sessionId: 'sess_xyz',
  mfaVerified: true,
  roles: [
    {
      name: 'family_payer',
      scope: { type: 'global' },
      permissions: ['subscription:write'],
    },
  ],
  tenantScope: { type: 'household', householdId: 'hh_123' },
};

function signedHeaders(
  actor: RequestContext = SAMPLE_ACTOR,
  now: Date = FIXED_NOW,
): Record<string, string> {
  return { ...signTrustHeaders(actor, { signingSecret: SECRET, now }) };
}

describe('verifyTrustHeaders — happy path', () => {
  it('round-trips a signed envelope back to the original RequestContext', () => {
    const headers = signedHeaders();
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.actor.userId).toBe(SAMPLE_ACTOR.userId);
    expect(result.actor.sessionId).toBe(SAMPLE_ACTOR.sessionId);
    expect(result.actor.mfaVerified).toBe(true);
    expect(result.actor.tenantScope).toEqual(SAMPLE_ACTOR.tenantScope);
    expect(result.actor.roles).toHaveLength(1);
    expect(result.actor.roles[0]?.name).toBe('family_payer');
    expect(result.actor.roles[0]?.permissions).toEqual(['subscription:write']);
  });

  it('recovers an empty sessionId to `undefined` on the actor', () => {
    const headers = signedHeaders({
      userId: 'usr_a',
      mfaVerified: false,
      roles: [],
      tenantScope: { type: 'global' },
    });
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.actor.sessionId).toBeUndefined();
    expect(result.actor.mfaVerified).toBe(false);
  });

  it('accepts an envelope within the freshness window', () => {
    const headers = signedHeaders(SAMPLE_ACTOR, new Date('2026-05-16T10:00:00.000Z'));
    // 59 seconds later — still within the 60s default window
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: new Date('2026-05-16T10:00:59.000Z'),
    });
    expect(result.kind).toBe('ok');
  });

  it('accepts an envelope a few seconds in the future (clock skew tolerance)', () => {
    const headers = signedHeaders(SAMPLE_ACTOR, new Date('2026-05-16T10:00:05.000Z'));
    // Verifier is 3 seconds behind the signer — within the default
    // 5s future tolerance, so this must succeed.
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: new Date('2026-05-16T10:00:02.000Z'),
    });
    expect(result.kind).toBe('ok');
  });
});

describe('verifyTrustHeaders — missing / malformed headers', () => {
  it('rejects when any required header is missing', () => {
    const headers = signedHeaders();
    delete headers[TRUST_HEADERS.SIGNATURE];
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('missing_header');
    if (result.kind !== 'missing_header') return;
    expect(result.header).toBe(TRUST_HEADERS.SIGNATURE);
  });

  it('rejects an unknown version', () => {
    const headers = signedHeaders();
    headers[TRUST_HEADERS.VERSION] = '2';
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('unknown_version');
    if (result.kind !== 'unknown_version') return;
    expect(result.version).toBe('2');
  });

  it('rejects a malformed timestamp', () => {
    const headers = signedHeaders();
    headers[TRUST_HEADERS.TIMESTAMP] = 'not-a-number';
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('malformed_timestamp');
  });

  it('rejects a malformed mfa flag', () => {
    const headers = signedHeaders();
    headers[TRUST_HEADERS.MFA] = 'yes';
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('malformed_mfa');
  });

  it('rejects a signature that is not 64 hex chars', () => {
    const headers = signedHeaders();
    headers[TRUST_HEADERS.SIGNATURE] = 'abc';
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('malformed_signature');
  });
});

describe('verifyTrustHeaders — timestamp window', () => {
  it('rejects an expired envelope', () => {
    const headers = signedHeaders(SAMPLE_ACTOR, new Date('2026-05-16T10:00:00.000Z'));
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: new Date('2026-05-16T10:02:00.000Z'), // 120s later
    });
    expect(result.kind).toBe('timestamp_expired');
    if (result.kind !== 'timestamp_expired') return;
    expect(result.ageSeconds).toBe(120);
  });

  it('rejects an envelope further in the future than the tolerance', () => {
    const headers = signedHeaders(SAMPLE_ACTOR, new Date('2026-05-16T10:01:00.000Z'));
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      futureToleranceSeconds: 5,
      now: new Date('2026-05-16T10:00:00.000Z'),
    });
    expect(result.kind).toBe('timestamp_in_future');
    if (result.kind !== 'timestamp_in_future') return;
    expect(result.skewSeconds).toBe(60);
  });

  it('rejects every future envelope when futureToleranceSeconds=0', () => {
    const headers = signedHeaders(SAMPLE_ACTOR, new Date('2026-05-16T10:00:01.000Z'));
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      futureToleranceSeconds: 0,
      now: new Date('2026-05-16T10:00:00.000Z'),
    });
    expect(result.kind).toBe('timestamp_in_future');
  });
});

describe('verifyTrustHeaders — signature tamper detection', () => {
  it('rejects a payload field tampered after signing', () => {
    const headers = signedHeaders();
    headers[TRUST_HEADERS.USER_ID] = 'usr_attacker'; // change but keep old signature
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('signature_mismatch');
  });

  it('rejects a roles field tampered after signing', () => {
    const headers = signedHeaders();
    headers[TRUST_HEADERS.ROLES] = 'YWFh'; // base64url of 'aaa' — not the signed value
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('signature_mismatch');
  });

  it('rejects a verifier with the wrong shared secret', () => {
    const headers = signedHeaders();
    const result = verifyTrustHeaders(headers, {
      signingSecret: 'x'.repeat(32),
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('signature_mismatch');
  });

  it('rejects an envelope signed with a different version', () => {
    // Forge a "v2" envelope by re-signing with version=2 — the
    // verifier locks to TRUST_HEADER_VERSION=1, so this hits the
    // `unknown_version` branch before signature verification.
    const headers = signedHeaders();
    headers[TRUST_HEADERS.VERSION] = '2';
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('unknown_version');
  });
});

describe('verifyTrustHeaders — payload validation after signature', () => {
  it('rejects malformed roles payload (genuine signature, broken inner JSON)', () => {
    // Build a custom envelope where the roles field encodes invalid
    // JSON. Sign with the same canonical input the verifier will
    // build, so the signature matches but the role parse fails.
    const timestamp = '1778925600';
    const rolesEncoded = encodeBase64Url('not-json');
    const tenantScopeEncoded = encodeBase64Url(JSON.stringify({ type: 'global' }));
    const canonical = buildCanonicalInput({
      version: TRUST_HEADER_VERSION,
      timestamp,
      userId: 'usr_abc',
      mfa: 'true',
      sessionId: '',
      rolesEncoded,
      tenantScopeEncoded,
    });
    const signature = createHmac('sha256', SECRET).update(canonical).digest('hex');
    const headers: Record<string, string> = {
      [TRUST_HEADERS.VERSION]: String(TRUST_HEADER_VERSION),
      [TRUST_HEADERS.TIMESTAMP]: timestamp,
      [TRUST_HEADERS.USER_ID]: 'usr_abc',
      [TRUST_HEADERS.MFA]: 'true',
      [TRUST_HEADERS.SESSION_ID]: '',
      [TRUST_HEADERS.ROLES]: rolesEncoded,
      [TRUST_HEADERS.TENANT_SCOPE]: tenantScopeEncoded,
      [TRUST_HEADERS.SIGNATURE]: signature,
    };
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('malformed_roles');
  });

  it('rejects a malformed tenant scope payload (genuine signature)', () => {
    const timestamp = '1778925600';
    const rolesEncoded = encodeBase64Url('[]');
    const tenantScopeEncoded = encodeBase64Url(JSON.stringify({ type: 'mystery' }));
    const canonical = buildCanonicalInput({
      version: TRUST_HEADER_VERSION,
      timestamp,
      userId: 'usr_abc',
      mfa: 'true',
      sessionId: '',
      rolesEncoded,
      tenantScopeEncoded,
    });
    const signature = createHmac('sha256', SECRET).update(canonical).digest('hex');
    const headers: Record<string, string> = {
      [TRUST_HEADERS.VERSION]: String(TRUST_HEADER_VERSION),
      [TRUST_HEADERS.TIMESTAMP]: timestamp,
      [TRUST_HEADERS.USER_ID]: 'usr_abc',
      [TRUST_HEADERS.MFA]: 'true',
      [TRUST_HEADERS.SESSION_ID]: '',
      [TRUST_HEADERS.ROLES]: rolesEncoded,
      [TRUST_HEADERS.TENANT_SCOPE]: tenantScopeEncoded,
      [TRUST_HEADERS.SIGNATURE]: signature,
    };
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('malformed_tenant_scope');
  });
});

describe('verifyTrustHeaders — header bag shapes', () => {
  it('reads the first element of a string[] header value (duplicate header sent)', () => {
    const headers = signedHeaders();
    // Express occasionally surfaces duplicate headers as string[].
    // Wrap one value in a 1-element array — the verifier picks the
    // first and proceeds.
    const wrapped: Record<string, string | string[]> = {
      ...headers,
      [TRUST_HEADERS.USER_ID]: [headers[TRUST_HEADERS.USER_ID] as string],
    };
    const result = verifyTrustHeaders(wrapped, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('ok');
  });

  it('treats `undefined`-valued keys as missing', () => {
    const headers: Record<string, string | undefined> = signedHeaders();
    headers[TRUST_HEADERS.USER_ID] = undefined;
    const result = verifyTrustHeaders(headers, {
      signingSecret: SECRET,
      maxAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(result.kind).toBe('missing_header');
  });
});
