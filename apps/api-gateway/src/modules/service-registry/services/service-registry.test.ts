import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { ServiceRegistry } from './service-registry';

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

describe('ServiceRegistry', () => {
  it('returns the configured base URL for the subscription service', () => {
    const registry = new ServiceRegistry(buildEnv());
    expect(registry.baseUrl('subscription')).toBe('http://service-subscription.local');
  });

  it('returns null for an unconfigured service', () => {
    const registry = new ServiceRegistry(buildEnv());
    expect(registry.baseUrl('identity')).toBeNull();
    expect(registry.baseUrl('household')).toBeNull();
    expect(registry.baseUrl('booking')).toBeNull();
    expect(registry.baseUrl('academy')).toBeNull();
    expect(registry.baseUrl('analytics')).toBeNull();
    expect(registry.baseUrl('ads')).toBeNull();
  });

  it('returns the configured base URL for the analytics service', () => {
    const registry = new ServiceRegistry(
      buildEnv({ ANALYTICS_SERVICE_BASE_URL: 'http://service-analytics.local' }),
    );
    expect(registry.baseUrl('analytics')).toBe('http://service-analytics.local');
  });

  it('returns the configured base URL for the academy service', () => {
    const registry = new ServiceRegistry(
      buildEnv({ ACADEMY_SERVICE_BASE_URL: 'http://service-academy.local' }),
    );
    expect(registry.baseUrl('academy')).toBe('http://service-academy.local');
  });

  it('returns the configured base URL for the ads service', () => {
    const registry = new ServiceRegistry(
      buildEnv({ ADS_SERVICE_BASE_URL: 'http://service-ads.local' }),
    );
    expect(registry.baseUrl('ads')).toBe('http://service-ads.local');
  });

  it('returns the configured base URL for the trust-safety service (TS-301a)', () => {
    const registry = new ServiceRegistry(
      buildEnv({ TRUST_SAFETY_SERVICE_BASE_URL: 'http://service-trust-safety.local' }),
    );
    expect(registry.baseUrl('trust-safety')).toBe('http://service-trust-safety.local');
  });

  it('strips a trailing slash from configured URLs', () => {
    const registry = new ServiceRegistry(
      buildEnv({ SUBSCRIPTION_SERVICE_BASE_URL: 'http://service-subscription.local/' }),
    );
    expect(registry.baseUrl('subscription')).toBe('http://service-subscription.local');
  });

  it('list() returns every known service with its status', () => {
    const registry = new ServiceRegistry(
      buildEnv({
        IDENTITY_SERVICE_BASE_URL: 'http://service-identity.local',
        HOUSEHOLD_SERVICE_BASE_URL: 'http://service-household.local',
      }),
    );
    const entries = registry.list();
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(entries.length).toBe(17);
    expect(byName.get('subscription')?.baseUrl).toBe('http://service-subscription.local');
    expect(byName.get('identity')?.baseUrl).toBe('http://service-identity.local');
    expect(byName.get('household')?.baseUrl).toBe('http://service-household.local');
    expect(byName.get('provider')?.baseUrl).toBeNull();
    expect(byName.get('booking')?.baseUrl).toBeNull();
    expect(byName.get('concierge')?.baseUrl).toBeNull();
    expect(byName.get('academy')?.baseUrl).toBeNull();
  });
});
