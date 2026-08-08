import { Module } from '@nestjs/common';

import { JournalsModule } from '../journals/journals.module';
import { RevenueRecognitionController } from './controllers/revenue-recognition.controller';
import { PlanAccountResolverService } from './services/plan-account-resolver.service';
import { RecognitionMetrics } from './services/recognition-metrics';
import { SubscriptionRevenueRecognizerService } from './services/subscription-revenue-recognizer.service';

/**
 * Revenue-recognition module (TS-082, PDD §11.2 + Appendix A,
 * CLAUDE.md §17.17 — subscription revenue is recognised over the
 * service period, never on payment).
 *
 * Composition:
 *   - `SubscriptionRevenueRecognizerService` — the activation +
 *     daily recognition + cancellation write paths.
 *   - `PlanAccountResolverService` — pure helper mapping plan code
 *     to deferred + revenue account codes.
 *   - `RevenueRecognitionController` — three HTTP write endpoints
 *     (POST /api/v1/internal/subscription/activated, POST
 *     /api/v1/internal/subscription/canceled, POST
 *     /api/v1/admin/subscription/recognize-daily).
 *
 * Imports `JournalsModule` to inject the `JournalPostingService` —
 * the activation + recognition + cancellation flows ALL post
 * journals through the shared posting service so the double-entry
 * invariant + the source-event-id UNIQUE idempotency + the
 * accounting-period gate ALL apply uniformly.
 *
 * Exports `SubscriptionRevenueRecognizerService` so TS-084 (refund
 * + contra-revenue handling) can compose the cancel + refund flow
 * without re-importing the recognizer module shape.
 */
@Module({
  imports: [JournalsModule],
  controllers: [RevenueRecognitionController],
  providers: [SubscriptionRevenueRecognizerService, PlanAccountResolverService, RecognitionMetrics],
  exports: [SubscriptionRevenueRecognizerService, PlanAccountResolverService],
})
export class RevenueRecognitionModule {}
