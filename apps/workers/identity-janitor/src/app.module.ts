import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';

import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { JanitorModule } from './janitor/janitor.module';

/**
 * Composition root for the identity janitor worker
 * (TS-022-followup-3 + TS-023-followup-4).
 *
 * - `AppConfigModule` validates `process.env` at bootstrap and
 *   exposes the resulting `Env` via DI.
 * - `JanitorModule` wires the Postgres pool, prune repository,
 *   per-table targets, sweep worker, scheduler, and shutdown hook.
 * - `HealthModule` provides the `/healthz` + `/readyz` HTTP probes.
 * - `ObservabilityModule` (TS-022-followup-3a / TS-022-followup-3a-followup-1)
 *   exposes the Prometheus `/metrics` scrape endpoint via the shared
 *   `@taste-and-see/nest-observability` package. `httpMetrics: false` — the
 *   worker's only HTTP surface is the health probes + scrape route, so
 *   per-request HTTP counters carry no signal; the janitor's domain metrics
 *   live in `JanitorMetrics` instead. The tracing/metrics SDK is booted
 *   earlier, in `src/observability/bootstrap.ts` (first import in `main.ts`).
 */
@Module({
  imports: [
    AppConfigModule,
    JanitorModule,
    HealthModule,
    ObservabilityModule.forRoot({ serviceName: 'worker-identity-janitor', httpMetrics: false }),
  ],
})
export class AppModule {}
