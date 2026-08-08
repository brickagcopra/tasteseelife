/**
 * OpenTelemetry tracing + Prometheus metrics + Sentry bootstrap for
 * worker-accounting-metrics.
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` / `initSentry` as a module-load side
 * effect, before any instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...)
 * is required, so `@opentelemetry/auto-instrumentations-node` patches them.
 * Keep `main.ts`'s top-of-file import order intact.
 *
 * The shared helper is imported via the `@taste-and-see/nest-observability/bootstrap`
 * subpath (NOT the package barrel) precisely so this require graph never pulls
 * in `@nestjs/core` ahead of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * TS-504-followup-2a-2: this worker was one of SIX that had no observability
 * wiring of any kind — no bootstrap, no OTel env keys, no shared exception
 * filter — and so emitted no traces, no metrics and no error reports. They were
 * never part of TS-306-followup-1d's "21/21" fleet. See PDD §20.5, CLAUDE.md §10.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('worker-accounting-metrics');
