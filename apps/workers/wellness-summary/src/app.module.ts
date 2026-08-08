import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';

import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { SummaryModule } from './summary/summary.module';

/**
 * Composition root for the wellness-summary worker (TS-235).
 *
 *   - `AppConfigModule` validates `process.env` at bootstrap and exposes
 *     the resulting `Env` via DI (`@Global`).
 *   - `SummaryModule` wires the internal HTTP clients + the run
 *     orchestrator + the monthly scheduler (which arms itself on init).
 *   - `HealthModule` provides the `/healthz` + `/readyz` probes.
 *
 * The worker has no datastore + no message-bus subscription — it is a
 * scheduled cross-service aggregator over four internal HTTP reads/writes.
 */
@Module({
  // `httpMetrics: false` — this worker's only HTTP surface is the health
  // probes + the scrape route, so per-request counters carry no signal.
  imports: [
    AppConfigModule,
    SummaryModule,
    HealthModule,
    ObservabilityModule.forRoot({ serviceName: 'worker-wellness-summary', httpMetrics: false }),
  ],
})
export class AppModule {}
