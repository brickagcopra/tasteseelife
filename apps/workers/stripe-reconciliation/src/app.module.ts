import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';

import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';

/**
 * Composition root for the stripe-reconciliation worker (TS-261).
 *
 * - `AppConfigModule` validates `process.env` at bootstrap and exposes the
 *   resulting `Env` via DI.
 * - `ReconciliationModule` wires the internal HTTP client, the run
 *   orchestrator, and the nightly scheduler.
 * - `HealthModule` provides the `/healthz` + `/readyz` HTTP probes.
 */
@Module({
  // `httpMetrics: false` — this worker's only HTTP surface is the health
  // probes + the scrape route, so per-request counters carry no signal.
  imports: [
    AppConfigModule,
    ReconciliationModule,
    HealthModule,
    ObservabilityModule.forRoot({
      serviceName: 'worker-stripe-reconciliation',
      httpMetrics: false,
    }),
  ],
})
export class AppModule {}
