import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3017,
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
    NOTIFICATION_RENDER_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_RENDER_API_KEY: 'k'.repeat(40),
    NOTIFICATION_DISPATCH_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_DISPATCH_API_KEY: 'd'.repeat(40),
    NOTIFICATION_EMAIL_FROM_ADDRESS: 'no-reply@example.com',
    NOTIFICATION_EMAIL_FROM_NAME: 'Taste & See',
    // TS-042-followup-3a2 — the dunning-consumer env cluster.
    REDIS_URL: 'redis://localhost:6379',
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    DUNNING_NOTIFICATIONS_ENABLED: true,
    HOUSEHOLD_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'p'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'a'.repeat(32),
    IDENTITY_SERVICE_BASE_URL: 'http://service-identity:3010',
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'b'.repeat(32),
    DUNNING_BILLING_URL: 'https://app.example.com/billing/invoices',
    DUNNING_APP_NAME: 'Taste & See',
    EMAIL_VERIFICATION_URL_BASE: 'http://localhost:3000/verify-email',
    EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED: true,
    ...overrides,
  };
}

describe('HealthController', () => {
  it('liveness returns a static ok payload', () => {
    const prisma = { ping: vi.fn() } as unknown as PrismaService;
    const controller = new HealthController(prisma, buildEnv({ SERVICE_VERSION: 'v1.2.3' }));

    const response = controller.liveness();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('service-notification');
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
      expect(body['detail']).toBe('postgres readiness check failed');
      expect(body['title']).toBe('Service Unavailable');
      expect(body['status']).toBe(503);
      expect(body['instance']).toBe('/readyz');
    }
  });
});
