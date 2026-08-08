/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for service-household
 * (TS-306-followup-1d).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * The load-bearing auto-instrumented signal here is `pg`. This service owns
 * seniors, households and the per-surface consent flags that CLAUDE.md §12's
 * family-observability boundary is built on, so it sits on the read path of
 * most authenticated surfaces on the platform.
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

createObservabilityBootstrap('service-household');
