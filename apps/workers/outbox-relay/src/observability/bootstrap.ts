/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for
 * worker-outbox-relay (TS-142-followup-4).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact — the relay's `pg` claim queries +
 * `ioredis` XADD calls are auto-instrumented this way, and the relay's own
 * `outbox_relay.poll` / `poll_source` / `dispatch_row` spans nest under them.
 *
 * The shared helper is imported via the `@taste-and-see/nest-observability/bootstrap`
 * subpath (NOT the package barrel) precisely so this require graph never pulls
 * in `@nestjs/core` ahead of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The relay's domain metrics live in `RelayMetrics` (service-local); the
 * worker wires `ObservabilityModule.forRoot({ httpMetrics: false })` because
 * its only HTTP surface is the health probes + the scrape route. See PDD
 * §20.5 + CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('worker-outbox-relay');
