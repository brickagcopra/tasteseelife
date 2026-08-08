import { Module } from '@nestjs/common';

import { DispatchClient } from './clients/dispatch.client';
import { HouseholdsClient } from './clients/households.client';
import { ObservationSummaryClient } from './clients/observation-summary.client';
import { RecipientContactsClient } from './clients/recipient-contacts.client';
import { SummaryOrchestratorService } from './summary-orchestrator.service';
import { SummaryScheduler } from './summary-scheduler.service';

/**
 * Wellness-summary feature module (TS-235). Wires the four internal HTTP
 * clients, the run orchestrator, and the monthly scheduler. All config
 * comes from the global `AppConfigModule` (ENV_TOKEN); the worker has no
 * datastore.
 */
@Module({
  providers: [
    HouseholdsClient,
    RecipientContactsClient,
    ObservationSummaryClient,
    DispatchClient,
    SummaryOrchestratorService,
    SummaryScheduler,
  ],
})
export class SummaryModule {}
