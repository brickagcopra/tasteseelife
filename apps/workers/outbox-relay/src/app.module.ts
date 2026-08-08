import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';

import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { RelayModule } from './relay/relay.module';

/**
 * Composition root for the outbox relay worker (TS-142).
 *
 * - `AppConfigModule` validates `process.env` at bootstrap and
 *   exposes the resulting `Env` via DI.
 * - `RelayModule` wires the Postgres pool, Redis client, repository,
 *   bus publisher, worker, scheduler, and shutdown hook.
 * - `HealthModule` provides the `/healthz` + `/readyz` HTTP probes.
 * - `ObservabilityModule` (TS-142-followup-4) exposes the Prometheus
 *   `/metrics` scrape endpoint via the shared
 *   `@taste-and-see/nest-observability` package. `httpMetrics: false` —
 *   the worker's only HTTP surface is the health probes + scrape route,
 *   so per-request HTTP counters carry no signal; the relay's domain
 *   metrics live in `RelayMetrics` instead. The tracing/metrics SDK is
 *   booted earlier, in `src/observability/bootstrap.ts` (first import in
 *   `main.ts`).
 */
@Module({
  imports: [
    AppConfigModule,
    RelayModule,
    HealthModule,
    ObservabilityModule.forRoot({ serviceName: 'worker-outbox-relay', httpMetrics: false }),
  ],
})
export class AppModule {}
