import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const base = {
  ANALYTICS_SERVICE_BASE_URL: 'http://service-analytics:3023',
  ANALYTICS_AGGREGATION_INTERNAL_API_KEY: 'k'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults for the optional knobs', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3054);
    expect(env.NODE_ENV).toBe('development');
    expect(env.ANALYTICS_AGGREGATION_INTERNAL_HEADER_NAME).toBe('x-analytics-internal-api-key');
    expect(env.REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(env.ANALYTICS_AGGREGATOR_ENABLED).toBe(true);
    expect(env.ANALYTICS_AGGREGATOR_RUN_HOUR_UTC).toBe(3);
    expect(env.ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS).toBe(3_600_000);
  });

  it('coerces the kill-switch string to a boolean', () => {
    expect(
      loadEnv({ ...base, ANALYTICS_AGGREGATOR_ENABLED: 'false' }).ANALYTICS_AGGREGATOR_ENABLED,
    ).toBe(false);
    expect(
      loadEnv({ ...base, ANALYTICS_AGGREGATOR_ENABLED: 'true' }).ANALYTICS_AGGREGATOR_ENABLED,
    ).toBe(true);
  });

  it('coerces numeric knobs and accepts a custom run hour', () => {
    const env = loadEnv({ ...base, ANALYTICS_AGGREGATOR_RUN_HOUR_UTC: '5', PORT: '4000' });
    expect(env.ANALYTICS_AGGREGATOR_RUN_HOUR_UTC).toBe(5);
    expect(env.PORT).toBe(4000);
  });

  it('rejects a missing base URL', () => {
    expect(() => loadEnv({ ANALYTICS_AGGREGATION_INTERNAL_API_KEY: 'k'.repeat(32) })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a malformed base URL', () => {
    expect(() => loadEnv({ ...base, ANALYTICS_SERVICE_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a short shared secret', () => {
    expect(() => loadEnv({ ...base, ANALYTICS_AGGREGATION_INTERNAL_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an out-of-range run hour', () => {
    expect(() => loadEnv({ ...base, ANALYTICS_AGGREGATOR_RUN_HOUR_UTC: '24' })).toThrow(
      EnvValidationError,
    );
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...base, UNEXPECTED: 'x' });
    expect((env as Record<string, unknown>).UNEXPECTED).toBeUndefined();
  });
});
