import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3013,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_aaaaaaaaaaaaaaaaaaaa',
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: 300,
    // TS-026: required by Env shape (defaulted via z.coerce.number().default(...)).
    KYC_DISPATCH_TIMEOUT_MS: 5_000,
    // TS-051: required by Env shape (Checkr webhook verifier + bg-check dispatch).
    CHECKR_WEBHOOK_SECRET: 'whsec_test_checkr_bbbbbbbbbbbbbb',
    CHECKR_WEBHOOK_TOLERANCE_SECONDS: 300,
    BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: 5_000,
    // TS-041a-followup-4: now-required schema fields (boolean post-transform).
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
    expect(response.service).toBe('service-webhook');
    expect(response.version).toBe('v1.2.3');
    expect(typeof response.uptimeSeconds).toBe('number');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Critically: liveness must NOT consult Postgres — a transient
    // Postgres blip should not restart the pod, only pull it from
    // the LB pool.
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
      expect(typeof body['cause']).toBe('string');
    }
  });
});
