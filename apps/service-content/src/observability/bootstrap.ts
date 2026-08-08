/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for service-content
 * (TS-306-followup-1c).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * **This service had the dependency and an instrument but never the init.**
 * `PublicBlogMetrics` (TS-282-followup-3) has been calling `getMeter` since the
 * public blog shipped, and `getMeter` returns a usable no-op when `initMetrics`
 * was never called — so `content_public_blog_reads_total` compiled, ran, and
 * reported nothing while reading as instrumentation. Found while closing the
 * same gap on service-trust-safety, which had refused to ship an instrument
 * into it; here one was already live.
 *
 * For service-content the load-bearing auto-instrumented signal is `pg`: the
 * public blog list and detail reads are the platform's only ANONYMOUS database
 * path (TS-282-followup-3), fronted by web-marketing's ISR, so a slow query
 * here shows up as a slow marketing site rather than as a logged-in complaint.
 * The `http` server spans are what let that be attributed per route.
 *
 * The shared helper is imported via the
 * `@taste-and-see/nest-observability/bootstrap` subpath (NOT the package
 * barrel) precisely so this require graph never pulls in `@nestjs/core` ahead
 * of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The `/metrics` scrape route + the global `HttpMetricsInterceptor` come from
 * `ObservabilityModule.forRoot` in `app.module.ts`. See PDD §20.5 +
 * CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-content');
