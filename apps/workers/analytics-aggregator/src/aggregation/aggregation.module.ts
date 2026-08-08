import { Module } from '@nestjs/common';

import { AggregationClient } from './clients/aggregation.client';
import { AggregationOrchestratorService } from './aggregation-orchestrator.service';
import { AggregationScheduler } from './aggregation-scheduler.service';

/**
 * Analytics-aggregator feature module (TS-217-prep-3b). Wires the internal
 * HTTP client, the run orchestrator, and the nightly scheduler. All config
 * comes from the global `AppConfigModule` (ENV_TOKEN); the worker has no
 * datastore.
 */
@Module({
  providers: [AggregationClient, AggregationOrchestratorService, AggregationScheduler],
})
export class AggregationModule {}
