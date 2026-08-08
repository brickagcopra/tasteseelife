import { Module } from '@nestjs/common';

import { WellnessTrendsController } from './controllers/wellness-trends.controller';
import { WellnessTrendsService } from './services/wellness-trends.service';

/**
 * Wellness-trend bounded module (TS-231; PRD §6.4, §6.9; PDD §23.1).
 *
 * Composition:
 *   - `WellnessTrendsController` — one read endpoint
 *     (`GET /api/v1/bookings/seniors/:seniorId/wellness-trends`)
 *     resolving the household from the token `tenantScope`.
 *   - `WellnessTrendsService` — the read-side aggregate (per-visit
 *     wellness-scale series over a 30 / 90-day window, batched
 *     visit-note read, no N+1).
 *
 * Depends on `PrismaModule` (registered globally). Read-only, so no
 * `IdempotencyModule` / `OutboxModule`.
 *
 * Exports `WellnessTrendsService` so `WellnessAnomalyModule` (TS-236)
 * can reuse the same per-visit series read + the shared score math
 * rather than re-querying `booking_visit_notes` — the anomaly detector
 * runs over exactly the series this service already computes.
 */
@Module({
  controllers: [WellnessTrendsController],
  providers: [WellnessTrendsService],
  exports: [WellnessTrendsService],
})
export class WellnessTrendsModule {}
