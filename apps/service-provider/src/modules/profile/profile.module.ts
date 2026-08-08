import { Module } from '@nestjs/common';

import { ProviderProfileController } from './controllers/provider-profile.controller';
import { ProviderProfileService } from './services/provider-profile.service';

/**
 * Profile bounded module (TS-200) — owns the self-service profile
 * editor surface (`PUT /api/v1/providers/:providerId/profile`) +
 * the `provider.profile_updated` outbox emission.
 *
 * Composition:
 *   - `ProviderProfileController` — HTTP boundary; validates with the
 *     contract-side Zod schemas + Idempotency-Key headers.
 *   - `ProviderProfileService` — owns the transactional update +
 *     outbox-event emission. Exported so the future TS-200-followup-4
 *     GET surface (and any in-cluster admin tooling that wants the
 *     materialised snapshot) can consume it directly without an HTTP
 *     round-trip.
 *
 * No catalog service today — the tag set is free-text (validated by
 * regex) rather than catalog-driven. A future tag-suggestion surface
 * (TS-200-followup-2) can add a separate `ProfileTagCatalogService`
 * for typeahead without changing the wire shape.
 */
@Module({
  controllers: [ProviderProfileController],
  providers: [ProviderProfileService],
  exports: [ProviderProfileService],
})
export class ProfileModule {}
