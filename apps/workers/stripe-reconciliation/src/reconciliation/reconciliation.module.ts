import { Module } from '@nestjs/common';

import { ReconciliationClient } from './clients/reconciliation.client';
import { ReconciliationOrchestratorService } from './reconciliation-orchestrator.service';
import { ReconciliationScheduler } from './reconciliation-scheduler.service';

/**
 * Stripe-reconciliation feature module (TS-261). Wires the internal HTTP
 * client, the run orchestrator, and the nightly scheduler. All config comes
 * from the global `AppConfigModule` (ENV_TOKEN); the worker has no
 * datastore.
 */
@Module({
  providers: [ReconciliationClient, ReconciliationOrchestratorService, ReconciliationScheduler],
})
export class ReconciliationModule {}
