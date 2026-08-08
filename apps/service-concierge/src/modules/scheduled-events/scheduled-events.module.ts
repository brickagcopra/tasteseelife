import { Module } from '@nestjs/common';

import { ScheduledEventsController } from './controllers/scheduled-events.controller';
import { ScheduledEventsService } from './services/scheduled-events.service';

/**
 * Scheduled-events bounded module (TS-227; PRD §5.1 Tier 3 "social outings ·
 * event dining", §6.6; PDD §10.6) — the concierge fulfilment surface for the
 * tickets TS-223 fills + the TS-224 ops console triages.
 *
 * Composition:
 *   - `ScheduledEventsController` — admin HTTP boundary. Gated on
 *     `concierge:read` (list) / `concierge:write` (schedule + update) via
 *     `@RequirePermissions(...)` + `PermissionGuard`; honours `Idempotency-Key`
 *     on the mutations.
 *   - `ScheduledEventsService` — schedule / list / update against
 *     `concierge_scheduled_events`, with in-service ticket-household integrity
 *     checks + the status-transition matrix.
 */
@Module({
  controllers: [ScheduledEventsController],
  providers: [ScheduledEventsService],
  exports: [ScheduledEventsService],
})
export class ScheduledEventsModule {}
