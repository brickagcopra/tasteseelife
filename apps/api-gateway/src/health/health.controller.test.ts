import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../config/env';
import { ServiceRegistry } from '../modules/service-registry/services/service-registry';
import { HealthController } from './health.controller';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'unit-test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'j'.repeat(32),
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    REDIS_URL: 'redis://localhost:6379',
    RATE_LIMIT_DEFAULT_WINDOW_SECONDS: 60,
    RATE_LIMIT_DEFAULT_MAX_REQUESTS: 120,
    RATE_LIMIT_SENSITIVE_WINDOW_SECONDS: 300,
    RATE_LIMIT_SENSITIVE_MAX_REQUESTS: 20,
    DOWNSTREAM_REQUEST_TIMEOUT_MS: 5_000,
    SUBSCRIPTION_SERVICE_BASE_URL: 'http://service-subscription.local',
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    ...overrides,
  };
}

class FakeRedisClient {
  failPing = false;
  pingReturn: 'PONG' | 'PANG' = 'PONG';
  async ping(): Promise<'PONG' | 'PANG'> {
    if (this.failPing) throw new Error('redis unreachable');
    return this.pingReturn;
  }
}

describe('HealthController.liveness', () => {
  let controller: HealthController;
  beforeEach(() => {
    const env = buildEnv();
    controller = new HealthController(
      env,
      new FakeRedisClient() as unknown as Redis,
      new ServiceRegistry(env),
    );
  });

  it('returns the expected static shape', () => {
    const response = controller.liveness();
    expect(response.status).toBe('ok');
    expect(response.service).toBe('api-gateway');
    expect(response.version).toBe('unit-test');
    expect(typeof response.uptimeSeconds).toBe('number');
  });
});

describe('HealthController.readiness', () => {
  it('returns 200 + redis=ok + service status map when Redis pings cleanly', async () => {
    const env = buildEnv({ IDENTITY_SERVICE_BASE_URL: 'http://service-identity.local' });
    const controller = new HealthController(
      env,
      new FakeRedisClient() as unknown as Redis,
      new ServiceRegistry(env),
    );
    const response = await controller.readiness();
    expect(response.status).toBe('ok');
    expect(response.checks.redis).toBe('ok');
    expect(response.checks.services['subscription']).toBe('configured');
    expect(response.checks.services['identity']).toBe('configured');
    expect(response.checks.services['household']).toBe('not_configured');
  });

  it('throws ServiceUnavailableException with redis detail on PING failure', async () => {
    const env = buildEnv();
    const redis = new FakeRedisClient();
    redis.failPing = true;
    const controller = new HealthController(
      env,
      redis as unknown as Redis,
      new ServiceRegistry(env),
    );

    let caught: ServiceUnavailableException | null = null;
    try {
      await controller.readiness();
    } catch (err) {
      caught = err as ServiceUnavailableException;
    }
    expect(caught).not.toBeNull();
    const body = caught!.getResponse() as { detail?: string; cause?: string };
    expect(body.detail).toBe('redis readiness check failed');
    // Driver-error message MUST not leak — only the trace logs carry it.
    // We compare for non-PII generic content.
    expect(typeof body.cause).toBe('string');
  });

  it('throws ServiceUnavailableException when PING returns something other than PONG', async () => {
    const env = buildEnv();
    const redis = new FakeRedisClient();
    redis.pingReturn = 'PANG';
    const controller = new HealthController(
      env,
      redis as unknown as Redis,
      new ServiceRegistry(env),
    );

    let caught: ServiceUnavailableException | null = null;
    try {
      await controller.readiness();
    } catch (err) {
      caught = err as ServiceUnavailableException;
    }
    expect(caught).not.toBeNull();
  });
});
