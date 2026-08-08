import { z } from 'zod';

import { AccountCurrencySchema } from './account.schema';
import { JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH } from './journal.schema';

/**
 * Booking commission contracts (TS-083, PDD §9.2, Appendix A).
 *
 * Three write surfaces ship in the receiver bounded context
 * (service-accounting):
 *
 *   - `POST /api/v1/internal/booking/completed` — system-driven by the
 *     outbox relay (TS-142; synchronous HTTP scaffold pre-relay called
 *     by service-booking once TS-060 ships). Posts the four-line
 *     booking-completion journal (DR Cash / CR Marketplace Revenue
 *     gross + DR Marketplace Revenue Contra / CR Provider Payable) AND
 *     upserts the per-provider `provider_payable_balances` running
 *     balance row in one transaction. Idempotent on `sourceEventId`.
 *
 *   - `GET /api/v1/admin/providers/:providerId/payable-balance` —
 *     finance / ops read of the provider's outstanding payable.
 *     Returns 404 when no booking has yet been completed for the
 *     provider (no row in `provider_payable_balances`).
 *
 * **Money discipline.** Amounts cross the wire as integer USD minor
 * units (cents) — CLAUDE.md §17.6. The recognizer converts to
 * `Decimal` at the boundary; the database stores `Decimal(12, 2)`.
 *
 * **Why a 4-line journal rather than 2.** PDD Appendix A spells out
 * the canonical booking-completion shape:
 *
 *     DR Cash                              $150
 *     CR Marketplace Revenue (gross)       $150
 *     DR Marketplace Revenue Contra        $120
 *     CR Provider Payable                  $120
 *
 * The "gross + contra" structure lets finance report GMV and net
 * marketplace revenue independently — gross hits the income
 * statement, the contra-revenue entry reclassifies the provider
 * portion onto the balance sheet (Provider Payable liability). The
 * platform's NET marketplace revenue per booking equals
 * `gross - providerPortion` = commission. A single-line "CR
 * Marketplace Revenue $30" would lose the GMV signal that drives
 * PRD §1.1 / §12 reporting.
 */

/**
 * Commission rate is expressed in basis points (1 bp = 0.01%) to keep
 * money math fixed-point at the wire layer. PRD §5.4 names three
 * tiers: 10% (Elite — 1000 bps), 20% (Certified — 2000 bps), 30%
 * (Basic — 3000 bps). The schema accepts 0–10000 bps (0–100%) so
 * promotional / partner-deal overrides land without contract churn.
 *
 * The recognizer does NOT compute the provider portion from rate ×
 * gross — the upstream service (service-booking) is the authority and
 * sends the resolved minor-unit amounts. The rate is carried for
 * audit / reporting only. The schema-level invariant is
 * `gross = provider + marketplace` (enforced by superRefine below);
 * the rate is a denormalised hint for finance reports.
 */
export const COMMISSION_RATE_BPS_MAX = 10_000;
export const CommissionRateBpsSchema = z.number().int().min(0).max(COMMISSION_RATE_BPS_MAX);
export type CommissionRateBps = z.infer<typeof CommissionRateBpsSchema>;

/**
 * Hard cap on a single booking's gross amount (cents). Matches the
 * `JOURNAL_LINE_MAX_AMOUNT_MINOR` cap so a booking cannot post a line
 * exceeding the `Decimal(12, 2)` envelope. A booking exceeding ~$99M
 * is operationally impossible at Phase-1 scale; a malformed input is
 * rejected here.
 */
export const BOOKING_AMOUNT_MAX_MINOR = 9_999_999_999;
export const BOOKING_DESCRIPTION_MAX_LENGTH = 500;
export const BOOKING_MEMO_MAX_LENGTH = 500;
export const BOOKING_ID_MAX_LENGTH = 64;

/**
 * Request body for `POST /api/v1/internal/booking/completed`.
 *
 * The recognizer trusts the upstream service-booking to have resolved
 * `provider`, `marketplace`, and `gross` to their final minor-unit
 * values — the schema enforces the sum invariant
 * (`gross === provider + marketplace`) at parse time so a malformed
 * upstream produces a 422 before reaching the journal layer.
 *
 * `sourceEventId` is unique at the `journals.source_event_id` layer —
 * a redelivery of the same booking completion event squashes to the
 * same journal AND the same `provider_payable_balances` increment
 * (idempotency at the service layer makes the balance upsert a no-op
 * on replay).
 */
export const BookingCommissionRequestSchema = z
  .object({
    bookingId: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    providerId: z.string().min(1).max(64),
    householdId: z.string().min(1).max(64),
    /**
     * Customer-paid gross amount (PDD Appendix A: "$150"). Lands as
     * DR Cash / CR Marketplace Revenue (gross) in the journal.
     */
    grossAmountMinor: z.number().int().min(1).max(BOOKING_AMOUNT_MAX_MINOR),
    /**
     * Provider portion of the gross (PDD Appendix A: "$120"). Lands
     * as DR Marketplace Revenue Contra / CR Provider Payable AND
     * increments the running balance.
     */
    providerAmountMinor: z.number().int().min(0).max(BOOKING_AMOUNT_MAX_MINOR),
    /**
     * Platform-retained portion of the gross (PDD Appendix A: "$30" —
     * the 20% commission on $150). The schema requires the upstream
     * to pre-compute this rather than implying
     * `marketplace = gross - provider` so a malformed upstream is
     * detected via the explicit sum invariant.
     */
    marketplaceAmountMinor: z.number().int().min(0).max(BOOKING_AMOUNT_MAX_MINOR),
    commissionRateBps: CommissionRateBpsSchema,
    currency: AccountCurrencySchema.default('USD'),
    completedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    description: z.string().min(1).max(BOOKING_DESCRIPTION_MAX_LENGTH).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.providerAmountMinor + body.marketplaceAmountMinor !== body.grossAmountMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'gross must equal provider + marketplace (the four-line journal balances exactly when this invariant holds)',
        path: ['grossAmountMinor'],
      });
    }
  });
export type BookingCommissionRequest = z.infer<typeof BookingCommissionRequestSchema>;

/**
 * Response shape for the booking-completion endpoint.
 *
 * `result` distinguishes a fresh post from an idempotent replay so
 * the caller can choose whether to retry-suppress or log.
 *
 * `runningPayableMinor` is the provider's `provider_payable_balances`
 * balance AFTER this completion was applied (or the unchanged balance
 * on a replay). Surfaced so the caller can render the updated payable
 * without a second round-trip.
 */
export const BookingCommissionResponseSchema = z
  .object({
    journalId: z.string().min(1).max(64),
    bookingId: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    providerId: z.string().min(1).max(64),
    grossAmountMinor: z.number().int().min(0),
    providerAmountMinor: z.number().int().min(0),
    marketplaceAmountMinor: z.number().int().min(0),
    commissionRateBps: CommissionRateBpsSchema,
    currency: AccountCurrencySchema,
    runningPayableMinor: z.number().int(),
    result: z.enum(['created', 'idempotent_replay']),
  })
  .strict();
export type BookingCommissionResponse = z.infer<typeof BookingCommissionResponseSchema>;

/**
 * Response shape for
 * `GET /api/v1/admin/providers/:providerId/payable-balance`.
 *
 * Surfaces the current running balance + the timestamp of the most
 * recent mutation so ops can detect a stale-balance scenario.
 * `amountMinor` may be negative under the TS-084 refund-after-payout
 * clawback flow — the `z.number().int()` deliberately does NOT cap
 * below at 0.
 */
export const ProviderPayableBalanceResponseSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    currency: AccountCurrencySchema,
    amountMinor: z.number().int(),
    lastUpdatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderPayableBalanceResponse = z.infer<typeof ProviderPayableBalanceResponseSchema>;
