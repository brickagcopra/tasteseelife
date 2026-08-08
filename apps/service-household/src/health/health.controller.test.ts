import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3011,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    // TS-031 / TS-032 additions — the health controller doesn't touch
    // these, but the strict `Env` type requires the full shape. We
    // synthesise plausible values rather than coupling the health
    // tests to the intake / access-instructions configuration.
    HOUSEHOLD_INTAKE_ENC_KEY: 'A'.repeat(44), // 32 bytes when base64-decoded approximately
    HOUSEHOLD_INTAKE_ENC_KEY_VERSION: 1,
    HOUSEHOLD_ACCESS_ENC_KEY: 'B'.repeat(44),
    HOUSEHOLD_ACCESS_ENC_KEY_VERSION: 1,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    // TS-044-followup-1 additions — health controller doesn't touch
    // these, but the strict `Env` type requires the full shape.
    REDIS_URL: 'redis://localhost:6379/0',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    // TS-208 additions — health controller doesn't touch these, but
    // the strict `Env` type requires the full shape.
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
    HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: 'p'.repeat(48),
    // TS-235 additions — health controller doesn't touch these, but
    // the strict `Env` type requires the full shape.
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'w'.repeat(48),
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'm'.repeat(48),
    ...overrides,
  };
}

describe('HealthController', () => {
  it('liveness returns a static ok payload', () => {
    const prisma = { ping: vi.fn() } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv({ SERVICE_VERSION: 'v1.2.3' }));

    const response = controller.liveness();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('service-household');
    expect(response.version).toBe('v1.2.3');
    expect(typeof response.uptimeSeconds).toBe('number');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Critically: liveness must NOT consult Postgres (CLAUDE.md
    // §health-endpoint semantics — a transient Postgres blip should
    // not restart the pod).
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
      throw new Error('readiness unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body['title']).toBe('Service Unavailable');
      expect(body['status']).toBe(503);
      expect(body['detail']).toBe('postgres readiness check failed');
      expect(body['instance']).toBe('/readyz');
      // The cause is intentionally surfaced (operators need to know
      // what failed) but the body's `detail` stays generic so the
      // public-facing summary doesn't leak driver internals.
      expect(typeof body['cause']).toBe('string');
    }
  });
});
