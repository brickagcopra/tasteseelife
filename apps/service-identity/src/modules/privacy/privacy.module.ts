import { Module } from '@nestjs/common';

import { AdminPrivacyRequestsController } from './controllers/admin-privacy-requests.controller';
import { InternalPrivacyExportController } from './controllers/internal-privacy-export.controller';
import { PrivacyRequestsController } from './controllers/privacy-requests.controller';
import { PrivacyOverdueRunner } from './privacy-overdue.runner';
import { DataSubjectRequestsService } from './services/data-subject-requests.service';
import { PrivacyExportService } from './services/privacy-export.service';
import { PrivacyOverdueMetrics } from './services/privacy-overdue-metrics';
import { PrivacyOverdueSweepService } from './services/privacy-overdue-sweep.service';

/**
 * Privacy Center — data-subject requests (TS-309a; PRD §11.4; PDD §16.3,
 * §16.4).
 *
 * Two surfaces over one lifecycle: the requester's (any authenticated user
 * exercising a statutory right about themselves) and the operator's (gated
 * `privacy:read` / `privacy:write`).
 *
 * **Why this lives in service-identity.** The hard part of a data-subject
 * request is not storage; it is "who is this person, and may they act for
 * that subject". Identity already owns users, sessions and MFA — the
 * verification machinery a separate `service-privacy` would have to call on
 * every request anyway — and a self-service request is verified BY an
 * MFA-backed session issued here. If erasure orchestration later needs its own
 * queue and its own failure domain (TS-309c), splitting it out is a migration
 * of one table rather than a redesign.
 *
 * `PrismaService` and `AuditEmitter` come from their global modules
 * (`AuditModule.forRoot` in the composition root makes identity the fifth
 * consumer of the shared emitter extracted in TS-303b-followup-1).
 */
/**
 * TS-309b adds a third surface: the internal, shared-secret-gated export
 * contribution the assembly job fans out to. It shares the module because it
 * shares the domain, not the auth model — it is the only route here reachable
 * without a session, and its guard is the header.
 *
 * TS-309a-followup-2 adds the first thing here that is not a request at all:
 * `PrivacyOverdueRunner` + `PrivacyOverdueSweepService`, a read-only sweep that
 * watches `due_at`. Before it, a statutory deadline could pass with no signal
 * anywhere. It has NO controller — the output is a metric and a log line, and
 * an endpoint would be a second, worse place to look at the same question that
 * the operator queue (ordered deadline-soonest first) already answers.
 * `BullMqSchedulerService` comes from the `@Global()` scheduler module.
 */
@Module({
  controllers: [
    PrivacyRequestsController,
    AdminPrivacyRequestsController,
    InternalPrivacyExportController,
  ],
  providers: [
    DataSubjectRequestsService,
    PrivacyExportService,
    PrivacyOverdueSweepService,
    PrivacyOverdueMetrics,
    PrivacyOverdueRunner,
  ],
})
export class PrivacyModule {}
