import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/identity',
};

describe('loadEnv', () => {
  it('applies defaults for optional knobs', () => {
    const env = loadEnv(baseEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3051);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.JANITOR_ENABLED).toBe(true);
    expect(env.JANITOR_INTERVAL_MS).toBe(3_600_000);
    expect(env.JANITOR_BATCH_SIZE).toBe(5_000);
    expect(env.JANITOR_MAX_BATCHES_PER_SWEEP).toBe(1_000);
    expect(env.REFRESH_TOKEN_RETENTION_DAYS).toBe(30);
    expect(env.REFRESH_TOKEN_PRUNE_ENABLED).toBe(true);
    expect(env.MFA_CHALLENGE_RETENTION_DAYS).toBe(30);
    expect(env.MFA_CHALLENGE_PRUNE_ENABLED).toBe(true);
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.OTEL_TRACES_ENABLED).toBe(true);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('parses the OTEL observability knobs (TS-022-followup-3a)', () => {
    const env = loadEnv({
      ...baseEnv,
      OTEL_TRACES_ENABLED: 'false',
      OTEL_METRICS_ENABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/v1/traces',
    });
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
    expect(env.OTEL_METRICS_ENABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318/v1/traces');
  });

  it('rejects a non-URL OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(() => loadEnv({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });

  it('rejects non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('coerces and parses the boolean kill-switches', () => {
    const env = loadEnv({
      ...baseEnv,
      JANITOR_ENABLED: 'false',
      REFRESH_TOKEN_PRUNE_ENABLED: 'false',
      MFA_CHALLENGE_PRUNE_ENABLED: 'true',
    });
    expect(env.JANITOR_ENABLED).toBe(false);
    expect(env.REFRESH_TOKEN_PRUNE_ENABLED).toBe(false);
    expect(env.MFA_CHALLENGE_PRUNE_ENABLED).toBe(true);
  });

  it('rejects a non-enum boolean flag value', () => {
    expect(() => loadEnv({ ...baseEnv, JANITOR_ENABLED: 'yes' })).toThrow(EnvValidationError);
  });

  it('coerces numeric env values', () => {
    const env = loadEnv({
      ...baseEnv,
      PORT: '4051',
      JANITOR_INTERVAL_MS: '120000',
      JANITOR_BATCH_SIZE: '1000',
      JANITOR_MAX_BATCHES_PER_SWEEP: '50',
      REFRESH_TOKEN_RETENTION_DAYS: '7',
      MFA_CHALLENGE_RETENTION_DAYS: '0',
    });
    expect(env.PORT).toBe(4051);
    expect(env.JANITOR_INTERVAL_MS).toBe(120_000);
    expect(env.JANITOR_BATCH_SIZE).toBe(1_000);
    expect(env.JANITOR_MAX_BATCHES_PER_SWEEP).toBe(50);
    expect(env.REFRESH_TOKEN_RETENTION_DAYS).toBe(7);
    expect(env.MFA_CHALLENGE_RETENTION_DAYS).toBe(0);
  });

  it('rejects a sweep interval below the 60s floor', () => {
    expect(() => loadEnv({ ...baseEnv, JANITOR_INTERVAL_MS: '5000' })).toThrow(EnvValidationError);
  });

  it('rejects a batch size above the safety cap', () => {
    expect(() => loadEnv({ ...baseEnv, JANITOR_BATCH_SIZE: '60000' })).toThrow(EnvValidationError);
  });

  it('rejects a non-positive batch size', () => {
    expect(() => loadEnv({ ...baseEnv, JANITOR_BATCH_SIZE: '0' })).toThrow(EnvValidationError);
  });

  it('rejects a negative retention window', () => {
    expect(() => loadEnv({ ...baseEnv, REFRESH_TOKEN_RETENTION_DAYS: '-1' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a fractional retention window', () => {
    expect(() => loadEnv({ ...baseEnv, MFA_CHALLENGE_RETENTION_DAYS: '1.5' })).toThrow(
      EnvValidationError,
    );
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...baseEnv, EXTRA_FLAG: 'true' });
    expect((env as Record<string, unknown>).EXTRA_FLAG).toBeUndefined();
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'whatever' })).toThrow(EnvValidationError);
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => loadEnv({ ...baseEnv, LOG_LEVEL: 'silly' })).toThrow(EnvValidationError);
  });

  it('EnvValidationError surfaces structured issues', () => {
    try {
      loadEnv({ ...baseEnv, JANITOR_BATCH_SIZE: '0' });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThan(0);
      expect((err as EnvValidationError).message).toContain('JANITOR_BATCH_SIZE');
    }
  });
});
