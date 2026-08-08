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
  // OTel SDK v2 takes `spanProcessors` as a constructor arg; on the v1.x
  // line we're pinned to (`@opentelemetry/sdk-trace-node@1.27.0`), the API
  // is `addSpanProcessor()` after construction. When we bump to v2 the
  // constructor form is preferred — track via the dependency upgrade plan.
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(harnessExporter));
  provider.register();
  registered = true;
}
