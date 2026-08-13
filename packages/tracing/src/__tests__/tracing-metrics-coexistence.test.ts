import { metrics as otelMetrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getMeter,
  initMetrics,
  initTracing,
  serializeMetrics,
  shutdownMetrics,
  shutdownTracing,
} from '../index';

/**
 * Regression guard for the OTel SDK v2 bump (TS-151-followup-20c).
 *
 * Every other metrics test calls `initMetrics` on its own. Production never
 * does: `createObservabilityBootstrap` runs `initTracing` FIRST and
 * `initMetrics` second, and that ordering is what broke. SDK v2's `NodeSDK`
 * builds its own `MeterProvider` from `OTEL_METRICS_EXPORTER` (defaulting to
 * OTLP when unset) and claims the global metrics slot; the later
 * `setGlobalMeterProvider` is then refused and returns `false` rather than
 * throwing. The visible symptom was a `/metrics` endpoint that still served
 * `target_info` and had lost every domain instrument — healthy-looking and
 * empty. No unit test caught it because no unit test booted both SDKs
 * together, so this file does exactly that.
 *
 * These tests live in their own file deliberately: `initTracing` mutates
 * process-global OTel state (context manager, propagator, global providers),
 * and vitest isolates per file, so the blast radius stops here.
 */
describe('initTracing + initMetrics coexistence', () => {
  afterEach(async () => {
    await shutdownMetrics();
    await shutdownTracing();
    otelMetrics.disable();
  });

  it('records domain instruments through /metrics when tracing booted first', async () => {
    // Exactly the production bootstrap order. The endpoint is deliberately a
    // closed port — the exporter must never be contacted for this to pass.
    initTracing({
      service: 'service-test',
      env: 'test',
      endpoint: 'http://127.0.0.1:65535/v1/traces',
    });
    initMetrics({
      service: 'service-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });

    getMeter('service-test:coexistence')
      .createCounter('coexistence_probe_total')
      .add(1, { result: 'ok' });

    const out = await serializeMetrics();

    // The assertion that actually failed before `metricReaders: []` landed.
    expect(out).toMatch(/coexistence_probe_total\{[^}]*result="ok"[^}]*\} 1/);
    // `target_info` alone is NOT sufficient evidence — it rendered fine
    // throughout the regression, which is precisely what made it look healthy.
    expect(out).toContain('target_info');
  });

  it('initMetrics throws rather than silently losing instruments when the global slot is taken', async () => {
    const squatter = new MeterProvider();
    otelMetrics.setGlobalMeterProvider(squatter);

    expect(() => initMetrics({ service: 'service-test', env: 'test' })).toThrow(
      /already owns the global metrics API/,
    );

    await squatter.shutdown();
  });
});
