import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  // TS-051 extended `Env` with three clusters (JWT verification,
  // Redis idempotency, Checkr) plus the cipher key + internal
  // dispatch shared secret. The HealthController doesn't consult
  // any of them, but the strict `Env` type requires every field.
  return {
    NODE_ENV: 'test',
    PORT: 3014,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    // TS-305d — the outbox CONSUMER cluster (service-provider's first).
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY: Buffer.alloc(32, 0).toString('base64'),
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION: 1,
    CHECKR_API_KEY: 'k'.repeat(32),
    CHECKR_API_BASE_URL: 'https://api.checkr.com/v1',
    CHECKR_DEFAULT_PACKAGE: 'tasker_standard',
    CHECKR_DEFAULT_WORK_LOCATION_STATES: 'NY',
    CHECKR_REQUEST_TIMEOUT_MS: 10_000,
    BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY: 'w'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'b'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
    PROVIDER_DISCOVERY_INTERNAL_API_KEY: 'd'.repeat(48),
    PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME: 'x-provider-discovery-internal-api-key',
    CALENDAR_TOKEN_ENC_KEY_VERSION: 1,
    GOOGLE_CALENDAR_SYNC_WINDOW_DAYS: 14,
    CALENDAR_OAUTH_STATE_TTL_SECONDS: 600,
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
}

describe('HealthController', () => {
  it('liveness returns a static ok payload', () => {
    const prisma = { ping: vi.fn() } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv({ SERVICE_VERSION: 'v1.2.3' }));

    const response = controller.liveness();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('service-provider');
    expect(response.version).toBe('v1.2.3');
    expect(typeof response.uptimeSeconds).toBe('number');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Critically: liveness must NOT consult Postgres (a transient
    // Postgres blip should not restart the pod).
    expect(prisma.ping).not.toHaveBeenCalled();
  });

  it('readiness pings Postgres and returns ok when the ping succeeds', async () => {
    const prisma = {
      ping: vi.fn().mockResolvedValue(undefined),
    } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv());

    const response = await controller.readiness();

    expect(response.status).toBe('ok');
    expect(response.checks.postgres).toBe('ok');
    expect(prisma.ping).toHaveBeenCalledTimes(1);
  });

  it('readiness throws ServiceUnavailable when the Postgres ping fails', async () => {
    const prisma = {
      ping: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv());

    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness 503 body is RFC 7807-shaped with a postgres-only detail (no driver leakage)', async () => {
    const prisma = {
      ping: vi
        .fn()
        .mockRejectedValue(new Error('FATAL: password authentication failed for user "postgres"')),
    } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv());

    try {
      await controller.readiness();
      throw new Error('readiness unexpectedly succeeded');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      // The bound detail is the deliberately-uninformative public
      // string — driver text ("password authentication failed for
      // user 'postgres'") must not leak through.
      expect(body['detail']).toBe('postgres readiness check failed');
      expect(body['title']).toBe('Service Unavailable');
      expect(body['status']).toBe(503);
      expect(body['instance']).toBe('/readyz');
      // `cause` carries the raw driver string for server-side logs
      // only — the global RfcProblemFilter does NOT echo it onto the
      // wire response (only `detail` / `title` / `status` / `instance`
      // / `traceId` make it out). Verified end-to-end in the filter
      // test suite.
      expect(body['cause']).toBe('FATAL: password authentication failed for user "postgres"');
    }
  });
});
