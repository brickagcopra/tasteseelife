import { afterEach, describe, expect, it } from 'vitest';

import { initTracing, shutdownTracing } from '../index';

/**
 * `initTracing` is intentionally light on assertions — verifying it actually
 * exports to a real OTLP endpoint is an integration concern (TS-020 will
 * stand up a service against a local collector). These cases pin the
 * misconfiguration / lifecycle contracts:
 *   - `enabled: false` must short-circuit cleanly so CLI scripts and tests
 *     can import the helper without booting the SDK.
 *   - Calling twice without shutdown must throw, not silently drop spans.
 *   - `shutdownTracing` is idempotent.
 */
describe('initTracing lifecycle', () => {
  afterEach(async () => {
    await shutdownTracing();
  });

  it('is a no-op when `enabled: false`', () => {
    expect(() => initTracing({ service: 'service-test', enabled: false })).not.toThrow();
  });

  it('shutdownTracing is safe to call when not initialized', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });

  it('throws on re-init without shutdown', () => {
    initTracing({
      service: 'service-test',
      env: 'test',
      enabled: true,
      endpoint: 'http://127.0.0.1:65535/v1/traces',
    });
    expect(() =>
      initTracing({
        service: 'service-test',
        env: 'test',
        enabled: true,
        endpoint: 'http://127.0.0.1:65535/v1/traces',
      }),
    ).toThrow(/already initialized/);
  });
});
