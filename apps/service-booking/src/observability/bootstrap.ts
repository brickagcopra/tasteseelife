/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for service-booking.
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * The shared helper is imported via the `@taste-and-see/nest-observability/bootstrap`
 * subpath (NOT the package barrel) precisely so this require graph never pulls
 * in `@nestjs/core` ahead of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * Mirrors service-provider (TS-050-followup-1) / service-identity
 * (TS-020-followup-1). TS-060-followup-4. See PDD §20.5 + CLAUDE.md §10 for
 * the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('service-booking');
