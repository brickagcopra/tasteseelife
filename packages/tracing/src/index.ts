export { initTracing, shutdownTracing } from './init';
export type { InitTracingOptions } from './init';

export { withSpan, getActiveSpanContext } from './span';
export type { ActiveSpanContext } from './span';

export { injectTraceContext, extractTraceContext } from './propagation';
export type { TraceCarrier } from './propagation';

export { injectIntoJobData, runWithJobContext, TRACE_CONTEXT_KEY } from './bullmq';
export type { JobDataWithTraceContext } from './bullmq';

export { initMetrics, shutdownMetrics, getMeter, serializeMetrics } from './metrics';
export type { InitMetricsOptions } from './metrics';

// Re-export the OTel API instrument types so service-side instrumentation
// modules (e.g. `service-identity`'s HttpMetricsInterceptor) can type their
// fields without taking a direct dep on `@opentelemetry/api`. The
// `@taste-and-see/tracing` package owns the OTel version pin for the
// platform.
export type { Counter, Histogram, Meter, ObservableGauge, UpDownCounter } from '@opentelemetry/api';
