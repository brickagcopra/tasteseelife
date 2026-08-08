import { Module } from '@nestjs/common';

import { MetricsClient } from './clients/metrics.client';
import { MetricsOrchestratorService } from './metrics-orchestrator.service';
import { MetricsScheduler } from './metrics-scheduler.service';

/**
 * Accounting-metrics feature module (TS-260). Wires the internal HTTP
 * client, the run orchestrator, and the nightly scheduler. All config
 * comes from the global `AppConfigModule` (ENV_TOKEN); the worker has no
 * datastore.
 */
@Module({
  providers: [MetricsClient, MetricsOrchestratorService, MetricsScheduler],
})
export class MetricsModule {}
