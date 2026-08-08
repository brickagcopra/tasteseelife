export { ObservabilityModule } from './observability.module';
export type { ObservabilityModuleOptions } from './observability.module';
export { MetricsController } from './metrics.controller';
export { HttpMetricsInterceptor } from './http-metrics.interceptor';
export { SentryStatusReporter } from './sentry-status.reporter';
export { OBSERVABILITY_SERVICE_NAME } from './tokens';

// NOTE: `createObservabilityBootstrap` is deliberately NOT re-exported here.
// It must be imported via the `@taste-and-see/nest-observability/bootstrap`
// subpath so the `main.ts` first-line bootstrap does not transitively load
// `@nestjs/core` (which this barrel pulls in via `ObservabilityModule`)
// before OTel auto-instrumentation patches Nest. See `src/bootstrap.ts`.
