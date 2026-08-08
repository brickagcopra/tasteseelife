import { shutdownMetrics, shutdownTracing } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bootstrap file's side effects run at import time. We exercise it
 * indirectly: the file calls `createObservabilityBootstrap` once at module
 * load; subsequent imports inside the same test process are no-ops (Node's
 * module cache). To re-run with different env we use `vi.resetModules()` to
 * clear the cache between cases.
 *
 * The shared bootstrap reads `process.env` directly (NOT through `loadEnv()`),
 * so swapping `process.env` keys before the import suffices. Mirrors
 * service-webhook's bootstrap.test.ts (TS-041a-followup-4).
 */
describe('observability/bootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await Promise.allSettled([shutdownTracing(), shutdownMetrics()]);
    vi.resetModules();
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await Promise.allSettled([shutdownTracing(), shutdownMetrics()]);
  });

  it('imports cleanly when traces + metrics are disabled', async () => {
    process.env['OTEL_TRACES_ENABLED'] = 'false';
    process.env['OTEL_METRICS_ENABLED'] = 'false';
    process.env['NODE_ENV'] = 'test';
    process.env['SERVICE_VERSION'] = '0.0.0-test';

    await expect(import('./bootstrap')).resolves.toBeDefined();
  });

  it('imports cleanly with traces enabled + metrics disabled', async () => {
    process.env['OTEL_TRACES_ENABLED'] = 'true';
    process.env['OTEL_METRICS_ENABLED'] = 'false';
    process.env['NODE_ENV'] = 'test';
    process.env['SERVICE_VERSION'] = '0.0.0-test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:65535/v1/traces';

    await expect(import('./bootstrap')).resolves.toBeDefined();
  });

  it('imports cleanly with default flags (both enabled)', async () => {
    delete process.env['OTEL_TRACES_ENABLED'];
    delete process.env['OTEL_METRICS_ENABLED'];
    process.env['NODE_ENV'] = 'test';
    process.env['SERVICE_VERSION'] = '0.0.0-test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:65535/v1/traces';

    await expect(import('./bootstrap')).resolves.toBeDefined();
  });
});
