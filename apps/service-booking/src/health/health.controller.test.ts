import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  // TS-060 shipped the skeleton; TS-060-followup-1 added the JWT
  // verifier, Redis idempotency cache, and outbox producer clusters.
  // This builder grows in lockstep with `Env` so future task slices
  // (TS-064 household-tier lookup, etc.) only need to extend.
  return {
    NODE_ENV: 'test',
    PORT: 3015,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    OUTBOX_PRODUCER_SERVICE: 'service-booking',
    // TS-308a — anomaly sweep knobs.
    BOOKING_ANOMALY_DETECTION_ENABLED: false,
    BOOKING_ANOMALY_SWEEP_INTERVAL_MS: 900_000,
    BOOKING_ANOMALY_LOOKBACK_HOURS: 24,
    BOOKING_ANOMALY_MAX_SPEED_KPH: 1_000,
    BOOKING_MASS_CANCELLATION_ENABLED: false,
    BOOKING_MASS_CANCELLATION_WINDOW_HOURS: 24,
    BOOKING_MASS_CANCELLATION_PROVIDER_THRESHOLD: 5,
    BOOKING_MASS_CANCELLATION_HOUSEHOLD_THRESHOLD: 6,
    // TS-304 — the outbox CONSUMER cluster (service-booking's first).
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    BOOKING_TIER_GATING_MODE: 'advisory',
    BOOKING_TIER_DISPATCH_HEADER_NAME: 'x-internal-api-key',
    BOOKING_TIER_DISPATCH_API_KEY: 'a'.repeat(40),
    BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'a'.repeat(40),
    BOOKING_ACCEPT_WINDOW_MINUTES: 30,
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    ...overrides,
  };
}

describe('HealthController', () => {
  it('liveness returns a static ok payload', () => {
    const prisma = { ping: vi.fn() } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv({ SERVICE_VERSION: 'v1.2.3' }));

    const response = controller.liveness();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('service-booking');
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
      // user 'postgres'") must not leak through. The cause field
      // carries the raw driver string for server-side logs only —
      // the global RfcProblemFilter does NOT echo it onto the wire.
      expect(body['detail']).toBe('postgres readiness check failed');
      expect(body['title']).toBe('Service Unavailable');
      expect(body['status']).toBe(503);
      expect(body['instance']).toBe('/readyz');
      expect(body['cause']).toBe('FATAL: password authentication failed for user "postgres"');
    }
  });
});
