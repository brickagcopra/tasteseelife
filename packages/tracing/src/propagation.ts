import { context, type Context, propagation } from '@opentelemetry/api';

/**
 * A flat string-to-string map suitable for W3C trace-context propagation.
 *
 * In an HTTP setting this is the request headers object; in a BullMQ setting
 * we keep this shape under a `_traceContext` field on `job.data` (see
 * `./bullmq.ts`).
 */
export type TraceCarrier = Record<string, string>;

/**
 * Inject the currently active trace context into `carrier` using the globally
 * configured propagator (W3C `traceparent` + `tracestate` by default in
 * `@opentelemetry/sdk-node`). When there is no active span the carrier is
 * returned unchanged. The same carrier object is returned for ergonomic
 * chaining; callers that need an immutable input should pass a fresh `{}`.
 */
export function injectTraceContext(carrier: TraceCarrier = {}): TraceCarrier {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Extract a parent OTel context from `carrier`. The returned `Context` should
 * be used with `context.with(parent, fn)` (or the BullMQ helper) so that the
 * spans started inside `fn` are linked to the producer's trace.
 *
 * If `carrier` lacks W3C headers the global propagator returns the active
 * context unchanged — callers do not need to special-case "no headers".
 */
export function extractTraceContext(carrier: TraceCarrier): Context {
  return propagation.extract(context.active(), carrier);
}
