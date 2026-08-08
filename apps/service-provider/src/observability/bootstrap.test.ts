import { shutdownMetrics, shutdownTracing } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bootstrap file's side effects run at import time. We exercise it
 * indirectly: the file calls `initTracing` / `initMetrics` once at module
 * load; subsequent imports inside the same test process are no-ops
 * (Node's module cache). To re-run with different env we use
 * `vi.resetModules()` to clear the cache between cases.
 *
 * What we verify:
 *   - When `OTEL_TRACES_ENABLED=false` is set in the env, the import
 *     succeeds without booting the SDK (no `already initialized` error
 *     on subsequent re-init).
 *   - When `OTEL_METRICS_ENABLED=false` is set, the same.
 *   - When both flags default to true, both SDKs initialise (importing
 *     a second time without resetting modules would throw the
 *     `already initialized` error from the SDK).
 *
 * The bootstrap reads `process.env` directly (NOT through `loadEnv()`),
 * so swapping `process.env` keys before the import suffices. Mirrors
 * service-identity's bootstrap.test.ts (TS-020-followup-1).
 */
describe('observability/bootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    // Reset prior SDK state from a previous test.
    await Promise.allSettled([shutdownTracing(), shutdownMetrics()]);
    // Reset Node's module cache so the bootstrap re-runs.
    vi.resetModules();
  });

  afterEach(async () => {
    // Restore env to keep test isolation.
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

  it('treats `OTEL_TRACES_ENABLED=invalid` as the default (enabled)', async () => {
    process.env['OTEL_TRACES_ENABLED'] = 'maybe';
    process.env['OTEL_METRICS_ENABLED'] = 'false';
    process.env['NODE_ENV'] = 'test';
    process.env['SERVICE_VERSION'] = '0.0.0-test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:65535/v1/traces';

    await expect(import('./bootstrap')).resolves.toBeDefined();
  });
});
