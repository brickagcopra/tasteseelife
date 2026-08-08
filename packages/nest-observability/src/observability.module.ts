import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsController } from './metrics.controller';
import { SentryStatusReporter } from './sentry-status.reporter';
import { OBSERVABILITY_SERVICE_NAME } from './tokens';

/** Options for {@link ObservabilityModule.forRoot}. */
export interface ObservabilityModuleOptions {
  /**
   * The owning service's name (e.g. `service-identity`). Drives the
   * HTTP interceptor's meter name (`<serviceName>:http`) + counter
   * description so a shared package still attributes metrics to the
   * concrete service.
   */
  readonly serviceName: string;
  /**
   * Mount the global `HttpMetricsInterceptor`. Defaults to `true`. Pass
   * `false` for surfaces where per-request HTTP counters carry no signal —
   * e.g. background workers whose only HTTP routes are the health probes +
   * the `/metrics` scrape endpoint (worker-identity-janitor TS-022-followup-3a).
   */
  readonly httpMetrics?: boolean;
}

/**
 * Shared observability wiring (TS-022-followup-3a-followup-1). Collapses the
 * verbatim per-service `MetricsController` + `HttpMetricsInterceptor` +
 * module copies that lived in service-identity (TS-020-followup-1),
 * service-provider (TS-050-followup-1), service-webhook (TS-041a-followup-4),
 * and worker-identity-janitor (TS-022-followup-3a) into one configurable
 * `forRoot`.
 *
 * Wires:
 *   - `MetricsController` — the unconditional Prometheus `/metrics` scrape
 *     route (always mounted).
 *   - The `OBSERVABILITY_SERVICE_NAME` provider — carries `serviceName` into
 *     the interceptor.
 *   - `APP_INTERCEPTOR` → `HttpMetricsInterceptor` — global per-request
 *     counter + duration histogram, mounted unless `httpMetrics: false`.
 *
 * The tracing/metrics SDK init happens BEFORE this module loads — see each
 * service's `src/observability/bootstrap.ts` (a shim calling
 * `createObservabilityBootstrap` from the `/bootstrap` subpath) imported as
 * the first line of `main.ts`. By the time Nest constructs the DI graph and
 * instantiates `HttpMetricsInterceptor`, the global MeterProvider is already
 * wired, so `getMeter(...)` returns the real meter (not the no-op fallback).
 *
 * Domain-metric classes (e.g. `JanitorMetrics`, `WebhookMetrics`) stay
 * service-local — they are domain-specific, not boilerplate. A service that
 * exports a global domain-metrics provider keeps its own small module for
 * that (see service-webhook's `WebhookMetricsModule`).
 *
 * Not `@Global()`: `APP_INTERCEPTOR` providers apply globally regardless of
 * the declaring module's scope, and `MetricsController` only needs to be
 * registered once in the importing AppModule — so global scope buys nothing.
 */
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions): DynamicModule {
    const { serviceName } = options;
    if (typeof serviceName !== 'string' || serviceName.length === 0) {
      throw new Error('ObservabilityModule.forRoot: serviceName must be a non-empty string');
    }

    const providers: Provider[] = [
      { provide: OBSERVABILITY_SERVICE_NAME, useValue: serviceName },
      // Unconditional, like MetricsController: "is error reporting on?" is a
      // question every workload has, including the ones that opt out of HTTP
      // metrics. See the reporter for why the answer has to be logged from
      // here rather than from the bootstrap that computes it.
      SentryStatusReporter,
    ];

    if (options.httpMetrics !== false) {
      providers.push({ provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor });
    }

    return {
      module: ObservabilityModule,
      controllers: [MetricsController],
      providers,
    };
  }
}
