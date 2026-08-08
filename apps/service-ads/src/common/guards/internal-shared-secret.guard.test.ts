import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';
import { InternalSharedSecretGuard } from './internal-shared-secret.guard';

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    NODE_ENV: 'test',
    PORT: 3024,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/ads_test',
    SERVICE_VERSION: 'dev',
    ADS_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    ADS_INTERNAL_API_KEY: 'k'.repeat(40),
    JWT_ACCESS_SECRET: 'b'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
  return base;
}

function buildContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('InternalSharedSecretGuard', () => {
  const expected = 'k'.repeat(40);

  it('accepts a request carrying the expected shared secret in the default header', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-internal-api-key': expected });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects when the header is missing', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    const ctx = buildContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is wrong', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-internal-api-key': 'wrong-secret-value' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is a prefix of the expected secret (length mismatch)', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    // The expected secret is 'k' × 40; supply 'k' × 39 — same prefix, shorter length.
    const ctx = buildContext({ 'x-internal-api-key': 'k'.repeat(39) });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('honours a custom header name configured via env', () => {
    const guard = new InternalSharedSecretGuard(
      buildEnv({ ADS_INTERNAL_HEADER_NAME: 'x-tns-ads-internal' }),
    );
    const ctx = buildContext({ 'x-tns-ads-internal': expected });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
