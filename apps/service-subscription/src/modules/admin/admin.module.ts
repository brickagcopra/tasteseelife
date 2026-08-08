import { Module } from '@nestjs/common';

import { AdminSubscriptionsController } from './controllers/admin-subscriptions.controller';
import { AdminSubscriptionsService } from './services/admin-subscriptions.service';

/**
 * Admin bounded module (TS-127 Slice 1; PRD §10.3).
 *
 * Slice 1 ships the read-only `GET /api/v1/admin/subscriptions` +
 * `GET /api/v1/admin/subscriptions/:id` surfaces. Mutations (comp /
 * refund / extend-trial / prorate / pause / resume admin overrides —
 * TS-127-followup-1), plan-catalog edit (TS-127-followup-2), bulk cohort
 * operations (TS-127-followup-3), revenue-recognition reporting
 * (TS-127-followup-4), manual dunning recovery (TS-127-followup-5),
 * audit-event emission (TS-127-followup-6), and the rest of the
 * follow-ups arrive in subsequent slices.
 *
 * No imports — the service depends only on `PrismaService` which is a
 * global provider via `PrismaModule`. No exports today — nothing outside
 * this module consumes admin state directly. Future cross-service admin
 * tooling (TS-128 bookings / TS-129 accounting) lives in their own
 * per-service admin modules and aggregates at the gateway BFF.
 */
@Module({
  controllers: [AdminSubscriptionsController],
  providers: [AdminSubscriptionsService],
})
export class AdminModule {}
