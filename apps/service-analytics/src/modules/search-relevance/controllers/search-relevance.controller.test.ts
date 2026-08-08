import { UnauthorizedException } from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type { ComputeSearchRelevanceMetricsResponse } from '@taste-and-see/contracts';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { SearchRelevanceService } from '../services/search-relevance.service';
import {
  SEARCH_RELEVANCE_INTERNAL_API_KEY_HEADER,
  SearchRelevanceController,
} from './search-relevance.controller';

const SECRET = 'b'.repeat(32);

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3023,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://x:y@localhost:5432/analytics_test',
    SERVICE_VERSION: 'test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    INTERNAL_AGGREGATION_API_KEY: SECRET,
  };
}

function sampleResult(metricDate = '2026-06-08'): ComputeSearchRelevanceMetricsResponse {
  return {
    metricDate,
    totalSearches: 120,
    zeroResultSearches: 18,
    distinctSearchers: 40,
    bookingsCreated: 6,
    attributedBookings: 4,
    topQueryCount: 2,
    sortBucketCount: 3,
    zeroResultRatePpm: 150_000,
    approxConversionPpm: 150_000,
    attributedConversionPpm: 33_333,
    runId: 'run_test_1',
    computedAt: '2026-06-09T03:00:00.000Z',
  };
}

function makeStubService(): {
  service: SearchRelevanceService;
  computeForDate: ReturnType<typeof vi.fn>;
} {
  const computeForDate = vi.fn(async () => sampleResult());
  return {
    service: { computeForDate } as unknown as SearchRelevanceService,
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

describe('SearchRelevanceController.computeInternal', () => {
  it('accepts the shared-secret header and returns the marts summary', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SearchRelevanceController(service, buildEnv(), new TenantContextStore());

    const result = await controller.computeInternal(
      {},
      makeRequest({ [SEARCH_RELEVANCE_INTERNAL_API_KEY_HEADER]: SECRET }),
    );

    expect(result.metricDate).toBe('2026-06-08');
    expect(result.totalSearches).toBe(120);
    expect(computeForDate).toHaveBeenCalledTimes(1);
  });

  it('forwards an explicit asOf to the service', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SearchRelevanceController(service, buildEnv(), new TenantContextStore());

    await controller.computeInternal(
      { asOf: '2026-06-08T00:00:00.000Z' },
      makeRequest({ [SEARCH_RELEVANCE_INTERNAL_API_KEY_HEADER]: SECRET }),
    );

    const asOf = computeForDate.mock.calls[0]?.[0] as Date;
    expect(asOf.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('defaults asOf to now when the body omits it', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SearchRelevanceController(service, buildEnv(), new TenantContextStore());
    const before = Date.now();

    await controller.computeInternal(
      {},
      makeRequest({ [SEARCH_RELEVANCE_INTERNAL_API_KEY_HEADER]: SECRET }),
    );

    const asOf = computeForDate.mock.calls[0]?.[0] as Date;
    expect(asOf.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('rejects with 401 when the shared-secret header is missing', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SearchRelevanceController(service, buildEnv(), new TenantContextStore());

    await expect(controller.computeInternal({}, makeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(computeForDate).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the shared-secret header is wrong', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SearchRelevanceController(service, buildEnv(), new TenantContextStore());

    await expect(
      controller.computeInternal(
        {},
        makeRequest({ [SEARCH_RELEVANCE_INTERNAL_API_KEY_HEADER]: 'c'.repeat(32) }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(computeForDate).not.toHaveBeenCalled();
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      SearchRelevanceController.prototype.computeInternal,
    );
    expect(flag).toBe(true);
  });
});

describe('SearchRelevanceController.computeAdmin', () => {
  it('computes when the request carries an authenticated actor', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SearchRelevanceController(service, buildEnv(), new TenantContextStore());

    const result = await controller.computeAdmin({}, makeAuthedRequest('usr_admin'));

    expect(result.metricDate).toBe('2026-06-08');
    expect(computeForDate).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when there is no request context', async () => {
    const { service, computeForDate } = makeStubService();
    const controller = new SearchRelevanceController(service, buildEnv(), new TenantContextStore());

    await expect(controller.computeAdmin({}, makeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(computeForDate).not.toHaveBeenCalled();
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      SearchRelevanceController.prototype.computeAdmin,
    );
    expect(flag).toBe(true);
  });
});
