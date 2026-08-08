import { type Span, type SpanOptions, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = '@taste-and-see/tracing';

export interface ActiveSpanContext {
  traceId: string;
  spanId: string;
}

/**
 * Run `fn` inside an active OTel span named `name`. The span:
 *   - is set as the active span for the duration of `fn` (so child code
 *     reads the right `traceId` via `getActiveSpanContext` / W3C headers),
 *   - is marked `OK` on success, `ERROR` on throw (with the thrown `Error`
 *     recorded via `recordException`),
 *   - is always ended in a `finally` block so a synchronous bug above
 *     `span.end()` cannot leak a span.
 *
 * Use this at any logical operation boundary you want to trace (e.g. a use
 * case method, a queue handler, an outbound third-party call). HTTP and
 * common library calls are already auto-instrumented — don't double-wrap.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (err instanceof Error) {
        span.recordException(err);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Read `traceId` / `spanId` from the currently active span. Returns
 * `undefined` when there is no active span (e.g. inside a CLI script that
 * never called `initTracing`). The logger package consumes this to stamp
 * correlation fields onto every log line without per-call boilerplate.
 */
export function getActiveSpanContext(): ActiveSpanContext | undefined {
  const span = trace.getActiveSpan();
  if (span === undefined) return undefined;
  const ctx = span.spanContext();
  if (ctx.traceId === '' || ctx.spanId === '') return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}
