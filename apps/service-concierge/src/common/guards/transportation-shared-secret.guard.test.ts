import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';
import { TransportationSharedSecretGuard } from './transportation-shared-secret.guard';

const SECRET = 't'.repeat(40);

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    NODE_ENV: 'test',
    PORT: 3021,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/concierge_test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    PAGERDUTY_EVENTS_URL: 'https://events.pagerduty.com/v2/enqueue',
    PAGERDUTY_SOURCE: 'service-concierge',
    PAGERDUTY_TIMEOUT_MS: 5_000,
    CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY: SECRET,
    CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME: 'x-concierge-transportation-internal-api-key',
    ...overrides,
  } as Env;
  return base;
}

function buildContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('TransportationSharedSecretGuard', () => {
  it('accepts a request carrying the expected shared secret in the default header', () => {
    const guard = new TransportationSharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-concierge-transportation-internal-api-key': SECRET });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('fails closed when the secret is unset (every request rejected)', () => {
    const guard = new TransportationSharedSecretGuard(
      buildEnv({ CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY: undefined }),
    );
    const ctx = buildContext({ 'x-concierge-transportation-internal-api-key': SECRET });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header is missing', () => {
    const guard = new TransportationSharedSecretGuard(buildEnv());
    expect(() => guard.canActivate(buildContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is wrong', () => {
    const guard = new TransportationSharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-concierge-transportation-internal-api-key': 'wrong-value' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is a prefix of the expected secret (length mismatch)', () => {
    const guard = new TransportationSharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-concierge-transportation-internal-api-key': 't'.repeat(39) });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('honours a custom header name configured via env', () => {
    const guard = new TransportationSharedSecretGuard(
      buildEnv({ CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME: 'x-tns-ride' }),
    );
    const ctx = buildContext({ 'x-tns-ride': SECRET });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
