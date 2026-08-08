import { shutdownMetrics, shutdownTracing } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createObservabilityBootstrap } from './bootstrap';

/**
 * `createObservabilityBootstrap` is the env-reading facade over
 * `initTracing` / `initMetrics`. The underlying SDKs throw on double-init,
 * so each case tears them down in `beforeEach`/`afterEach`. We verify:
 *   - the returned flags reflect the env (defaults + explicit + invalid);
 *   - both SDKs initialise without throwing under each flag combination;
 *   - an empty/invalid `serviceName` is rejected before touching the SDK.
 *
 * The helper reads `process.env` directly (NOT through a `loadEnv()`), so
 * swapping `process.env` keys before the call suffices.
 */
describe('createObservabilityBootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await Promise.allSettled([shutdownTracing(), shutdownMetrics()]);
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await Promise.allSettled([shutdownTracing(), shutdownMetrics()]);
  });

  it('defaults both flags to enabled when the env is unset', () => {
    delete process.env['OTEL_TRACES_ENABLED'];
    delete process.env['OTEL_METRICS_ENABLED'];
    process.env['NODE_ENV'] = 'test';
    process.env['SERVICE_VERSION'] = '0.0.0-test';

    const result = createObservabilityBootstrap('service-test');

    expect(result).toEqual({
      tracesEnabled: true,
      metricsEnabled: true,
      env: 'test',
      version: '0.0.0-test',
      // No DSN in the test env, so Sentry reports why it is off rather than
      // staying quiet about it (TS-504-followup-2a).
      sentry: { enabled: false, reason: 'no_dsn' },
    });
  });

  it('honours explicit false flags', () => {
    process.env['OTEL_TRACES_ENABLED'] = 'false';
    process.env['OTEL_METRICS_ENABLED'] = '0';
    process.env['NODE_ENV'] = 'staging';
    process.env['SERVICE_VERSION'] = '1.2.3';

    const result = createObservabilityBootstrap('service-test');

    expect(result.tracesEnabled).toBe(false);
    expect(result.metricsEnabled).toBe(false);
    expect(result.env).toBe('staging');
    expect(result.version).toBe('1.2.3');
  });

  it('falls back to defaults for NODE_ENV / SERVICE_VERSION', () => {
    delete process.env['NODE_ENV'];
    delete process.env['SERVICE_VERSION'];
    process.env['OTEL_TRACES_ENABLED'] = 'false';
    process.env['OTEL_METRICS_ENABLED'] = 'false';

    const result = createObservabilityBootstrap('service-test');

    expect(result.env).toBe('development');
    expect(result.version).toBe('dev');
  });

  it('treats an unrecognised flag value as the default (enabled)', () => {
    process.env['OTEL_TRACES_ENABLED'] = 'maybe';
    process.env['OTEL_METRICS_ENABLED'] = 'false';
    process.env['NODE_ENV'] = 'test';

    const result = createObservabilityBootstrap('service-test');

    expect(result.tracesEnabled).toBe(true);
    expect(result.metricsEnabled).toBe(false);
  });

  it('initialises cleanly with traces enabled + an OTLP endpoint', () => {
    process.env['OTEL_TRACES_ENABLED'] = 'true';
    process.env['OTEL_METRICS_ENABLED'] = 'false';
    process.env['NODE_ENV'] = 'test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:65535/v1/traces';

    expect(() => createObservabilityBootstrap('service-test')).not.toThrow();
  });

  it('rejects an empty serviceName before touching the SDK', () => {
    expect(() => createObservabilityBootstrap('')).toThrow(
      /serviceName must be a non-empty string/,
    );
  });

  /**
   * Sentry rides on this bootstrap rather than on 24 per-service edits
   * (TS-504-followup-2a). The recurring platform defect is a property true of
   * a whole edge implemented as a per-site opt-in with a third of the sites
   * missed — so the property under test is "wiring the bootstrap wires
   * Sentry", not "service X remembered to call initSentry".
   */
  describe('sentry', () => {
    it('reports why it is off when no DSN is configured, rather than staying silent', () => {
      delete process.env['SENTRY_DSN'];
      process.env['NODE_ENV'] = 'test';

      expect(createObservabilityBootstrap('service-test').sentry).toEqual({
        enabled: false,
        reason: 'no_dsn',
      });
    });

    it('comes up with a service-qualified release when a DSN is present', () => {
      process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
      process.env['NODE_ENV'] = 'test';
      process.env['SERVICE_VERSION'] = '2.1.0';

      expect(createObservabilityBootstrap('service-booking').sentry).toEqual({
        enabled: true,
        release: 'service-booking@2.1.0',
      });
    });

    it('is not gated by the OTel flags — they are a different subsystem', () => {
      // A knob that turns off traces must not turn off error reporting.
      // `SENTRY_DSN`'s absence is the only off switch, deliberately, so two
      // settings can never contradict each other.
      process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
      process.env['OTEL_TRACES_ENABLED'] = 'false';
      process.env['OTEL_METRICS_ENABLED'] = 'false';
      process.env['NODE_ENV'] = 'test';

      expect(createObservabilityBootstrap('service-test').sentry.enabled).toBe(true);
    });
  });
});
