/**
 * Correlation fields propagated through every log line (CLAUDE.md §10).
 *
 * - `traceId` / `spanId` come from the OpenTelemetry SDK (see `@taste-and-see/tracing`).
 * - `requestId` is the inbound HTTP request ID (set by the gateway / NestJS interceptor).
 * - `actorId` is the authenticated user ID. **Never** an email or other PII.
 * - `tenantScope` is the active scope token (e.g. `household_xyz`, `tenant_abc`,
 *   or `global` for super-admin paths). Required so logs can be filtered by
 *   tenant for support workflows without leaking cross-tenant data.
 *
 * `exactOptionalPropertyTypes` is enabled (CLAUDE.md §2.1), so optional fields
 * are explicitly `T | undefined` to allow assignment of `undefined` from
 * upstream context plumbing.
 */
export interface LogContext {
  traceId?: string | undefined;
  spanId?: string | undefined;
  requestId?: string | undefined;
  actorId?: string | undefined;
  tenantScope?: string | undefined;
}
