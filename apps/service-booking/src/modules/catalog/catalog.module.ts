import { Module } from '@nestjs/common';

import { CatalogController } from './controllers/catalog.controller';
import { CatalogService } from './services/catalog.service';

/**
 * Service-catalog bounded module (TS-060-followup-2).
 *
 * Composition:
 *   - `CatalogController` — `GET /api/v1/service-catalog` (authenticated
 *     read) + `PUT /api/v1/admin/service-catalog/:kind` (super-admin
 *     upsert).
 *   - `CatalogService` — owns the `booking.service_catalog` table; reads
 *     + admin-edits the per-kind pricing / duration metadata.
 *
 * Depends on:
 *   - `PrismaModule` — registered `@Global()` in `AppModule`, so
 *     `PrismaService` is injectable here without a re-import.
 *   - `NestAuthModule` / `IdempotencyModule` — registered globally in
 *     `AppModule` so `AccessTokenGuard` + `@Idempotent()` resolve.
 *
 * Exports `CatalogService` so the booking-create flow can consult the
 * catalog for `basePrice` once TS-060-followup-2a wires it.
 */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
