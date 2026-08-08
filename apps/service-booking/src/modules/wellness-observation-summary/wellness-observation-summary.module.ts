import { Module } from '@nestjs/common';

import { WellnessTrendsModule } from '../wellness-trends/wellness-trends.module';
import { WellnessObservationSummaryController } from './controllers/wellness-observation-summary.controller';
import { WellnessObservationSummaryService } from './services/wellness-observation-summary.service';

/**
 * Wellness-observation-summary bounded module (TS-235; PRD §6.4, §6.9;
 * PDD §12.2).
 *
 * Composition:
 *   - `WellnessObservationSummaryController` — one shared-secret-pinned
 *     internal read endpoint
 *     (`GET /api/v1/internal/bookings/households/:householdId/seniors/
 *     :seniorId/wellness-observation-summary`) consumed by the monthly
 *     wellness-summary worker.
 *   - `WellnessObservationSummaryService` — folds the TS-231 per-visit
 *     trend series into the compact latest + mean + count roll-up the
 *     email carries.
 *
 * Imports `WellnessTrendsModule` (TS-231) to reuse the exported
 * `WellnessTrendsService` read path rather than re-querying
 * `booking_visit_notes`. Read-only, so no `IdempotencyModule` /
 * `OutboxModule`.
 */
@Module({
  imports: [WellnessTrendsModule],
  controllers: [WellnessObservationSummaryController],
  providers: [WellnessObservationSummaryService],
})
export class WellnessObservationSummaryModule {}
