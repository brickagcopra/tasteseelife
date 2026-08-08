import { Module } from '@nestjs/common';

import { EnrichmentController } from './controllers/enrichment.controller';
import { EnrichmentService } from './services/enrichment.service';

/**
 * Tier-3 weekly enrichment-summary bounded module (TS-229; PRD §5.1 Tier 3,
 * §6.9; PDD §12.1) — the dedicated concierge's weekly write-up surfaced on the
 * family-portal dashboard.
 *
 * Composition:
 *   - `EnrichmentController` — admin ops HTTP boundary (create / list / detail
 *     / update) gated on `concierge:read` (reads) / `concierge:write`
 *     (mutations) via `@RequirePermissions(...)` + `PermissionGuard`, plus the
 *     household-scoped family reads (`GET /api/v1/concierge/enrichment-summaries/me`
 *     + `.../me/:summaryId`). Honours `Idempotency-Key` on the mutations.
 *   - `EnrichmentService` — create (as `draft`) / list / detail / update (with
 *     the publish / unpublish / archive lifecycle) against
 *     `concierge_enrichment_summaries`, plus the family PUBLISHED-only reads.
 */
@Module({
  controllers: [EnrichmentController],
  providers: [EnrichmentService],
  exports: [EnrichmentService],
})
export class EnrichmentModule {}
