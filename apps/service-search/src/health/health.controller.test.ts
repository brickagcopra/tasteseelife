import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../config/env';
import type { SearchBackend } from '../modules/providers/services/search-backend';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3020,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'unit-test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/search_test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED: true,
    SEARCH_PROVIDER_INDEX_NAME: 'providers_v1',
    SEARCH_TIER_BOOST_BASIC: 1,
    SEARCH_TIER_BOOST_CERTIFIED: 1.2,
    SEARCH_TIER_BOOST_ELITE: 1.5,
    SEARCH_GEO_DECAY_SCALE_KM: 40.2336,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    SEARCH_INDEX_API_KEY: 'k'.repeat(40),
    OUTBOX_PRODUCER_SERVICE: 'service-search',
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
}

class FakeBackend implements SearchBackend {
  constructor(
    private readonly opts: {
      readonly liveMode: boolean;
      readonly pingFn?: () => Promise<void>;
    },
  ) {}
  isLiveMode(): boolean {
    return this.opts.liveMode;
  }
  async ping(): Promise<void> {
    if (this.opts.pingFn !== undefined) await this.opts.pingFn();
  }
  upsertProvider = (): never => {
    throw new Error('not used');
  };
  deleteProvider = (): never => {
    throw new Error('not used');
  };
  searchProviders = (): never => {
    throw new Error('not used');
  };
  recommendProviders = (): never => {
    throw new Error('not used');
  };
}

describe('HealthController.liveness', () => {
  let controller: HealthController;
  beforeEach(() => {
    controller = new HealthController(new FakeBackend({ liveMode: false }), buildEnv());
  });

  it('returns the expected static shape', () => {
    const response = controller.liveness();
    expect(response.status).toBe('ok');
    expect(response.service).toBe('service-search');
    expect(response.version).toBe('unit-test');
    expect(typeof response.uptimeSeconds).toBe('number');
  });
});

describe('HealthController.readiness', () => {
  it('returns 200 + mode=stub when backend pings cleanly', async () => {
    const controller = new HealthController(new FakeBackend({ liveMode: false }), buildEnv());
    const response = await controller.readiness();
    expect(response.status).toBe('ok');
    expect(response.checks.backend).toBe('ok');
    expect(response.checks.mode).toBe('stub');
  });

  it('returns mode=live when the backend reports live mode', async () => {
    const controller = new HealthController(new FakeBackend({ liveMode: true }), buildEnv());
    const response = await controller.readiness();
    expect(response.checks.mode).toBe('live');
  });

  it('throws 503 when the backend ping fails', async () => {
    const controller = new HealthController(
      new FakeBackend({
        liveMode: false,
        pingFn: () => Promise.reject(new Error('boom')),
      }),
      buildEnv(),
    );
    await expect(controller.readiness()).rejects.toThrow(ServiceUnavailableException);
  });

  it('does not leak the backend error into the body — only the generic detail', async () => {
    const controller = new HealthController(
      new FakeBackend({
        liveMode: false,
        pingFn: () => Promise.reject(new Error('top-secret connection string')),
      }),
      buildEnv(),
    );
    try {
      await controller.readiness();
      expect.fail('expected throw');
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        const body = err.getResponse() as Record<string, unknown>;
        expect(body['detail']).toBe('search backend readiness check failed');
      } else {
        throw err;
      }
    }
  });
});
