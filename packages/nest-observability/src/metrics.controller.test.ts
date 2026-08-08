import { getMeter, initMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MetricsController } from './metrics.controller';

/**
 * The controller is a thin shell over `serializeMetrics()`; tests exercise
 * the FULL surface (init → record → serialize) to prove the route actually
 * exposes what the tracing package recorded, not just that the serializer
 * was called.
 *
 * Test isolation: each case boots a fresh MeterProvider with a long export
 * interval (1h) so the periodic reader's background sweep does not race the
 * inline `collect()` inside `serializeMetrics()`. The `afterEach` tears the
 * provider down so meters from one test don't leak into the next.
 */
describe('MetricsController', () => {
  let controller: MetricsController;

  beforeEach(() => {
    initMetrics({
      service: 'nest-observability-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    controller = new MetricsController();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('returns Prometheus text exposition format', async () => {
    getMeter('nest-observability-test:http')
      .createCounter('test_counter_total')
      .add(3, { route: '/healthz' });

    const out = await controller.scrape();

    expect(typeof out).toBe('string');
    expect(out).toMatch(/# TYPE test_counter_total counter/);
    expect(out).toMatch(/test_counter_total\{[^}]*route="\/healthz"[^}]*\} 3/);
  });

  it('includes resource attributes (service.name / deployment.environment) on target_info', async () => {
    getMeter('nest-observability-test:boot').createCounter('boot_counter_total').add(1);

    const out = await controller.scrape();

    expect(out).toMatch(/target_info\{/);
    expect(out).toMatch(/service_name="nest-observability-test"/);
    expect(out).toMatch(/deployment_environment="test"/);
    expect(out).toMatch(/service_version="0\.0\.0-test"/);
  });

  it('returns an empty document when metrics are disabled', async () => {
    // Tear down the harness-initialised provider; this case simulates the
    // OTEL_METRICS_ENABLED=false runtime path.
    await shutdownMetrics();
    controller = new MetricsController();

    const out = await controller.scrape();
    expect(out).toBe('\n');
  });
});
