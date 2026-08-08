/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for service-ads
 * (TS-270-followup-1).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, the internal
 * sponsored-listings resolve HTTP client, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * For service-ads the auto-instrumented `http` (the cluster-internal
 * `service-search → service-ads` sponsored-listings resolve hop) + `pg` (the
 * campaign-aggregate + slot-schedule writes) spans are the load-bearing ones:
 * a campaign create shows the inbound HTTP root span and the transactional
 * Postgres writes (campaign + nested creatives + targeting rules) stitched onto
 * a single trace (PDD §20.5).
 *
 * The shared helper is imported via the
 * `@taste-and-see/nest-observability/bootstrap` subpath (NOT the package
 * barrel) precisely so this require graph never pulls in `@nestjs/core` ahead
 * of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The `/metrics` scrape route + the global `HttpMetricsInterceptor` come from
 * `ObservabilityModule.forRoot` in `app.module.ts`. Domain counters
 * (`ads_targeting_evaluations_total`, the sponsored-resolve histograms) fold in
 * via their own followups (TS-273-followup-1, TS-218a observability) now that
 * this bootstrap + the meter provider exist. See PDD §20.5 + CLAUDE.md §10 for
 * the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-ads');
