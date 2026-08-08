import { APP_INTERCEPTOR } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsController } from './metrics.controller';
import { ObservabilityModule } from './observability.module';
import { OBSERVABILITY_SERVICE_NAME } from './tokens';

/**
 * `ObservabilityModule.forRoot` is a pure factory — we assert the shape of
 * the `DynamicModule` it returns rather than booting a full Nest app, so the
 * test stays fast and free of the OTel SDK lifecycle (exercised in the
 * interceptor/controller tests).
 *
 * The returned providers are Nest's `Provider` union; we read `provide` /
 * `useValue` / `useClass` off a narrow structural view rather than the union
 * (whose member types differ on those keys).
 */
type ProviderView = { provide?: unknown; useValue?: unknown; useClass?: unknown };

function providerViews(mod: { providers?: readonly unknown[] }): ProviderView[] {
  return (mod.providers ?? []).filter(
    (p): p is ProviderView => typeof p === 'object' && p !== null,
  );
}

describe('ObservabilityModule.forRoot', () => {
  it('always registers the scrape controller + service-name provider', () => {
    const mod = ObservabilityModule.forRoot({ serviceName: 'service-foo' });

    expect(mod.module).toBe(ObservabilityModule);
    expect(mod.controllers).toEqual([MetricsController]);

    const nameProvider = providerViews(mod).find((p) => p.provide === OBSERVABILITY_SERVICE_NAME);
    expect(nameProvider?.useValue).toBe('service-foo');
  });

  it('mounts the global HttpMetricsInterceptor by default', () => {
    const mod = ObservabilityModule.forRoot({ serviceName: 'service-foo' });

    const interceptor = providerViews(mod).find((p) => p.provide === APP_INTERCEPTOR);
    expect(interceptor?.useClass).toBe(HttpMetricsInterceptor);
  });

  it('omits the HttpMetricsInterceptor when httpMetrics is false', () => {
    const mod = ObservabilityModule.forRoot({ serviceName: 'worker-foo', httpMetrics: false });

    const hasInterceptor = providerViews(mod).some((p) => p.provide === APP_INTERCEPTOR);
    expect(hasInterceptor).toBe(false);

    // The scrape controller + service-name provider are still wired.
    expect(mod.controllers).toEqual([MetricsController]);
    const nameProvider = providerViews(mod).find((p) => p.provide === OBSERVABILITY_SERVICE_NAME);
    expect(nameProvider?.useValue).toBe('worker-foo');
  });

  it('rejects an empty serviceName', () => {
    expect(() => ObservabilityModule.forRoot({ serviceName: '' })).toThrow(
      /serviceName must be a non-empty string/,
    );
  });
});
