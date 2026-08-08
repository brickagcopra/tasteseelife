/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for
 * service-subscription (TS-042-followup-8).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, `stripe`'s HTTP
 * client, ...) is required, so `@opentelemetry/auto-instrumentations-node`
 * patches them. Keep `main.ts`'s top-of-file import order intact.
 *
 * For service-subscription the auto-instrumented `http` (outbound Stripe
 * calls) + `pg` (the subscription / history / invoice writes) spans are the
 * load-bearing ones: a dunning pause/resume shows the inbound HTTP root span,
 * the outbound `subscriptions.update` Stripe call, and the transactional
 * Postgres writes stitched onto a single trace, with the
 * `dunning.pause` / `dunning.resume` logical span (added by `DunningService`)
 * as the named parent (PDD §20.5).
 *
 * The shared helper is imported via the `@taste-and-see/nest-observability/bootstrap`
 * subpath (NOT the package barrel) precisely so this require graph never pulls
 * in `@nestjs/core` ahead of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The domain dunning counters live in `DunningMetrics` (service-local); the
 * `/metrics` scrape route + the global `HttpMetricsInterceptor` come from
 * `ObservabilityModule.forRoot` in `app.module.ts`. See PDD §20.5 +
 * CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-subscription');
