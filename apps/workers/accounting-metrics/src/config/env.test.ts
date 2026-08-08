import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const base = {
  ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015',
  ACCOUNTING_SAAS_METRICS_INTERNAL_API_KEY: 'k'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults for the optional knobs', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3053);
    expect(env.NODE_ENV).toBe('development');
    expect(env.ACCOUNTING_SAAS_METRICS_INTERNAL_HEADER_NAME).toBe('x-accounting-internal-api-key');
    expect(env.REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(env.ACCOUNTING_METRICS_ENABLED).toBe(true);
    expect(env.ACCOUNTING_METRICS_RUN_HOUR_UTC).toBe(2);
    expect(env.ACCOUNTING_METRICS_SCHEDULER_TICK_MS).toBe(3_600_000);
  });

  it('coerces the kill-switch string to a boolean', () => {
    expect(
      loadEnv({ ...base, ACCOUNTING_METRICS_ENABLED: 'false' }).ACCOUNTING_METRICS_ENABLED,
    ).toBe(false);
    expect(
      loadEnv({ ...base, ACCOUNTING_METRICS_ENABLED: 'true' }).ACCOUNTING_METRICS_ENABLED,
    ).toBe(true);
  });

  it('coerces numeric knobs and accepts a custom run hour', () => {
    const env = loadEnv({ ...base, ACCOUNTING_METRICS_RUN_HOUR_UTC: '5', PORT: '4000' });
    expect(env.ACCOUNTING_METRICS_RUN_HOUR_UTC).toBe(5);
    expect(env.PORT).toBe(4000);
  });

  it('rejects a missing base URL', () => {
    expect(() => loadEnv({ ACCOUNTING_SAAS_METRICS_INTERNAL_API_KEY: 'k'.repeat(32) })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a malformed base URL', () => {
    expect(() => loadEnv({ ...base, ACCOUNTING_SERVICE_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a short shared secret', () => {
    expect(() => loadEnv({ ...base, ACCOUNTING_SAAS_METRICS_INTERNAL_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an out-of-range run hour', () => {
    expect(() => loadEnv({ ...base, ACCOUNTING_METRICS_RUN_HOUR_UTC: '24' })).toThrow(
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
