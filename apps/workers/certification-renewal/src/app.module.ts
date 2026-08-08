import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';

import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { RenewalModule } from './renewal/renewal.module';

/**
 * Composition root for the certification-renewal worker (TS-256).
 *
 *   - `AppConfigModule` validates `process.env` at bootstrap and exposes
 *     the resulting `Env` via DI (`@Global`).
 *   - `RenewalModule` wires the internal HTTP clients + the run
 *     orchestrator + the daily scheduler (which arms itself on init).
 *   - `HealthModule` provides the `/healthz` + `/readyz` probes.
 *
 * The worker has no datastore + no message-bus subscription — it is a
 * scheduled cross-service aggregator over three internal HTTP hops
 * (service-academy renewals batch + expire, service-identity recipient
 * contacts, service-notification dispatch).
 */
@Module({
  // `httpMetrics: false` — this worker's only HTTP surface is the health
  // probes + the scrape route, so per-request counters carry no signal.
  imports: [
    AppConfigModule,
    RenewalModule,
    HealthModule,
    ObservabilityModule.forRoot({
      serviceName: 'worker-certification-renewal',
      httpMetrics: false,
    }),
  ],
})
export class AppModule {}
