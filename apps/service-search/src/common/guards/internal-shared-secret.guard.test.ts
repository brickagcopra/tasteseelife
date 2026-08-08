import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';
import { InternalSharedSecretGuard } from './internal-shared-secret.guard';

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    NODE_ENV: 'test',
    PORT: 3020,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'dev',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/search_test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED: true,
    SEARCH_PROVIDER_INDEX_NAME: 'providers_v1',
    SEARCH_TIER_BOOST_BASIC: 1,
    SEARCH_TIER_BOOST_CERTIFIED: 1.2,
    SEARCH_TIER_BOOST_ELITE: 1.5,
    SEARCH_GEO_DECAY_SCALE_KM: 40.2336,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    SEARCH_INDEX_API_KEY: 'k'.repeat(40),
    OUTBOX_PRODUCER_SERVICE: 'service-search',
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
      buildEnv({ SEARCH_INDEX_HEADER_NAME: 'x-tns-search-index' }),
    );
    const ctx = buildContext({ 'x-tns-search-index': expected });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
