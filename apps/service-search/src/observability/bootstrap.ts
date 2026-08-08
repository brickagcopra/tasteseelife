/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for service-search
 * (TS-111-followup-4).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, the outbound `http`
 * client the sponsored-listings resolve uses, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * For service-search the auto-instrumented `http` spans are doubly load-bearing:
 * the inbound `POST /api/v1/search/providers` lands as the root span of every
 * discovery query, and the OUTBOUND `http` client span for the TS-218b
 * sponsored-listings resolve (search → service-ads) stitches onto that trace so
 * an ops engineer can see whether the ads hop, not the index, is the latency
 * tail (PDD §20.5).
 *
 * The shared helper is imported via the `@taste-and-see/nest-observability/bootstrap`
 * subpath (NOT the package barrel) precisely so this require graph never pulls
 * in `@nestjs/core` ahead of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The domain search counters / histogram / index-size gauge live in
 * `SearchMetrics` (service-local, co-located with the `ProviderSearchService`
 * it instruments). See PDD §20.5 + CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-search');
