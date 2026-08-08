import { metrics as otelMetrics } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import { getMeter, initMetrics, serializeMetrics, shutdownMetrics } from '../index';

/**
 * Lifecycle + behavioural contracts for the metrics surface.
 *
 * The init/shutdown shape mirrors `initTracing` / `shutdownTracing`:
 *   - `enabled: false` short-circuits so CLI scripts can import without
 *     booting the SDK.
 *   - A double `initMetrics` without shutdown throws — silent
 *     re-registration would mean two MeterProviders fight over the global
 *     and dropped measurements become indistinguishable from "metric was
 *     never recorded".
 *   - `shutdownMetrics` is idempotent.
 *
 * The behavioural cases exercise `getMeter` + `serializeMetrics` against a
 * live MeterProvider so the Prometheus serialiser path is real.
 *
 * The export interval is bumped to 1 hour for these tests so the periodic
 * reader's background sweep doesn't race the `collect()` call inside
 * `serializeMetrics` — the test owns timing, not the SDK.
 */
describe('metrics lifecycle', () => {
  afterEach(async () => {
    await shutdownMetrics();
  });

  it('is a no-op when `enabled: false`', () => {
    expect(() => initMetrics({ service: 'service-test', enabled: false })).not.toThrow();
  });

  it('shutdownMetrics is safe to call when not initialized', async () => {
    await expect(shutdownMetrics()).resolves.toBeUndefined();
  });

  it('throws on re-init without shutdown', () => {
    initMetrics({ service: 'service-test', env: 'test', exportIntervalMillis: 3_600_000 });
    expect(() => initMetrics({ service: 'service-test', env: 'test' })).toThrow(
      /already initialized/,
    );
  });

  it('serializeMetrics returns an empty document when not initialized', async () => {
    const out = await serializeMetrics();
    expect(out).toBe('\n');
  });
});

describe('getMeter + serializeMetrics integration', () => {
  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records a counter and renders it in Prometheus text format', async () => {
    initMetrics({
      service: 'service-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });

    const meter = getMeter('service-test:http');
    const counter = meter.createCounter('http_requests_total', {
      description: 'Total HTTP requests handled',
    });
    counter.add(1, { route: '/healthz', status_code: '200' });
    counter.add(2, { route: '/readyz', status_code: '200' });

    const out = await serializeMetrics();

    // Counter naming becomes `_total` in Prometheus + the OTel SDK appends a
    // `_total` suffix for monotonic counters. The serializer renders the
    // canonical `# TYPE` line + one sample per attribute-set.
    expect(out).toMatch(/# TYPE http_requests_total counter/);
    expect(out).toMatch(/http_requests_total\{[^}]*route="\/healthz"[^}]*\} 1/);
    expect(out).toMatch(/http_requests_total\{[^}]*route="\/readyz"[^}]*\} 2/);
  });

  it('records a histogram and renders bucket / sum / count lines', async () => {
    initMetrics({
      service: 'service-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });

    const meter = getMeter('service-test:http');
    const hist = meter.createHistogram('http_request_duration_seconds', {
      description: 'HTTP request duration in seconds',
    });
    hist.record(0.012, { route: '/healthz' });
    hist.record(0.087, { route: '/healthz' });
    hist.record(0.21, { route: '/readyz' });

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE http_request_duration_seconds histogram/);
    expect(out).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/healthz"[^}]*\} 2/);
    expect(out).toMatch(/http_request_duration_seconds_sum\{[^}]*route="\/healthz"[^}]*\}/);
    expect(out).toMatch(/http_request_duration_seconds_bucket\{[^}]*route="\/healthz"[^}]*\}/);
  });

  it('exposes resource attributes via the OTel `target_info` metric', async () => {
    initMetrics({
      service: 'service-test',
      env: 'staging',
      version: '1.2.3',
      exportIntervalMillis: 3_600_000,
    });

    const meter = getMeter('service-test:boot');
    meter.createCounter('bootstrap_total').add(1);

    const out = await serializeMetrics();

    // Resource attributes surface in the Prometheus `target_info` sentinel
    // metric — Prometheus joins them onto data via instance label rules.
    expect(out).toMatch(/target_info\{/);
    expect(out).toMatch(/service_name="service-test"/);
    expect(out).toMatch(/deployment_environment="staging"/);
    expect(out).toMatch(/service_version="1\.2\.3"/);
  });

  it('returns an empty document after shutdown', async () => {
    initMetrics({
      service: 'service-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });

    getMeter('service-test:boot').createCounter('shutdown_test_total').add(1);
    await shutdownMetrics();

    // Once the provider is torn down, the global meter provider falls back
    // to the OTel no-op, which means subsequent `getMeter().createCounter`
    // calls don't accumulate values — and `serializeMetrics` reports an
    // empty document because there's no `active` reader to collect from.
    const out = await serializeMetrics();
    expect(out).toBe('\n');
  });

  it('getMeter returns a usable meter even when metrics are not initialized', () => {
    // Without `initMetrics`, the OTel global meter provider is the no-op
    // provider — calls to `createCounter().add()` must not throw, so that
    // unit tests + CLI scripts can run instrumented code without booting
    // the SDK.
    const meter = getMeter('service-test:no-init');
    expect(() => meter.createCounter('noop_counter').add(1)).not.toThrow();
    // Sanity: the global provider is whatever OTel ships as default.
    expect(otelMetrics.getMeterProvider()).toBeDefined();
  });
});
