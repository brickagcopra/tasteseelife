import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * Per-worker singleton OTel test harness.
 *
 * `NodeTracerProvider#register()` installs the global tracer provider, the
 * AsyncHooks context manager, and the W3C propagator — exactly the same
 * runtime topology `initTracing()` produces in production, minus the OTLP
 * exporter (which we replace with `InMemorySpanExporter` for inspection).
 *
 * Vitest runs each test file in its own worker, so the singleton flag scopes
 * correctly per worker. Tests should reset the exporter between cases via
 * `harnessExporter.reset()` in a `beforeEach`.
 */
export const harnessExporter = new InMemorySpanExporter();

let registered = false;

export function ensureHarness(): void {
  if (registered) return;
  // OTel SDK v2 (TS-151-followup-20c) takes `spanProcessors` as a constructor
  // arg; `addSpanProcessor()` was removed with the v1.x line, so this is now
  // the only form. A provider constructed without processors silently drops
  // every span, which is why the processor goes in at construction.
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(harnessExporter)],
  });
  provider.register();
  registered = true;
}
