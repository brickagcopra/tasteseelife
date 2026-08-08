import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';
import { ProviderDiscoverySharedSecretGuard } from './provider-discovery-shared-secret.guard';

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    NODE_ENV: 'test',
    PORT: 3014,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://taste:secret@localhost:5432/taste',
    SERVICE_VERSION: 'dev',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379/0',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    // TS-305d — the outbox CONSUMER cluster (service-provider's first).
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY: Buffer.alloc(32).toString('base64'),
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION: 1,
    CHECKR_API_KEY: 'c'.repeat(40),
    CHECKR_API_BASE_URL: 'https://api.checkr.com/v1',
    CHECKR_DEFAULT_PACKAGE: 'tasker_standard',
    CHECKR_DEFAULT_WORK_LOCATION_STATES: 'NY',
    CHECKR_REQUEST_TIMEOUT_MS: 10_000,
    BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY: 'b'.repeat(40),
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'b'.repeat(40),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
    PROVIDER_DISCOVERY_INTERNAL_API_KEY: 'p'.repeat(40),
    PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME: 'x-provider-discovery-internal-api-key',
    CALENDAR_TOKEN_ENC_KEY_VERSION: 1,
    GOOGLE_CALENDAR_SYNC_WINDOW_DAYS: 14,
    CALENDAR_OAUTH_STATE_TTL_SECONDS: 600,
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

describe('ProviderDiscoverySharedSecretGuard', () => {
  const expected = 'p'.repeat(40);

  it('accepts a request carrying the expected shared secret in the default header', () => {
    const guard = new ProviderDiscoverySharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-provider-discovery-internal-api-key': expected });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects when the header is missing', () => {
    const guard = new ProviderDiscoverySharedSecretGuard(buildEnv());
    const ctx = buildContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is wrong', () => {
    const guard = new ProviderDiscoverySharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-provider-discovery-internal-api-key': 'wrong-value' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is a prefix of the expected secret (length mismatch)', () => {
    const guard = new ProviderDiscoverySharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-provider-discovery-internal-api-key': 'p'.repeat(39) });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('honours a custom header name configured via env', () => {
    const guard = new ProviderDiscoverySharedSecretGuard(
      buildEnv({ PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME: 'x-tns-discovery' }),
    );
    const ctx = buildContext({ 'x-tns-discovery': expected });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
