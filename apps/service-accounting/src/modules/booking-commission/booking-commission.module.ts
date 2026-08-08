import { Module } from '@nestjs/common';

import { JournalsModule } from '../journals/journals.module';
import { BookingCommissionController } from './controllers/booking-commission.controller';
import { BookingCommissionRecognizerService } from './services/booking-commission-recognizer.service';

/**
 * Booking commission module (TS-083, PDD §9.2 + Appendix A).
 *
 * Composition:
 *   - `BookingCommissionRecognizerService` — receiver-side of the
 *     `booking.completed` event. Posts the four-line journal (DR
 *     Cash / CR Marketplace Revenue gross + DR Marketplace Revenue
 *     Contra / CR Provider Payable) AND upserts the per-provider
 *     `provider_payable_balances` running balance in one
 *     orchestrated flow.
 *   - `BookingCommissionController` — two HTTP surfaces:
 *     POST /api/v1/internal/booking/completed (shared-secret pinned,
 *     idempotent) and GET /api/v1/admin/providers/:providerId/payable-
 *     balance (AccessTokenGuard).
 *
 * Imports `JournalsModule` to inject the `JournalPostingService` —
 * the booking-completion flow posts journals through the shared
 * posting service so the double-entry invariant + the source-
 * event-id UNIQUE idempotency + the accounting-period gate ALL apply
 * uniformly. The recognizer NEVER bypasses the posting service.
 *
 * Exports `BookingCommissionRecognizerService` so TS-084 (refund +
 * contra-revenue handling) and TS-090/091 (payouts) can compose the
 * payable-balance read path + the journal-reversal flow without re-
 * importing the booking-commission module shape.
 */
@Module({
  imports: [JournalsModule],
  controllers: [BookingCommissionController],
  providers: [BookingCommissionRecognizerService],
  exports: [BookingCommissionRecognizerService],
})
export class BookingCommissionModule {}
