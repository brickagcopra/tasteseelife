/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for service-webhook.
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * For service-webhook the auto-instrumented `http` server spans are especially
 * load-bearing: the inbound Stripe / Checkr edge POSTs land as the root span of
 * every request, and the `pg` instrumentation stitches the
 * `stripe_processed_events` / `checkr_processed_events` INSERT onto that trace
 * so an ops engineer can follow a single event id from edge-arrival to
 * persisted-row (PDD §20.5).
 *
 * The shared helper is imported via the `@taste-and-see/nest-observability/bootstrap`
 * subpath (NOT the package barrel) precisely so this require graph never pulls
 * in `@nestjs/core` ahead of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * Lifted from the former ~60-line verbatim readFlag + init block to
 * `@taste-and-see/nest-observability` (TS-022-followup-3a-followup-1). The
 * webhook-domain counters live in `WebhookMetrics` (service-local). See PDD
 * §20.5 + CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-webhook');
