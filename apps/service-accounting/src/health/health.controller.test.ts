import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'development',
    PORT: 3015,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    SERVICE_VERSION: 'test-1.2.3',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 60 * 60 * 24,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 30,
    INTERNAL_POST_JOURNAL_API_KEY: 'b'.repeat(32),
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: 0,
    ...overrides,
  };
}

function buildController(opts: { pingOk: boolean }): {
  controller: HealthController;
  prisma: { ping: ReturnType<typeof vi.fn> };
} {
  const prisma = {
    ping: vi.fn(async () => {
      if (!opts.pingOk) {
        throw new Error('connection refused');
      }
    }),
  };
  const controller = new HealthController(prisma as unknown as PrismaService, buildEnv());
  return { controller, prisma };
}

describe('HealthController.liveness', () => {
  it('returns a static ok payload without touching Postgres', () => {
    const { controller, prisma } = buildController({ pingOk: true });
    const result = controller.liveness();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('service-accounting');
    expect(result.version).toBe('test-1.2.3');
    expect(typeof result.uptimeSeconds).toBe('number');
    expect(prisma.ping).not.toHaveBeenCalled();
  });
});

describe('HealthController.readiness', () => {
  it('returns ok and reports postgres ok when ping succeeds', async () => {
    const { controller, prisma } = buildController({ pingOk: true });
    const result = await controller.readiness();
    expect(result.status).toBe('ok');
    expect(result.checks.postgres).toBe('ok');
    expect(prisma.ping).toHaveBeenCalledOnce();
  });

  it('throws ServiceUnavailableException with an RFC 7807 body when ping fails', async () => {
    const { controller } = buildController({ pingOk: false });
    try {
      await controller.readiness();
      expect.fail('expected readiness to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body['type']).toBe('about:blank');
      expect(body['title']).toBe('Service Unavailable');
      expect(body['status']).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(body['detail']).toBe('postgres readiness check failed');
      expect(body['instance']).toBe('/readyz');
      expect(body['cause']).toBe('connection refused');
    }
  });
});
