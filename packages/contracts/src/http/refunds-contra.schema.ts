import { z } from 'zod';

import { AccountCurrencySchema } from './account.schema';
import {
  BOOKING_AMOUNT_MAX_MINOR,
  BOOKING_DESCRIPTION_MAX_LENGTH,
  BOOKING_ID_MAX_LENGTH,
  CommissionRateBpsSchema,
} from './booking-commission.schema';
import { JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH } from './journal.schema';
import { PlanCustomerGroupSchema } from './plan.schema';
import {
  PLAN_CODE_MAX_LENGTH,
  PlanCodeSchema,
  RECOGNITION_AMOUNT_MAX_MINOR,
  RECOGNITION_DESCRIPTION_MAX_LENGTH,
} from './subscription-revenue.schema';

/**
 * Refunds + contra-revenue contracts (TS-084, PDD §11.2, Appendix A,
 * CLAUDE.md §6).
 *
 * Three write surfaces ship in the receiver bounded context
 * (service-accounting). All are system-driven via the outbox relay
 * (TS-142; synchronous HTTP scaffold pre-relay):
 *
 *   - `POST /api/v1/internal/coupon/redeemed` — coupon contra-revenue.
 *     Posts `DR 4510 Coupon Discount / CR 4000.{planCode} Subscription
 *     Revenue` per PDD Appendix A: "Coupon $50 applied to invoice —
 *     DR Coupon Discount $50 / CR Subscription Revenue $50". Closes
 *     TS-043-followup-11.
 *
 *   - `POST /api/v1/internal/subscription/refunded` — subscription
 *     refund. Posts `DR 4000.{planCode} Subscription Revenue / CR 1000
 *     Cash` per PDD Appendix A: "Refund issued $99 — DR Subscription
 *     Revenue $99 / CR Cash $99". Matches the Appendix-A literal — the
 *     deferred-revenue cleanup for mid-period cancel-with-refund is a
 *     separate concern (captured as TS-084-followup). Closes TS-082-
 *     followup-9 at the journal layer; the deferred cleanup the
 *     follow-up names rides on a manual_adjustment for now.
 *
 *   - `POST /api/v1/internal/booking/refunded` — booking refund with
 *     provider clawback. Posts the two-leg reversal of the booking-
 *     completion journal: `DR 4100 Marketplace Revenue $refundAmount /
 *     CR 1000 Cash $refundAmount` AND `DR 2100 Provider Payable
 *     $providerPortion / CR 4500 Marketplace Revenue Contra
 *     $providerPortion`. ALSO decrements the per-provider
 *     `provider_payable_balances` running balance by
 *     `providerPortion` — the balance may legitimately go NEGATIVE
 *     when the refund arrives AFTER the provider has been paid out
 *     (clawback). Closes TS-083-followup-10.
 *
 * **Money discipline.** Amounts cross the wire as integer USD minor
 * units (cents) — CLAUDE.md §17.6, never floats. The service converts
 * to `Decimal` at the boundary; the database stores `Decimal(12, 2)`.
 *
 * **Idempotency.** Every request carries a `sourceEventId` that lands
 * on the resulting journal's `journals.source_event_id`. The DB-layer
 * UNIQUE constraint squashes at-least-once redelivery to exactly-once
 * posting (JournalPostingService refetches and replays the existing
 * journal on P2002). The controller's `@Idempotent()` decorator
 * surfaces the cached response on `Idempotency-Key` retries.
 *
 * **Why `kind: 'refund'` rather than `kind: 'reversal'` for refunds.**
 * `reversal` is reserved for the strict debit↔credit-swap reversal
 * pair pattern (`JournalPostingService.reverse`). A refund is a
 * business-domain event that may partially undo a prior journal — the
 * shape and the amount are caller-driven, not "swap every line of the
 * referenced journal." We keep `reversal` for the literal reversal
 * primitive and use `refund` for the customer-refund business event.
 *
 * **Why no contra-account for refunds (4520 stays seeded but unused).**
 * The user chose the PDD Appendix A literal shape. The seeded `4520
 * Refunds` contra-revenue account is preserved for future per-tier
 * refund breakdown analytics — switching to it later is a forward-
 * compatible change at the resolver layer (no contract churn).
 */

// ──────────────────────────────────────────────────────────────────────────
// Shared bounds — keep narrow so a malformed upstream is rejected at parse
// time before any journal post fires.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Cap on a refund amount (cents). Mirrors `RECOGNITION_AMOUNT_MAX_MINOR`
 * so a refund can never exceed the activation envelope, and the
 * resulting journal line stays inside the `Decimal(12, 2)` envelope.
 */
export const REFUND_AMOUNT_MAX_MINOR = RECOGNITION_AMOUNT_MAX_MINOR;
export const REFUND_DESCRIPTION_MAX_LENGTH = RECOGNITION_DESCRIPTION_MAX_LENGTH;

/**
 * Cap on a coupon discount amount (cents). A coupon discount is bounded
 * by the gross invoice amount, which is itself bounded by
 * `RECOGNITION_AMOUNT_MAX_MINOR`.
 */
export const COUPON_CONTRA_AMOUNT_MAX_MINOR = RECOGNITION_AMOUNT_MAX_MINOR;

// ──────────────────────────────────────────────────────────────────────────
// Apply coupon redemption — DR 4510 Coupon Discount / CR 4000.{planCode}
// ──────────────────────────────────────────────────────────────────────────

/**
 * Request body for `POST /api/v1/internal/coupon/redeemed`.
 *
 * Posts the contra-revenue entry against the discounted subscription's
 * revenue sub-account.
 *
 * **`couponRedemptionId`** is the upstream `coupon_redemptions.id`
 * from service-subscription's coupon module — a soft pointer carried
 * for audit context, NOT joined cross-schema.
 *
 * **`sourceEventId`** is unique at the journals layer — a redelivery
 * of the same coupon redemption event squashes to a single journal.
 */
export const ApplyCouponRedemptionRequestSchema = z
  .object({
    /**
     * Upstream coupon redemption id (`coupon_redemptions.id`). Carried
     * on the journal's `context` for ops drill-down.
     */
    couponRedemptionId: z.string().min(1).max(64),
    /**
     * Subscription whose invoice was discounted. Soft pointer into
     * `subscription.subscriptions.id`.
     */
    subscriptionId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
    customerGroup: PlanCustomerGroupSchema,
    /**
     * Plan code of the discounted subscription — resolves to the
     * matching revenue sub-account (`4000.{planCode}`) via
     * `PlanAccountResolverService`.
     */
    planCode: PlanCodeSchema,
    /**
     * Discount amount in minor units (the amount the coupon shaved
     * off the invoice).
     */
    discountAmountMinor: z.number().int().min(1).max(COUPON_CONTRA_AMOUNT_MAX_MINOR),
    currency: AccountCurrencySchema.default('USD'),
    occurredAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    description: z.string().min(1).max(REFUND_DESCRIPTION_MAX_LENGTH).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ApplyCouponRedemptionRequest = z.infer<typeof ApplyCouponRedemptionRequestSchema>;

/**
 * Response shape for the coupon-redeemed endpoint. The journal id is
 * surfaced so the caller can render a "discount applied" audit trail
 * without a second round-trip.
 */
export const ApplyCouponRedemptionResponseSchema = z
  .object({
    journalId: z.string().min(1).max(64),
    couponRedemptionId: z.string().min(1).max(64),
    subscriptionId: z.string().min(1).max(64),
    planCode: z.string().min(1).max(PLAN_CODE_MAX_LENGTH),
    discountAmountMinor: z.number().int().min(0),
    currency: AccountCurrencySchema,
    result: z.enum(['created', 'idempotent_replay']),
  })
  .strict();
export type ApplyCouponRedemptionResponse = z.infer<typeof ApplyCouponRedemptionResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Apply subscription refund — DR 4000.{planCode} / CR 1000
// ──────────────────────────────────────────────────────────────────────────

/**
 * Request body for `POST /api/v1/internal/subscription/refunded`.
 *
 * Posts the literal PDD Appendix A entry — reverses recognised
 * subscription revenue against cash. For partial refunds the caller
 * sets `refundAmountMinor` to the refund value (not the full
 * invoice).
 *
 * **Deferred-revenue cleanup is NOT part of this flow.** A mid-period
 * cancellation with refund leaves the deferred-revenue liability on
 * the books until a separate manual_adjustment clears it (or until
 * TS-084-followup ships the automated cleanup). Captured in the
 * service doc-comment.
 *
 * **`originalActivationJournalId`** is an optional back-pointer for
 * the journal context — lets the admin journal browser link the
 * refund to its originating activation without a separate join.
 */
export const ApplySubscriptionRefundRequestSchema = z
  .object({
    subscriptionId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
    customerGroup: PlanCustomerGroupSchema,
    /**
     * Plan code of the refunded subscription — resolves to the matching
     * revenue sub-account (`4000.{planCode}`) via
     * `PlanAccountResolverService`.
     */
    planCode: PlanCodeSchema,
    /**
     * Refund amount in minor units. May be less than the original
     * activation amount (partial refund).
     */
    refundAmountMinor: z.number().int().min(1).max(REFUND_AMOUNT_MAX_MINOR),
    currency: AccountCurrencySchema.default('USD'),
    occurredAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    /**
     * Optional back-pointer to the activation journal this refund
     * unwinds — carried on the resulting refund journal's `context`
     * for ops drill-down. Soft pointer, no FK.
     */
    originalActivationJournalId: z.string().min(1).max(64).optional(),
    description: z.string().min(1).max(REFUND_DESCRIPTION_MAX_LENGTH).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ApplySubscriptionRefundRequest = z.infer<typeof ApplySubscriptionRefundRequestSchema>;

export const ApplySubscriptionRefundResponseSchema = z
  .object({
    journalId: z.string().min(1).max(64),
    subscriptionId: z.string().min(1).max(64),
    planCode: z.string().min(1).max(PLAN_CODE_MAX_LENGTH),
    refundAmountMinor: z.number().int().min(0),
    currency: AccountCurrencySchema,
    result: z.enum(['created', 'idempotent_replay']),
  })
  .strict();
export type ApplySubscriptionRefundResponse = z.infer<typeof ApplySubscriptionRefundResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Apply booking refund — reverse the four-line booking-completion journal
// + decrement provider_payable_balances (may go negative — clawback)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Request body for `POST /api/v1/internal/booking/refunded`.
 *
 * **Invariant.** `refundAmount = providerPortion + marketplacePortion`
 * enforced at the schema layer (the two reversal legs must balance
 * the gross). For a partial refund the upstream service-booking is
 * the authority on the per-leg split — typically pro-rated by the
 * commission rate, but ops may override (e.g. full provider clawback
 * on a welfare-concern-flagged booking).
 *
 * **`providerPortion`** can be 0 (full-platform-retention promotional
 * refund where the platform eats the entire refund without clawing
 * back from the provider).
 *
 * **`marketplacePortion`** can be 0 (a refund where the platform
 * gives back its commission AND claws back the provider portion).
 *
 * **Clawback semantics.** The decrement to
 * `provider_payable_balances` may take the row negative. The DB has
 * NO CHECK constraint on `amount >= 0` (per the booking-commission
 * migration comment). A negative balance is the application-layer
 * signal to ops that the provider owes the platform the reclaimed
 * amount; the negative-balance ops queue lands as a TS-084-followup
 * once the surface materialises.
 *
 * **`originalBookingJournalId`** is an optional back-pointer to the
 * original booking-completion journal — surfaced on the refund
 * journal's `context` for admin drill-down.
 */
export const ApplyBookingRefundRequestSchema = z
  .object({
    bookingId: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    providerId: z.string().min(1).max(64),
    householdId: z.string().min(1).max(64),
    /**
     * Total refund amount (the customer-paid value being given back).
     */
    refundAmountMinor: z.number().int().min(1).max(BOOKING_AMOUNT_MAX_MINOR),
    /**
     * Portion of the refund clawed back from the provider's payable
     * balance.
     */
    providerPortionMinor: z.number().int().min(0).max(BOOKING_AMOUNT_MAX_MINOR),
    /**
     * Portion of the refund eaten by the platform (the commission
     * giveback).
     */
    marketplacePortionMinor: z.number().int().min(0).max(BOOKING_AMOUNT_MAX_MINOR),
    commissionRateBps: CommissionRateBpsSchema,
    currency: AccountCurrencySchema.default('USD'),
    occurredAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    /**
     * Optional back-pointer to the original booking-completion
     * journal. Soft pointer; surfaced on the refund journal's
     * `context` for ops drill-down.
     */
    originalBookingJournalId: z.string().min(1).max(64).optional(),
    description: z.string().min(1).max(BOOKING_DESCRIPTION_MAX_LENGTH).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.providerPortionMinor + body.marketplacePortionMinor !== body.refundAmountMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'refundAmount must equal providerPortion + marketplacePortion (the reversal legs cannot balance otherwise)',
        path: ['refundAmountMinor'],
      });
    }
  });
export type ApplyBookingRefundRequest = z.infer<typeof ApplyBookingRefundRequestSchema>;

/**
 * Response shape for the booking-refund endpoint.
 *
 * `runningPayableMinor` is the provider's `provider_payable_balances`
 * value AFTER the decrement (or the unchanged value on idempotent
 * replay). May be negative under the clawback flow — the
 * `z.number().int()` deliberately does NOT cap below at 0.
 */
export const ApplyBookingRefundResponseSchema = z
  .object({
    journalId: z.string().min(1).max(64),
    bookingId: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    providerId: z.string().min(1).max(64),
    refundAmountMinor: z.number().int().min(0),
    providerPortionMinor: z.number().int().min(0),
    marketplacePortionMinor: z.number().int().min(0),
    commissionRateBps: CommissionRateBpsSchema,
    currency: AccountCurrencySchema,
    /**
     * Provider's running payable balance AFTER decrement (may be
     * negative on clawback). Surfaced so the caller can render the
     * updated balance without a second round-trip.
     */
    runningPayableMinor: z.number().int(),
    result: z.enum(['created', 'idempotent_replay']),
  })
  .strict();
export type ApplyBookingRefundResponse = z.infer<typeof ApplyBookingRefundResponseSchema>;
