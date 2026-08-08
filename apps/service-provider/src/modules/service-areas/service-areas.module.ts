import { Module } from '@nestjs/common';

import { ServiceAreasController } from './controllers/service-areas.controller';
import { ServiceAreasService } from './services/service-areas.service';

/**
 * Service-areas bounded module (TS-202) — owns the self-service
 * provider-coverage surface (`GET /api/v1/providers/me/service-areas-
 * snapshot`, `PUT /api/v1/providers/:providerId/service-areas`,
 * `DELETE /api/v1/providers/:providerId/service-areas`) +
 * `provider.service_areas_updated` outbox emission.
 *
 * Composition:
 *   - `ServiceAreasController` — HTTP boundary; validates with
 *     contract-side Zod + Idempotency-Key headers.
 *   - `ServiceAreasService` — owns the transactional full-set-replace
 *     update + outbox-event emission + the planar centroid /
 *     bounding-box computation. Exported so the discovery module
 *     (TS-053-followup-3) can consume the materialised areas directly
 *     without an HTTP round-trip.
 */
@Module({
  controllers: [ServiceAreasController],
  providers: [ServiceAreasService],
  exports: [ServiceAreasService],
})
export class ServiceAreasModule {}
