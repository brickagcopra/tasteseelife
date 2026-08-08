import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
};

describe('loadEnv', () => {
  it('applies defaults for an otherwise-empty environment', () => {
    const env = loadEnv(BASE);
    expect(env.PORT).toBe(3052);
    expect(env.MEDIA_PROCESSOR_ENABLED).toBe(true);
    expect(env.MEDIA_PROCESSOR_INTERVAL_MS).toBe(5_000);
    expect(env.MEDIA_PROCESSOR_BATCH_SIZE).toBe(20);
    expect(env.SCAN_EVENT_INGEST_API_KEY_HEADER).toBe('x-internal-api-key');
    expect(env.SCAN_EVENT_INGEST_TIMEOUT_MS).toBe(5_000);
    expect(env.IMAGE_MAX_INPUT_PIXELS).toBe(24_000_000);
    expect(env.MEDIA_VIDEO_MAX_DURATION_SECONDS).toBe(180);
    expect(env.MEDIA_VIDEO_MAX_INPUT_PIXELS).toBe(8_300_000);
    expect(env.SCAN_EVENT_INGEST_URL).toBeUndefined();
    expect(env.SCAN_EVENT_INGEST_API_KEY).toBeUndefined();
  });

  it('coerces + transforms typed values', () => {
    const env = loadEnv({
      ...BASE,
      PORT: '4000',
      MEDIA_PROCESSOR_ENABLED: 'false',
      MEDIA_PROCESSOR_INTERVAL_MS: '2000',
      MEDIA_VIDEO_MAX_DURATION_SECONDS: '60',
      SCAN_EVENT_INGEST_URL: 'http://service-media:3020',
      SCAN_EVENT_INGEST_API_KEY: 'a-shared-secret-of-sufficient-len',
    });
    expect(env.PORT).toBe(4000);
    expect(env.MEDIA_PROCESSOR_ENABLED).toBe(false);
    expect(env.MEDIA_PROCESSOR_INTERVAL_MS).toBe(2000);
    expect(env.MEDIA_VIDEO_MAX_DURATION_SECONDS).toBe(60);
    expect(env.SCAN_EVENT_INGEST_URL).toBe('http://service-media:3020');
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...BASE, NONSENSE: 'x' });
    expect((env as Record<string, unknown>).NONSENSE).toBeUndefined();
  });

  it('rejects a drain interval below the 1s floor', () => {
    expect(() => loadEnv({ ...BASE, MEDIA_PROCESSOR_INTERVAL_MS: '500' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a malformed scan-event ingest URL', () => {
    expect(() => loadEnv({ ...BASE, SCAN_EVENT_INGEST_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a too-short ingest API key', () => {
    expect(() => loadEnv({ ...BASE, SCAN_EVENT_INGEST_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts the OTEL knobs as booleans + strings', () => {
    const env = loadEnv({
      ...BASE,
      OTEL_TRACES_ENABLED: 'false',
      OTEL_METRICS_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/v1/traces',
    });
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318/v1/traces');
  });
});
