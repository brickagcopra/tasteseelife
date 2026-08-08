import { createHash } from 'node:crypto';

import { AccessTokenPayloadSchema, verifyAccessToken } from '@taste-and-see/auth-sdk';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { TokenService } from './token.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3010,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    JWT_ISSUER: 'test-issuer',
    JWT_AUDIENCE: 'test-audience',
    REFRESH_COOKIE_SECURE: true,
    // MFA fields are unused by TokenService but the Env type requires
    // them (added in TS-023).
    MFA_TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
    MFA_TOTP_ENC_KEY_VERSION: 1,
    MFA_CHALLENGE_SECRET: 'b'.repeat(32),
    MFA_CHALLENGE_TTL_SECONDS: 300,
    MFA_TOTP_PERIOD_SECONDS: 30,
    MFA_TOTP_DIGITS: 6,
    MFA_TOTP_WINDOW: 1,
    MFA_TOTP_ISSUER: 'Test',
    // TS-044-followup-2 additions — TokenService doesn't touch these,
    // but the strict `Env` type requires the full shape.
    REDIS_URL: 'redis://localhost:6379/0',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    EMAIL_VERIFICATION_TTL_SECONDS: 86_400,
    // TS-025-followup-1 additions — same reason.
    LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: 30,
    LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS: 300,
    VERIFICATION_RESEND_COOLDOWN_SECONDS: 60,
    VERIFICATION_TOKEN_PRUNE_ENABLED: true,
    VERIFICATION_TOKEN_PRUNE_INTERVAL_MS: 21_600_000,
    VERIFICATION_TOKEN_PRUNE_RETENTION_DAYS: 30,
    VERIFICATION_TOKEN_PRUNE_BATCH_SIZE: 5_000,
    // TS-026 additions — same reason: TokenService doesn't touch them
    // but the Env shape now requires them.
    STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24),
    STRIPE_IDENTITY_RETURN_URL: 'https://example.test/onboarding/identity/complete',
    KYC_PAYLOAD_ENC_KEY: Buffer.alloc(32, 2).toString('base64'),
    KYC_PAYLOAD_ENC_KEY_VERSION: 1,
    KYC_WEBHOOK_INTERNAL_API_KEY: 'c'.repeat(48),
    // TS-235 additions — TokenService doesn't touch the recipient-
    // contacts shared secret but the strict `Env` type requires it.
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_PRIVACY_EXPORT_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'd'.repeat(48),
    IDENTITY_PRIVACY_EXPORT_API_KEY: 'e'.repeat(48),
    // TS-020-followup-1 additions — TokenService doesn't touch the OTel
    // knobs but the strict `Env` type requires the full shape.
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    ...overrides,
  } as Env;
}

describe('TokenService.signAccessToken', () => {
  it('produces an HS256 token verifiable by auth-sdk', () => {
    const svc = new TokenService(buildEnv());
    const { token, expiresInSeconds } = svc.signAccessToken({
      userId: 'u_1',
      sessionId: 'sess_1',
    });
    expect(expiresInSeconds).toBe(900);

    const ctx = verifyAccessToken(token, {
      secret: 'a'.repeat(32),
      issuer: 'test-issuer',
      audience: 'test-audience',
    });

    expect(ctx.userId).toBe('u_1');
    expect(ctx.sessionId).toBe('sess_1');
    expect(ctx.mfaVerified).toBe(false);
    expect(ctx.tenantScope).toEqual({ type: 'global' });
    expect(ctx.roles).toEqual([]);
  });

  it('honours `mfaVerified: true` in the `mfa` claim', () => {
    const svc = new TokenService(buildEnv());
    const { token } = svc.signAccessToken({
      userId: 'u_1',
      sessionId: 'sess_1',
      mfaVerified: true,
    });
    const ctx = verifyAccessToken(token, {
      secret: 'a'.repeat(32),
      issuer: 'test-issuer',
      audience: 'test-audience',
    });
    expect(ctx.mfaVerified).toBe(true);
  });

  it('uses the configured TTL for `exp`', () => {
    const svc = new TokenService(buildEnv({ JWT_ACCESS_TTL_SECONDS: 60 }));
    const beforeIssue = Math.floor(Date.now() / 1000);
    const { token } = svc.signAccessToken({ userId: 'u_1', sessionId: 'sess_1' });
    const decoded = jwt.decode(token);
    if (decoded === null || typeof decoded !== 'object') throw new Error('decode failed');
    const exp = (decoded as { exp?: number }).exp;
    expect(exp).toBeDefined();
    expect(exp).toBeGreaterThanOrEqual(beforeIssue + 59);
    expect(exp).toBeLessThanOrEqual(beforeIssue + 65);
  });

  it('signs a payload that conforms to AccessTokenPayloadSchema', () => {
    const svc = new TokenService(buildEnv());
    const { token } = svc.signAccessToken({ userId: 'u_1', sessionId: 'sess_1' });
    const decoded = jwt.verify(token, 'a'.repeat(32), {
      algorithms: ['HS256'],
      issuer: 'test-issuer',
      audience: 'test-audience',
    });
    const parsed = AccessTokenPayloadSchema.safeParse(decoded);
    expect(parsed.success).toBe(true);
  });

  it('rejects HS256 verification with a different secret (sanity check on signing)', () => {
    const svc = new TokenService(buildEnv());
    const { token } = svc.signAccessToken({ userId: 'u_1', sessionId: 'sess_1' });
    expect(() => jwt.verify(token, 'wrong-secret', { algorithms: ['HS256'] })).toThrow();
  });
});

describe('TokenService.generateRefreshToken', () => {
  it('returns a base64url-encoded string of ≥ 256 bits of entropy', () => {
    const svc = new TokenService(buildEnv());
    const { raw } = svc.generateRefreshToken();
    // base64url of 32 bytes is 43 characters (no padding).
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces distinct tokens on repeated calls (CSPRNG, not seeded)', () => {
    const svc = new TokenService(buildEnv());
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(svc.generateRefreshToken().raw);
    }
    expect(seen.size).toBe(100);
  });

  it('hash output matches sha256(raw, base64url)', () => {
    const svc = new TokenService(buildEnv());
    const { raw, hash } = svc.generateRefreshToken();
    const expected = createHash('sha256').update(raw, 'utf8').digest('base64url');
    expect(hash).toBe(expected);
  });

  it('hashRefreshToken is deterministic and stable for repeated input', () => {
    const svc = new TokenService(buildEnv());
    const a = svc.hashRefreshToken('the-quick-brown-fox');
    const b = svc.hashRefreshToken('the-quick-brown-fox');
    expect(a).toBe(b);
  });

  it('hashRefreshToken collapses different inputs to different outputs', () => {
    const svc = new TokenService(buildEnv());
    const a = svc.hashRefreshToken('aaa');
    const b = svc.hashRefreshToken('aab');
    expect(a).not.toBe(b);
  });
});

describe('TokenService.refreshTokenExpiresAt', () => {
  it('adds JWT_REFRESH_TTL_SECONDS to the supplied `now`', () => {
    const svc = new TokenService(buildEnv({ JWT_REFRESH_TTL_SECONDS: 1000 }));
    const now = new Date('2026-05-09T12:00:00.000Z');
    const exp = svc.refreshTokenExpiresAt(now);
    expect(exp.getTime() - now.getTime()).toBe(1_000_000);
  });

  it('refreshCookieMaxAgeSeconds returns the same TTL', () => {
    const svc = new TokenService(buildEnv({ JWT_REFRESH_TTL_SECONDS: 1234 }));
    expect(svc.refreshCookieMaxAgeSeconds).toBe(1234);
  });
});

describe('TokenService.signAccessToken — RBAC payload (TS-024)', () => {
  it('bakes role assignments into the `roles` claim', () => {
    const svc = new TokenService(buildEnv());
    const { token } = svc.signAccessToken({
      userId: 'u_1',
      sessionId: 'sess_1',
      roles: [
        {
          name: 'finance',
          scope: { type: 'global' },
          permissions: ['accounting:close_period', 'finance:adjust'],
          expiresAt: '2026-12-31T00:00:00.000Z',
        },
      ],
    });
    const ctx = verifyAccessToken(token, {
      secret: 'a'.repeat(32),
      issuer: 'test-issuer',
      audience: 'test-audience',
    });
    expect(ctx.roles).toEqual([
      {
        name: 'finance',
        scope: { type: 'global' },
        permissions: ['accounting:close_period', 'finance:adjust'],
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
    ]);
  });

  it('honours an explicit tenantScope claim', () => {
    const svc = new TokenService(buildEnv());
    const { token } = svc.signAccessToken({
      userId: 'u_1',
      sessionId: 'sess_1',
      tenantScope: { type: 'tenant', tenantId: 'partner_xyz' },
    });
    const ctx = verifyAccessToken(token, {
      secret: 'a'.repeat(32),
      issuer: 'test-issuer',
      audience: 'test-audience',
    });
    expect(ctx.tenantScope).toEqual({ type: 'tenant', tenantId: 'partner_xyz' });
  });

  it('omits `expiresAt` from a role projection when the assignment carries none', () => {
    const svc = new TokenService(buildEnv());
    const { token } = svc.signAccessToken({
      userId: 'u_1',
      sessionId: 'sess_1',
      roles: [
        {
          name: 'family_payer',
          scope: { type: 'global' },
          permissions: [],
        },
      ],
    });
    const ctx = verifyAccessToken(token, {
      secret: 'a'.repeat(32),
      issuer: 'test-issuer',
      audience: 'test-audience',
    });
    expect(ctx.roles[0]).toEqual({
      name: 'family_payer',
      scope: { type: 'global' },
      permissions: [],
    });
    expect(ctx.roles[0]).not.toHaveProperty('expiresAt');
  });
});
