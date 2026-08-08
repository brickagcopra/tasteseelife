import { Module } from '@nestjs/common';

import { WellnessTrendsModule } from '../wellness-trends/wellness-trends.module';
import { WellnessAnomalyController } from './controllers/wellness-anomaly.controller';
import { WellnessAnomalyService } from './services/wellness-anomaly.service';

/**
 * Wellness-anomaly bounded module (TS-236; PRD §6.9; PDD §23.1).
 *
 * Composition:
 *   - `WellnessAnomalyController` — one read endpoint
 *     (`GET /api/v1/bookings/seniors/:seniorId/wellness-anomalies`)
 *     resolving the household from the token `tenantScope`.
 *   - `WellnessAnomalyService` — runs the shared `detectWellnessAnomalies`
 *     decline detector over the per-visit series.
 *
 * Imports `WellnessTrendsModule` (which exports `WellnessTrendsService`)
 * so the anomaly read reuses the existing per-visit scored series rather
 * than re-querying `booking_visit_notes` — one scan, one score-math
 * source. Read-only, so no `IdempotencyModule` / `OutboxModule`.
 */
@Module({
  imports: [WellnessTrendsModule],
  controllers: [WellnessAnomalyController],
  providers: [WellnessAnomalyService],
})
export class WellnessAnomalyModule {}
