import { Module } from '@nestjs/common';

import { CreativeReviewController } from './controllers/creative-review.controller';
import { CreativeReviewRepository } from './repositories/creative-review.repository';
import { CreativeReviewService } from './services/creative-review.service';

/**
 * Creative approval-workflow bounded module (TS-277; PRD §10.9; PDD §18.3) — the
 * marketing-admin surface that reviews partner-submitted creatives before they
 * become deliverable, with accessibility + disclosure-compliance review.
 *
 * Composition:
 *   - `CreativeReviewController` — the FIFO review queue, the review detail
 *     (creative + live accessibility report + decision history), the
 *     accessibility-metadata edit, and the approve / reject / request-changes
 *     decision.
 *   - `CreativeReviewService` — the domain decisions (live accessibility
 *     evaluation, the audited override path, the status flip + review-row append).
 *   - `CreativeReviewRepository` — persistence over `ad_creatives` (with its
 *     accessibility columns), the `ad_campaigns` context projection, and the
 *     append-only `ad_creative_reviews` log.
 *
 * The review surface is gated on `marketing:approve_creative` — a separate,
 * higher-trust gate than the `ads:write` the accessibility-metadata edit uses, so
 * the campaign author cannot self-approve. Mutations honour `Idempotency-Key` via
 * `@Idempotent()`. The tables are platform-wide marketing-admin inventory (no
 * tenant axis) so the TS-141 gate short-circuits (they sit in service-ads's
 * `unscopedModels`). Rides the `NestAuthModule` + `IdempotencyModule` wiring
 * `CampaignsModule` (TS-271a) pulled into the composition root.
 */
@Module({
  controllers: [CreativeReviewController],
  providers: [CreativeReviewService, CreativeReviewRepository],
  exports: [CreativeReviewService],
})
export class CreativeReviewModule {}
