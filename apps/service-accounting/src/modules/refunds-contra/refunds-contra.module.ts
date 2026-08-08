import { Module } from '@nestjs/common';

import { JournalsModule } from '../journals/journals.module';
import { RevenueRecognitionModule } from '../revenue-recognition/revenue-recognition.module';
import { RefundsContraController } from './controllers/refunds-contra.controller';
import { CouponContraRevenueService } from './services/coupon-contra-revenue.service';
import { RefundService } from './services/refund.service';

/**
 * Refunds + contra-revenue module (TS-084, PDD §11.2 + Appendix A,
 * CLAUDE.md §6).
 *
 * Composition:
 *   - `CouponContraRevenueService` — receiver-side of the
 *     `coupon.redeemed` event. Posts the two-line contra-revenue
 *     journal (DR 4510 Coupon Discount / CR 4000.{planCode}). Closes
 *     TS-043-followup-11.
 *   - `RefundService` — receiver-side of subscription + booking
 *     refunds. Posts the literal PDD Appendix A entries
 *     (DR 4000.{planCode}/CR 1000 for subscription; reversal of the
 *     booking-completion four-line shape for booking) AND decrements
 *     the per-provider running payable balance (may go negative —
 *     clawback). Closes TS-082-followup-9 (subscription) and
 *     TS-083-followup-10 (booking).
 *   - `RefundsContraController` — three internal HTTP surfaces
 *     (POST /api/v1/internal/coupon/redeemed,
 *     POST /api/v1/internal/subscription/refunded,
 *     POST /api/v1/internal/booking/refunded). All shared-secret
 *     pinned, all idempotent.
 *
 * **Imports.** `JournalsModule` for `JournalPostingService` (the
 * single posting path). `RevenueRecognitionModule` exports
 * `PlanAccountResolverService` — the deferred + revenue account
 * resolver shared with the subscription-revenue recognizer. Reusing
 * the resolver keeps the `4000.{planCode}` convention in one place
 * across both flows.
 *
 * **Exports.** `CouponContraRevenueService` + `RefundService` are
 * exported so the eventual outbox-relay consumer (TS-142, TS-084-
 * followup that migrates the synchronous HTTP scaffold) can wire
 * directly to them without re-importing the module shape. Mirrors
 * the BookingCommissionModule's export-the-recognizer pattern.
 */
@Module({
  imports: [JournalsModule, RevenueRecognitionModule],
  controllers: [RefundsContraController],
  providers: [CouponContraRevenueService, RefundService],
  exports: [CouponContraRevenueService, RefundService],
})
export class RefundsContraModule {}
