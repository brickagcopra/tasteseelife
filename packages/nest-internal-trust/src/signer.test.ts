import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildCanonicalInput, decodeBase64Url } from './canonical';
import { TRUST_HEADERS, TRUST_HEADER_VERSION } from './headers';
import { signTrustHeaders } from './signer';

const SECRET = 't'.repeat(32);
const FIXED_NOW = new Date('2026-05-16T10:00:00.000Z'); // unix = 1778925600

describe('signTrustHeaders', () => {
  it('mints every required trust header', () => {
    const headers = signTrustHeaders(
      {
        userId: 'usr_abc',
        sessionId: 'sess_xyz',
        mfaVerified: true,
        roles: [
          { name: 'family_payer', scope: { type: 'global' }, permissions: ['subscription:write'] },
        ],
        tenantScope: { type: 'global' },
      },
      { signingSecret: SECRET, now: FIXED_NOW },
    );

    expect(headers[TRUST_HEADERS.VERSION]).toBe(String(TRUST_HEADER_VERSION));
    expect(headers[TRUST_HEADERS.TIMESTAMP]).toBe('1778925600');
    expect(headers[TRUST_HEADERS.USER_ID]).toBe('usr_abc');
    expect(headers[TRUST_HEADERS.MFA]).toBe('true');
    expect(headers[TRUST_HEADERS.SESSION_ID]).toBe('sess_xyz');
    expect(headers[TRUST_HEADERS.ROLES]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(headers[TRUST_HEADERS.TENANT_SCOPE]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(headers[TRUST_HEADERS.SIGNATURE]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs MFA=false when the request context is unverified', () => {
    const headers = signTrustHeaders(
      {
        userId: 'usr_abc',
        mfaVerified: false,
        roles: [],
        tenantScope: { type: 'global' },
      },
      { signingSecret: SECRET, now: FIXED_NOW },
    );
    expect(headers[TRUST_HEADERS.MFA]).toBe('false');
  });

  it('emits an empty sessionId when the request context did not carry one', () => {
    const headers = signTrustHeaders(
      {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' },
      },
      { signingSecret: SECRET, now: FIXED_NOW },
    );
    expect(headers[TRUST_HEADERS.SESSION_ID]).toBe('');
  });

  it('uses `new Date()` when `now` is omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const headers = signTrustHeaders(
      { userId: 'usr_abc', mfaVerified: true, roles: [], tenantScope: { type: 'global' } },
      { signingSecret: SECRET },
    );
    const after = Math.floor(Date.now() / 1000);
    const ts = Number.parseInt(headers[TRUST_HEADERS.TIMESTAMP], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('the signature is reproducible by an independent HMAC over the canonical input', () => {
    const headers = signTrustHeaders(
      {
        userId: 'usr_abc',
        sessionId: 'sess_xyz',
        mfaVerified: true,
        roles: [
          { name: 'family_payer', scope: { type: 'global' }, permissions: ['subscription:write'] },
        ],
        tenantScope: { type: 'household', householdId: 'hh_123' },
      },
      { signingSecret: SECRET, now: FIXED_NOW },
    );

    const canonical = buildCanonicalInput({
      version: TRUST_HEADER_VERSION,
      timestamp: headers[TRUST_HEADERS.TIMESTAMP],
      userId: headers[TRUST_HEADERS.USER_ID],
      mfa: headers[TRUST_HEADERS.MFA],
      sessionId: headers[TRUST_HEADERS.SESSION_ID],
      rolesEncoded: headers[TRUST_HEADERS.ROLES],
      tenantScopeEncoded: headers[TRUST_HEADERS.TENANT_SCOPE],
    });
    const expected = createHmac('sha256', SECRET).update(canonical).digest('hex');
    expect(headers[TRUST_HEADERS.SIGNATURE]).toBe(expected);
  });

  it('encodes roles + tenant scope as decodable base64url JSON', () => {
    const headers = signTrustHeaders(
      {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [
          {
            name: 'family_payer',
            scope: { type: 'household', householdId: 'hh_123' },
            permissions: ['subscription:write', 'booking:read'],
          },
        ],
        tenantScope: { type: 'household', householdId: 'hh_123' },
      },
      { signingSecret: SECRET, now: FIXED_NOW },
    );

    const rolesJson = decodeBase64Url(headers[TRUST_HEADERS.ROLES]);
    expect(rolesJson).not.toBeNull();
    const decodedRoles = JSON.parse(rolesJson as string) as unknown[];
    expect(decodedRoles).toHaveLength(1);
    expect((decodedRoles[0] as { name: string }).name).toBe('family_payer');

    const scopeJson = decodeBase64Url(headers[TRUST_HEADERS.TENANT_SCOPE]);
    const decodedScope = JSON.parse(scopeJson as string) as { type: string; householdId?: string };
    expect(decodedScope.type).toBe('household');
    expect(decodedScope.householdId).toBe('hh_123');
  });

  it('signing the same input twice produces the same signature', () => {
    const ctx = {
      userId: 'usr_abc',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'global' as const },
    };
    const a = signTrustHeaders(ctx, { signingSecret: SECRET, now: FIXED_NOW });
    const b = signTrustHeaders(ctx, { signingSecret: SECRET, now: FIXED_NOW });
    expect(a[TRUST_HEADERS.SIGNATURE]).toBe(b[TRUST_HEADERS.SIGNATURE]);
  });

  it('changing the signing secret changes the signature', () => {
    const ctx = {
      userId: 'usr_abc',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'global' as const },
    };
    const a = signTrustHeaders(ctx, { signingSecret: 'a'.repeat(32), now: FIXED_NOW });
    const b = signTrustHeaders(ctx, { signingSecret: 'b'.repeat(32), now: FIXED_NOW });
    expect(a[TRUST_HEADERS.SIGNATURE]).not.toBe(b[TRUST_HEADERS.SIGNATURE]);
  });
});
