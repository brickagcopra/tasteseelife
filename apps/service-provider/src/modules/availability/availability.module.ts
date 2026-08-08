import { Module } from '@nestjs/common';

import { AvailabilityController } from './controllers/availability.controller';
import { AvailabilityService } from './services/availability.service';

/**
 * Availability bounded module (TS-203) — owns the self-service
 * availability surface (`GET /api/v1/providers/me/availability-
 * snapshot`, `PUT /api/v1/providers/:providerId/availability`,
 * `DELETE /api/v1/providers/:providerId/availability`) +
 * `provider.availability_updated` outbox emission.
 *
 * Composition:
 *   - `AvailabilityController` — HTTP boundary; validates with
 *     contract-side Zod + Idempotency-Key headers.
 *   - `AvailabilityService` — owns the transactional update +
 *     outbox-event emission + the next-7-days resolved-summary
 *     helper used by the discovery snapshot. Exported so the
 *     discovery module + future booking-svc availability gate can
 *     consume it directly without an HTTP round-trip.
 */
@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
