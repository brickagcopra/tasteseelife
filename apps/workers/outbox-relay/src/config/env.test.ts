import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv, parseSources } from './env';

const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/taste',
  REDIS_URL: 'redis://localhost:6379/0',
  OUTBOX_SOURCES: 'subscription.outbox_events',
};

describe('loadEnv', () => {
  it('applies defaults for optional knobs', () => {
    const env = loadEnv(baseEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3050);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.POLL_INTERVAL_MS).toBe(1000);
    expect(env.BATCH_SIZE).toBe(100);
    expect(env.MAX_ATTEMPTS).toBe(10);
    expect(env.STREAM_MAXLEN).toBe(100_000);
    expect(env.STREAM_NAME_PREFIX).toBe('events');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.OUTBOX_SOURCES).toEqual(['subscription.outbox_events']);
    expect(env.OTEL_TRACES_ENABLED).toBe(true);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('coerces OTEL boolean flags from strings', () => {
    const env = loadEnv({
      ...baseEnv,
      OTEL_TRACES_ENABLED: 'false',
      OTEL_METRICS_ENABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/v1/traces',
    });
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
    expect(env.OTEL_METRICS_ENABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel-collector:4318/v1/traces');
  });

  it('rejects a non-URL OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(() => loadEnv({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects missing DATABASE_URL', () => {
    const { DATABASE_URL: _, ...rest } = baseEnv;
    void _;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('rejects non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects missing REDIS_URL', () => {
    const { REDIS_URL: _, ...rest } = baseEnv;
    void _;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('rejects empty OUTBOX_SOURCES', () => {
    expect(() => loadEnv({ ...baseEnv, OUTBOX_SOURCES: '' })).toThrow(EnvValidationError);
  });

  it('rejects OUTBOX_SOURCES entry without schema.table', () => {
    expect(() => loadEnv({ ...baseEnv, OUTBOX_SOURCES: 'subscription' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects OUTBOX_SOURCES entry with uppercase characters', () => {
    expect(() => loadEnv({ ...baseEnv, OUTBOX_SOURCES: 'Subscription.outbox_events' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects OUTBOX_SOURCES entry with SQL injection characters', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        OUTBOX_SOURCES: 'subscription.outbox_events;DROP TABLE users',
      }),
    ).toThrow(EnvValidationError);
  });

  it('parses comma-separated OUTBOX_SOURCES', () => {
    const env = loadEnv({
      ...baseEnv,
      OUTBOX_SOURCES: 'subscription.outbox_events,booking.outbox_events,identity.outbox_events',
    });
    expect(env.OUTBOX_SOURCES).toEqual([
      'subscription.outbox_events',
      'booking.outbox_events',
      'identity.outbox_events',
    ]);
  });

  it('trims whitespace around OUTBOX_SOURCES entries', () => {
    const env = loadEnv({
      ...baseEnv,
      OUTBOX_SOURCES: 'subscription.outbox_events , booking.outbox_events',
    });
    expect(env.OUTBOX_SOURCES).toEqual(['subscription.outbox_events', 'booking.outbox_events']);
  });

  it('coerces numeric env values', () => {
    const env = loadEnv({
      ...baseEnv,
      POLL_INTERVAL_MS: '5000',
      BATCH_SIZE: '50',
      MAX_ATTEMPTS: '3',
      STREAM_MAXLEN: '10000',
      PORT: '4050',
    });
    expect(env.POLL_INTERVAL_MS).toBe(5000);
    expect(env.BATCH_SIZE).toBe(50);
    expect(env.MAX_ATTEMPTS).toBe(3);
    expect(env.STREAM_MAXLEN).toBe(10_000);
    expect(env.PORT).toBe(4050);
  });

  it('rejects non-positive POLL_INTERVAL_MS', () => {
    expect(() => loadEnv({ ...baseEnv, POLL_INTERVAL_MS: '0' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, POLL_INTERVAL_MS: '-5' })).toThrow(EnvValidationError);
  });

  it('rejects BATCH_SIZE above the safety cap', () => {
    expect(() => loadEnv({ ...baseEnv, BATCH_SIZE: '20000' })).toThrow(EnvValidationError);
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
      loadEnv({ ...baseEnv, OUTBOX_SOURCES: 'BAD' });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThan(0);
      expect((err as EnvValidationError).message).toContain('OUTBOX_SOURCES');
    }
  });
});

describe('parseSources', () => {
  it('splits each schema.table into structured pairs', () => {
    expect(parseSources(['subscription.outbox_events', 'booking.outbox_events'])).toEqual([
      { schema: 'subscription', table: 'outbox_events' },
      { schema: 'booking', table: 'outbox_events' },
    ]);
  });

  it('throws on malformed source', () => {
    // env validation catches this earlier; the helper is defensive.
    expect(() => parseSources(['no_dot'])).toThrow(/invalid source/);
  });
});
