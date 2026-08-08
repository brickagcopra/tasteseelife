import { UnauthorizedException } from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type {
  ComputeSaasMetricsOutput,
  SaasMetricsService,
} from '../services/saas-metrics.service';
import {
  SAAS_METRICS_INTERNAL_API_KEY_HEADER,
  SaasMetricsController,
} from './saas-metrics.controller';

const SECRET = 'b'.repeat(32);

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3015,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://x:y@localhost:5432/tastesee',
    SERVICE_VERSION: 'test',
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
    INTERNAL_POST_JOURNAL_API_KEY: SECRET,
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: 0,
  };
}

function sampleOutput(metricDate = '2026-05-28'): ComputeSaasMetricsOutput {
  return {
    metrics: {
      metricDate,
      currency: 'USD',
      mrrMinor: 22_800,
      arrMinor: 273_600,
      arpuMinor: 11_400,
      activeSubscriptions: 2,
      newMrrMinor: 22_800,
      expansionMrrMinor: 0,
      contractionMrrMinor: 0,
      churnedMrrMinor: 0,
      churnedSubscriptions: 0,
      netNewMrrMinor: 22_800,
      priorMrrMinor: 0,
      netRevenueRetentionPpm: null,
      grossRevenueRetentionPpm: null,
      ltvMinor: null,
      cacMinor: null,
      comparisonDate: null,
      computedAt: '2026-05-28T02:00:00.000Z',
    },
    subscriptionsSnapshotted: 2,
  };
}

function makeStubService(): {
  service: SaasMetricsService;
  computeForDate: ReturnType<typeof vi.fn>;
} {
  const computeForDate = vi.fn(async () => sampleOutput());
  return {
    service: { computeForDate } as unknown as SaasMetricsService,
    computeForDate,
  };
}

function makeRequest(headers: Record<string, string> = {}): RequestWithContext {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as RequestWithContext;
}

function makeAuthedRequest(userId: string): RequestWithContext {
  const req = makeRequest();
  Object.assign(req, {
    requestContext: { userId, roles: [], tenantScope: { type: 'global' } },
  });
  return req;
}

describe('SaasMetricsController.computeInternal', () => {
  it('accepts the shared-secret header and returns the metrics', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SaasMetricsController(service, buildEnv(), new TenantContextStore());

    const result = await controller.computeInternal(
      {},
      makeRequest({ [SAAS_METRICS_INTERNAL_API_KEY_HEADER]: SECRET }),
    );

    expect(result.metrics.metricDate).toBe('2026-05-28');
    expect(result.subscriptionsSnapshotted).toBe(2);
    expect(computeForDate).toHaveBeenCalledTimes(1);
  });

  it('forwards an explicit asOf to the service', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SaasMetricsController(service, buildEnv(), new TenantContextStore());

    await controller.computeInternal(
      { asOf: '2026-05-15T00:00:00.000Z' },
      makeRequest({ [SAAS_METRICS_INTERNAL_API_KEY_HEADER]: SECRET }),
    );

    const asOf = computeForDate.mock.calls[0]?.[0] as Date;
    expect(asOf.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  it('defaults asOf to now when the body omits it', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SaasMetricsController(service, buildEnv(), new TenantContextStore());
    const before = Date.now();

    await controller.computeInternal(
      {},
      makeRequest({ [SAAS_METRICS_INTERNAL_API_KEY_HEADER]: SECRET }),
    );

    const asOf = computeForDate.mock.calls[0]?.[0] as Date;
    expect(asOf.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('rejects with 401 when the shared-secret header is missing', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SaasMetricsController(service, buildEnv(), new TenantContextStore());

    await expect(controller.computeInternal({}, makeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(computeForDate).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the shared-secret header is wrong', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SaasMetricsController(service, buildEnv(), new TenantContextStore());

    await expect(
      controller.computeInternal(
        {},
        makeRequest({ [SAAS_METRICS_INTERNAL_API_KEY_HEADER]: 'c'.repeat(32) }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(computeForDate).not.toHaveBeenCalled();
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      SaasMetricsController.prototype.computeInternal,
    );
    expect(flag).toBe(true);
  });
});

describe('SaasMetricsController.computeAdmin', () => {
  it('computes when the request carries an authenticated actor', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SaasMetricsController(service, buildEnv(), new TenantContextStore());

    const result = await controller.computeAdmin({}, makeAuthedRequest('usr_admin'));

    expect(result.metrics.metricDate).toBe('2026-05-28');
    expect(computeForDate).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when there is no request context', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SaasMetricsController(service, buildEnv(), new TenantContextStore());

    await expect(controller.computeAdmin({}, makeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(computeForDate).not.toHaveBeenCalled();
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      SaasMetricsController.prototype.computeAdmin,
    );
    expect(flag).toBe(true);
  });
});
