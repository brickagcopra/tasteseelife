import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';

import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PipelineModule } from './pipeline/pipeline.module';

/**
 * Composition root for the media-processor worker (TS-201; ADR-0002).
 *
 * - `AppConfigModule` validates `process.env` at bootstrap and exposes
 *   the resulting `Env` via DI.
 * - `PipelineModule` wires the injectable ports (object store, scanner,
 *   image processor, video transcoder, scan-event client, job source),
 *   the orchestrator, the domain metrics, and the drain scheduler.
 * - `HealthModule` provides the `/healthz` + `/readyz` probes.
 * - `ObservabilityModule` exposes the Prometheus `/metrics` scrape route
 *   via the shared `@taste-and-see/nest-observability` package.
 *   `httpMetrics: false` — the worker's only HTTP surface is the health
 *   probes + scrape route, so per-request HTTP counters carry no signal;
 *   the pipeline's domain metrics live in `MediaProcessorMetrics`. The
 *   tracing/metrics SDK is booted earlier, in
 *   `src/observability/bootstrap.ts` (first import in `main.ts`).
 */
@Module({
  imports: [
    AppConfigModule,
    PipelineModule,
    HealthModule,
    ObservabilityModule.forRoot({ serviceName: 'worker-media-processor', httpMetrics: false }),
  ],
})
export class AppModule {}
