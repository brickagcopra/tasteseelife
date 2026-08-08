import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3019,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    S3_BUCKET_NAME: 'tastesee-media-test',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: false,
    S3_UPLOAD_URL_TTL_SECONDS: 900,
    S3_DELIVERY_URL_TTL_SECONDS: 300,
    S3_SIGNING_SECRET: 's'.repeat(40),
    MEDIA_SCAN_EVENTS_HEADER_NAME: 'x-internal-api-key',
    MEDIA_SCAN_EVENTS_API_KEY: 'k'.repeat(40),
    ...overrides,
  };
}

describe('HealthController', () => {
  it('liveness returns a static ok payload', () => {
    const prisma = { ping: vi.fn() } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv({ SERVICE_VERSION: 'v1.2.3' }));

    const response = controller.liveness();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('service-media');
    expect(response.version).toBe('v1.2.3');
    expect(typeof response.uptimeSeconds).toBe('number');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Liveness must NOT consult Postgres.
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
      expect(body['detail']).toBe('postgres readiness check failed');
      expect(body['title']).toBe('Service Unavailable');
      expect(body['status']).toBe(503);
      expect(body['instance']).toBe('/readyz');
    }
  });
});
