/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for
 * service-trust-safety (TS-306-followup-1c).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, the PagerDuty HTTP
 * client, ...) is required, so `@opentelemetry/auto-instrumentations-node`
 * patches them. Keep `main.ts`'s top-of-file import order intact.
 *
 * **This service ran without any of it until now**, which is why the SLA-breach
 * sweep (TS-306-followup-1a) shipped with its metrics class written and then
 * deleted: `getMeter` returns a usable no-op when `initMetrics` was never
 * called, so an instrument here would have compiled, run, and reported nothing
 * while reading as instrumentation. The gap was honest; this closes it.
 *
 * For service-trust-safety the load-bearing auto-instrumented signals are
 * `pg` (the incident insert, which carries an in-transaction outbox append and
 * a booking-hold append on the same connection) and `ioredis` (the outbox
 * consumer's Redis Streams reads and the SLA sweep's BullMQ scheduler). The
 * outbound `http` spans are the PagerDuty enqueue — a page that never left the
 * pod and a page the provider rejected look identical in the log line, and the
 * span separates them.
 *
 * The shared helper is imported via the
 * `@taste-and-see/nest-observability/bootstrap` subpath (NOT the package
 * barrel) precisely so this require graph never pulls in `@nestjs/core` ahead
 * of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The `/metrics` scrape route + the global `HttpMetricsInterceptor` come from
 * `ObservabilityModule.forRoot` in `app.module.ts`. The domain instruments
 * (incidents opened, pages by outcome, the SLA-breach gauges) live with their
 * surfaces. See PDD §20.5 + CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-trust-safety');
