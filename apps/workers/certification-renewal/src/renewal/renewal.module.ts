import { Module } from '@nestjs/common';

import { DispatchClient } from './clients/dispatch.client';
import { ExpireClient } from './clients/expire.client';
import { RecipientContactsClient } from './clients/recipient-contacts.client';
import { RenewalsClient } from './clients/renewals.client';
import { RenewalOrchestratorService } from './renewal-orchestrator.service';
import { RenewalScheduler } from './renewal-scheduler.service';

/**
 * Certification-renewal feature module (TS-256). Wires the four internal
 * HTTP clients (service-academy renewals batch + expire, service-identity
 * recipient contacts, service-notification dispatch), the run
 * orchestrator, and the daily scheduler (which arms itself on init). All
 * config comes from the global `AppConfigModule` (ENV_TOKEN); the worker
 * has no datastore.
 */
@Module({
  providers: [
    RenewalsClient,
    ExpireClient,
    RecipientContactsClient,
    DispatchClient,
    RenewalOrchestratorService,
    RenewalScheduler,
  ],
})
export class RenewalModule {}
