/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for service-audit
 * (TS-306-followup-1d).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * The load-bearing signals here are `ioredis` (the Redis Streams consumer that
 * drains every producer's outbox) and `pg` (the append-only insert with its
 * SHA-256 hash chain). Consumer lag on this service means admin mutations are
 * happening with no durable record yet — a compliance gap that is invisible
 * from the producing side, because the producer's in-transaction append
 * already succeeded.
 *
 * The shared helper is imported via the
 * `@taste-and-see/nest-observability/bootstrap` subpath (NOT the package
 * barrel) precisely so this require graph never pulls in `@nestjs/core` ahead
 * of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The `/metrics` scrape route + the global `HttpMetricsInterceptor` come from
 * `ObservabilityModule.forRoot` in `app.module.ts`. Domain counters are NOT
 * added here — TS-306-followup-1d wires the plumbing; an instrument a surface
 * has not earned is noise, and one written against an uninitialised provider
 * is worse (the service-content finding in TS-306-followup-1c).
 * See PDD §20.5 + CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-audit');
