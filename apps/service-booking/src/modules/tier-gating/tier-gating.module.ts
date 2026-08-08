import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { TierGatingController } from './controllers/tier-gating.controller';
import { TierGatingService } from './services/tier-gating.service';

/**
 * Tier-gating module (TS-064). Exposes `TierGatingService` so the
 * BookingsModule can consume the `evaluate` gate at booking-create
 * time. The internal upsert endpoints (controller) hydrate the
 * read-side cache from ops / gateway / future event consumer.
 *
 * `PrismaModule` is registered globally in `AppModule` so the service
 * gets it via DI without an explicit import.
 *
 * Imports `CatalogModule` (TS-220-followup-1) so `evaluate` can resolve
 * the per-service-kind `service_catalog.required_provider_tier` gate
 * via `CatalogService.getByKind`.
 */
@Module({
  imports: [CatalogModule],
  controllers: [TierGatingController],
  providers: [TierGatingService],
  exports: [TierGatingService],
})
export class TierGatingModule {}
