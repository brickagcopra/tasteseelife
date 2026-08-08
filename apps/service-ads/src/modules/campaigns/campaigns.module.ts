import { Module } from '@nestjs/common';

import { CampaignsController } from './controllers/campaigns.controller';
import { CampaignRepository } from './repositories/campaign.repository';
import { CampaignsService } from './services/campaigns.service';

/**
 * Campaign-admin bounded module (TS-271a; PRD §10.9; PDD §18.1, §8.2) — the
 * marketing-admin campaign-aggregate CRUD. The first authenticated HTTP
 * surface on service-ads.
 *
 * Composition:
 *   - `CampaignsController` — create / list / detail / edit a campaign with its
 *     creatives + targeting rules; advance a creative's review status.
 *   - `CampaignsService` — the domain decisions (status-transition matrices,
 *     delivery-window + advertiser-id integrity, the USD-only currency gate,
 *     the money ↔ minor-unit boundary, targeting-AST decode).
 *   - `CampaignRepository` — persistence over the three `ads`-schema tables.
 *
 * Every endpoint is gated on `ads:read` (reads) / `ads:write` (mutations) via
 * `@RequirePermissions(...)` + `PermissionGuard`; mutations honour
 * `Idempotency-Key` via `@Idempotent()`. The three tables are platform-wide
 * marketing-admin inventory (no tenant axis) so the TS-141 gate short-circuits
 * (they sit in service-ads's `unscopedModels`).
 *
 * `CampaignsService` is exported so the (future) delivery / capture path and
 * the slot-inventory tooling (TS-272) can compose it.
 */
@Module({
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignRepository],
  exports: [CampaignsService],
})
export class CampaignsModule {}
