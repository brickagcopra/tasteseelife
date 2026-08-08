/**
 * DI token carrying the owning service's name into the shared
 * observability providers (TS-022-followup-3a-followup-1). Lives in its own
 * module so `HttpMetricsInterceptor` and `ObservabilityModule` can both
 * import it without a circular reference between them.
 *
 * The value is consumed by `HttpMetricsInterceptor` to derive its meter
 * name (`<serviceName>:http`) and its counter description, so the metrics a
 * shared package emits are still attributed to the concrete service.
 */
export const OBSERVABILITY_SERVICE_NAME = Symbol('OBSERVABILITY_SERVICE_NAME');
