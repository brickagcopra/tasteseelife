import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import {
  AuthContextSignerService,
  TRUST_HEADERS,
  TRUST_HEADER_VERSION,
  buildCanonicalInput,
} from './auth-context-signer.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'unit-test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'j'.repeat(32),
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    REDIS_URL: 'redis://localhost:6379',
    RATE_LIMIT_DEFAULT_WINDOW_SECONDS: 60,
    RATE_LIMIT_DEFAULT_MAX_REQUESTS: 120,
    RATE_LIMIT_SENSITIVE_WINDOW_SECONDS: 300,
    RATE_LIMIT_SENSITIVE_MAX_REQUESTS: 20,
    DOWNSTREAM_REQUEST_TIMEOUT_MS: 5_000,
    SUBSCRIPTION_SERVICE_BASE_URL: 'http://service-subscription.local',
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-05-16T10:00:00.000Z'); // unix = 1778925600

describe('AuthContextSignerService.sign', () => {
  const signer = new AuthContextSignerService(buildEnv());

  it('mints every required trust header', () => {
    const headers = signer.sign(
      {
        userId: 'usr_abc',
        sessionId: 'sess_xyz',
        mfaVerified: true,
        roles: [
          { name: 'family_payer', scope: { type: 'global' }, permissions: ['subscription:write'] },
        ],
        tenantScope: { type: 'global' },
      },
      FIXED_NOW,
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
    const headers = signer.sign(
      {
        userId: 'usr_abc',
        mfaVerified: false,
        roles: [],
        tenantScope: { type: 'global' },
      },
      FIXED_NOW,
    );
    expect(headers[TRUST_HEADERS.MFA]).toBe('false');
  });

  it('emits an empty sessionId when the access token did not carry one', () => {
    const headers = signer.sign(
      {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' },
      },
      FIXED_NOW,
    );
    expect(headers[TRUST_HEADERS.SESSION_ID]).toBe('');
  });

  it('the signature is reproducible by an independent HMAC over the canonical input', () => {
    const env = buildEnv();
    const headers = new AuthContextSignerService(env).sign(
      {
        userId: 'usr_abc',
        sessionId: 'sess_xyz',
        mfaVerified: true,
        roles: [
          { name: 'family_payer', scope: { type: 'global' }, permissions: ['subscription:write'] },
        ],
        tenantScope: { type: 'household', householdId: 'hh_123' },
      },
      FIXED_NOW,
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
    const expected = createHmac('sha256', env.INTERNAL_TRUST_SIGNING_SECRET)
      .update(canonical)
      .digest('hex');
    expect(headers[TRUST_HEADERS.SIGNATURE]).toBe(expected);
  });

  it('signing the same input twice produces the same signature', () => {
    const ctx = {
      userId: 'usr_abc',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'global' as const },
    };
    const a = signer.sign(ctx, FIXED_NOW);
    const b = signer.sign(ctx, FIXED_NOW);
    expect(a[TRUST_HEADERS.SIGNATURE]).toBe(b[TRUST_HEADERS.SIGNATURE]);
  });

  it('changing the user id changes the signature', () => {
    const a = signer.sign(
      { userId: 'usr_a', mfaVerified: true, roles: [], tenantScope: { type: 'global' } },
      FIXED_NOW,
    );
    const b = signer.sign(
      { userId: 'usr_b', mfaVerified: true, roles: [], tenantScope: { type: 'global' } },
      FIXED_NOW,
    );
    expect(a[TRUST_HEADERS.SIGNATURE]).not.toBe(b[TRUST_HEADERS.SIGNATURE]);
  });

  it('changing the timestamp changes the signature', () => {
    const ctx = {
      userId: 'usr_abc',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'global' as const },
    };
    const a = signer.sign(ctx, new Date('2026-05-16T10:00:00.000Z'));
    const b = signer.sign(ctx, new Date('2026-05-16T10:00:01.000Z'));
    expect(a[TRUST_HEADERS.SIGNATURE]).not.toBe(b[TRUST_HEADERS.SIGNATURE]);
    expect(a[TRUST_HEADERS.TIMESTAMP]).not.toBe(b[TRUST_HEADERS.TIMESTAMP]);
  });

  it('changing the signing secret changes the signature', () => {
    const a = new AuthContextSignerService(
      buildEnv({ INTERNAL_TRUST_SIGNING_SECRET: 'a'.repeat(32) }),
    );
    const b = new AuthContextSignerService(
      buildEnv({ INTERNAL_TRUST_SIGNING_SECRET: 'b'.repeat(32) }),
    );
    const ctx = {
      userId: 'usr_abc',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'global' as const },
    };
    const sa = a.sign(ctx, FIXED_NOW);
    const sb = b.sign(ctx, FIXED_NOW);
    expect(sa[TRUST_HEADERS.SIGNATURE]).not.toBe(sb[TRUST_HEADERS.SIGNATURE]);
  });

  it('encodes roles + tenant scope as decodable base64url JSON', () => {
    const headers = signer.sign(
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
      FIXED_NOW,
    );
    const rolesJson = Buffer.from(
      headers[TRUST_HEADERS.ROLES].replaceAll('-', '+').replaceAll('_', '/'),
      'base64',
    ).toString('utf8');
    const decodedRoles = JSON.parse(rolesJson) as unknown[];
    expect(decodedRoles).toHaveLength(1);
    expect((decodedRoles[0] as { name: string }).name).toBe('family_payer');

    const scopeJson = Buffer.from(
      headers[TRUST_HEADERS.TENANT_SCOPE].replaceAll('-', '+').replaceAll('_', '/'),
      'base64',
    ).toString('utf8');
    const decodedScope = JSON.parse(scopeJson) as { type: string; householdId?: string };
    expect(decodedScope.type).toBe('household');
    expect(decodedScope.householdId).toBe('hh_123');
  });
});

describe('buildCanonicalInput', () => {
  it('joins the fields newline-separated in the documented order', () => {
    const input = buildCanonicalInput({
      version: 1,
      timestamp: '1779285600',
      userId: 'usr_a',
      mfa: 'true',
      sessionId: 'sess',
      rolesEncoded: 'AAA',
      tenantScopeEncoded: 'BBB',
    });
    expect(input).toBe(['v1', '1779285600', 'usr_a', 'true', 'sess', 'AAA', 'BBB'].join('\n'));
  });

  it('a different version prefix produces a different canonical input', () => {
    const v1 = buildCanonicalInput({
      version: 1,
      timestamp: '0',
      userId: 'u',
      mfa: 'false',
      sessionId: '',
      rolesEncoded: '',
      tenantScopeEncoded: '',
    });
    const v2 = buildCanonicalInput({
      version: 2,
      timestamp: '0',
      userId: 'u',
      mfa: 'false',
      sessionId: '',
      rolesEncoded: '',
      tenantScopeEncoded: '',
    });
    expect(v1).not.toBe(v2);
  });
});
