import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';

import { AggregationModule } from './aggregation/aggregation.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

/**
 * Composition root for the analytics-aggregator worker (TS-217-prep-3b).
 *
 * - `AppConfigModule` validates `process.env` at bootstrap and exposes the
 *   resulting `Env` via DI.
 * - `AggregationModule` wires the internal HTTP client, the run orchestrator,
 *   and the nightly scheduler.
 * - `HealthModule` provides the `/healthz` + `/readyz` HTTP probes.
 */
@Module({
  // `httpMetrics: false` — this worker's only HTTP surface is the health
  // probes + the scrape route, so per-request counters carry no signal.
  imports: [
    AppConfigModule,
    AggregationModule,
    HealthModule,
    ObservabilityModule.forRoot({ serviceName: 'worker-analytics-aggregator', httpMetrics: false }),
  ],
})
export class AppModule {}
