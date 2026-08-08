import { Module } from '@nestjs/common';

import { AssignmentsController } from './controllers/assignments.controller';
import { AssignmentsService } from './services/assignments.service';

/**
 * Assignments bounded module (TS-222) — owns the dedicated culinary-
 * concierge assignment surface (`POST /api/v1/concierge/assignments` +
 * the family `/me` read + the admin per-household history + the end
 * surface). PRD §5.1 Tier 3, §6.6; PDD §10.6.
 *
 * Composition:
 *   - `AssignmentsController` — HTTP boundary; validates with the
 *     contract-side Zod schemas, gates admin writes with
 *     `SuperAdminRoleGuard`, honours `Idempotency-Key` on the mutations.
 *   - `AssignmentsService` — owns the transactional assign/replace + the
 *     reads. Exported so future TS-22x surfaces (the concierge ops
 *     console, the Tier-3 onboarding flow) can consume the active
 *     assignment without an HTTP round-trip.
 */
@Module({
  controllers: [AssignmentsController],
  providers: [AssignmentsService],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}
