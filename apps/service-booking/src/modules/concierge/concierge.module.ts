import { Module } from '@nestjs/common';

import { BookingsModule } from '../bookings/bookings.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ConciergeRequestsController } from './controllers/concierge-requests.controller';
import { ConciergeRequestsService } from './services/concierge-requests.service';

/**
 * Concierge bounded module (TS-125).
 *
 * Composition:
 *   - `ConciergeRequestsController` — single HTTP endpoint
 *     (`POST /api/v1/bookings/concierge-request`).
 *   - `ConciergeRequestsService` — thin orchestrator that maps the
 *     price-free family-portal request shape to the canonical
 *     `CreateBookingRequest` shape consumed by `BookingsService`,
 *     deriving `basePrice` + `currency` from the `service_catalog` table
 *     (TS-060-followup-2a) with the `service-kind-defaults.ts` constant
 *     as the not-yet-seeded fallback + the commission-rate source.
 *
 * Depends on:
 *   - `BookingsModule` — exports `BookingsService` so the orchestrator
 *     can delegate the actual row mutation + outbox emission.
 *   - `CatalogModule` — exports `CatalogService` so the orchestrator can
 *     read the per-kind pricing band (TS-060-followup-2a).
 *   - `IdempotencyModule` — registered globally in `AppModule` so
 *     `@Idempotent()` fires on the write endpoint.
 *
 * No exports — nothing outside this module consumes the concierge
 * request flow directly.
 */
@Module({
  imports: [BookingsModule, CatalogModule],
  controllers: [ConciergeRequestsController],
  providers: [ConciergeRequestsService],
})
export class ConciergeModule {}
