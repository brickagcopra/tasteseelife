import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const baseEnv = {
  ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015',
  STRIPE_RECONCILIATION_INTERNAL_API_KEY: 'k'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults for the optional knobs', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.PORT).toBe(3058);
    expect(env.STRIPE_RECONCILIATION_INTERNAL_HEADER_NAME).toBe('x-accounting-internal-api-key');
    expect(env.REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(env.STRIPE_RECONCILIATION_ENABLED).toBe(true);
    expect(env.STRIPE_RECONCILIATION_RUN_HOUR_UTC).toBe(3);
    expect(env.STRIPE_RECONCILIATION_SCHEDULER_TICK_MS).toBe(3_600_000);
  });

  it('coerces the kill-switch string to a boolean', () => {
    expect(
      loadEnv({ ...baseEnv, STRIPE_RECONCILIATION_ENABLED: 'false' }).STRIPE_RECONCILIATION_ENABLED,
    ).toBe(false);
    expect(
      loadEnv({ ...baseEnv, STRIPE_RECONCILIATION_ENABLED: 'true' }).STRIPE_RECONCILIATION_ENABLED,
    ).toBe(true);
  });

  it('requires the base URL', () => {
    expect(() => loadEnv({ STRIPE_RECONCILIATION_INTERNAL_API_KEY: 'k'.repeat(32) })).toThrow(
      EnvValidationError,
    );
  });

  it('requires a >=32 char shared secret', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_RECONCILIATION_INTERNAL_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a run hour outside 0..23', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_RECONCILIATION_RUN_HOUR_UTC: '24' })).toThrow(
      EnvValidationError,
    );
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...baseEnv, NOPE: 'x' });
    expect((env as Record<string, unknown>).NOPE).toBeUndefined();
  });
});
