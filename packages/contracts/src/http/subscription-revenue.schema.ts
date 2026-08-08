import { z } from 'zod';

import { AccountCurrencySchema } from './account.schema';
import { JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH } from './journal.schema';
import { PlanCustomerGroupSchema } from './plan.schema';

/**
 * Subscription revenue recognition contracts (TS-082, PDD §11.2,
 * Appendix A).
 *
 * Three write surfaces:
 *
 *   - `POST /api/v1/internal/subscription/activated` — system-driven by
 *     the outbox relay (TS-142; synchronous HTTP scaffold pre-relay
 *     called by service-subscription). Posts the activation journal
 *     (DR Cash / CR Deferred Revenue per-plan) AND creates the
 *     `deferred_revenue_balances` row in a single transaction.
 *     Idempotent on `sourceEventId` — at-least-once redelivery
 *     squashes to a single balance row + a single journal.
 *
 *   - `POST /api/v1/internal/subscription/canceled` — system-driven
 *     halt of recognition. Marks the balance as `canceled`; the
 *     remaining deferred amount stays on the books until TS-084 ships
 *     refund / write-off handling.
 *
 *   - `POST /api/v1/admin/subscription/recognize-daily` — admin
 *     trigger for the daily-recognition sweep. The BullMQ scheduled
 *     worker landing under TS-142 follow-ups will call the same
 *     service method; this endpoint is the manual / staging hook.
 *
 * **Money discipline.** Amounts cross the wire as integer USD minor
 * units (cents) — CLAUDE.md §17.6, never floats. The service converts
 * to `Decimal` at the boundary; the database stores `Decimal(12, 2)`.
 *
 * **Service period.** `servicePeriodStart` / `servicePeriodEnd` are
 * ISO-8601 datetimes. The recognizer treats the period as continuous
 * time — daily sweeps compute the elapsed fraction `(asOf -
 * periodStart) / (periodEnd - periodStart)` and round expected
 * cumulative recognised to the cent. The final-day sweep (when asOf
 * >= periodEnd) zeroes out the remaining deferred regardless of
 * rounding leftover.
 */

/**
 * Lifecycle status of a deferred-revenue balance. Mirrors
 * `accounting.deferred_revenue_status` 1:1.
 *
 * - `active`            — recognition is in flight.
 * - `fully_recognized`  — `recognizedAmount` reached `originalAmount`.
 * - `canceled`          — recognition halted prior to full
 *                         amortisation (subscription canceled).
 * - `paused`            — recognition SUSPENDED and expected to resume
 *                         (TS-042-followup-3b2). Distinct from
 *                         `canceled`, which is terminal-until-TS-084;
 *                         a paused balance's amortisation will
 *                         complete, just later, because resume extends
 *                         the service period by the suspended duration.
 *
 * Additive evolution — a value was appended, none repurposed
 * (CLAUDE.md §5.3). The activation + cancel responses can both surface
 * it: an activation redelivered after a pause replays the (now paused)
 * balance, and cancelling a paused subscription reports `paused` as
 * `previousStatus`.
 */
export const DeferredRevenueStatusSchema = z.enum([
  'active',
  'fully_recognized',
  'canceled',
  'paused',
]);
export type DeferredRevenueStatus = z.infer<typeof DeferredRevenueStatusSchema>;

/**
 * Plan-code shape: lower-case dot-notation matching
 * `subscription.plans.code` (e.g. `family.tier1`, `provider.elite`).
 * The recognizer resolves this to deferred + revenue chart-of-account
 * codes via `PlanAccountResolverService` (prefix-and-append:
 * `2000.{code}` / `4000.{code}`).
 *
 * Kept narrower than `AccountCodeSchema` — accounting codes can be
 * bare four-digit (`1000`); plan codes always carry the
 * `customerGroup.tier` shape.
 */
export const PLAN_CODE_MAX_LENGTH = 64;
export const PLAN_CODE_REGEX = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
export const PlanCodeSchema = z
  .string()
  .regex(PLAN_CODE_REGEX, 'plan code must be lower-case dot-notation (e.g. "family.tier1")')
  .max(PLAN_CODE_MAX_LENGTH);
export type PlanCode = z.infer<typeof PlanCodeSchema>;

/**
 * Cap on the activation amount the wire accepts (cents). Mirrors the
 * `JOURNAL_LINE_MAX_AMOUNT_MINOR` cap so an activation cannot post a
 * line exceeding the `Decimal(12, 2)` envelope.
 */
export const RECOGNITION_AMOUNT_MAX_MINOR = 9_999_999_999;
export const RECOGNITION_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Request body for `POST /api/v1/internal/subscription/activated`.
 *
 * **Idempotency.** `sourceEventId` is unique at the
 * `deferred_revenue_balances.source_event_id` AND at the
 * `journals.source_event_id` layer — a redelivery of the same
 * activation event squashes to the same balance row + same
 * activation journal.
 *
 * **`servicePeriodStart` < `servicePeriodEnd`** is enforced at the
 * schema layer (superRefine) so a malformed period is rejected at
 * parse time.
 */
export const RecognizeActivationRequestSchema = z
  .object({
    subscriptionId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
    customerGroup: PlanCustomerGroupSchema,
    planCode: PlanCodeSchema,
    amountMinor: z.number().int().min(1).max(RECOGNITION_AMOUNT_MAX_MINOR),
    currency: AccountCurrencySchema.default('USD'),
    servicePeriodStart: z.string().datetime(),
    servicePeriodEnd: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    occurredAt: z.string().datetime(),
    description: z.string().min(1).max(RECOGNITION_DESCRIPTION_MAX_LENGTH).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const start = Date.parse(body.servicePeriodStart);
    const end = Date.parse(body.servicePeriodEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'servicePeriodStart must be strictly before servicePeriodEnd',
        path: ['servicePeriodEnd'],
      });
    }
  });
export type RecognizeActivationRequest = z.infer<typeof RecognizeActivationRequestSchema>;

/**
 * Response shape for the activation endpoint.
 *
 * `status` distinguishes a fresh insert from an idempotent replay so
 * the caller can choose whether to log + retry-suppress.
 */
export const RecognizeActivationResponseSchema = z
  .object({
    balanceId: z.string().min(1).max(64),
    subscriptionId: z.string().min(1).max(64),
    activationJournalId: z.string().min(1).max(64),
    originalAmountMinor: z.number().int().min(0),
    recognizedAmountMinor: z.number().int().min(0),
    currency: AccountCurrencySchema,
    servicePeriodStart: z.string().datetime(),
    servicePeriodEnd: z.string().datetime(),
    status: DeferredRevenueStatusSchema,
    result: z.enum(['created', 'idempotent_replay']),
  })
  .strict();
export type RecognizeActivationResponse = z.infer<typeof RecognizeActivationResponseSchema>;

/**
 * Request body for `POST /api/v1/internal/subscription/canceled`.
 *
 * Marks the balance as `canceled`; the remaining deferred amount
 * stays on the books until TS-084 ships refund handling. The
 * `(subscriptionId, servicePeriodStart)` composite uniquely
 * identifies the affected balance (a subscription can have multiple
 * historical period rows).
 */
export const CancelDeferredRevenueRequestSchema = z
  .object({
    subscriptionId: z.string().min(1).max(64),
    servicePeriodStart: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    occurredAt: z.string().datetime(),
    reason: z.string().min(1).max(RECOGNITION_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();
export type CancelDeferredRevenueRequest = z.infer<typeof CancelDeferredRevenueRequestSchema>;

/**
 * Response shape for the cancel endpoint.
 *
 * `previousStatus` captures the pre-mutation state so the caller can
 * detect "I tried to cancel an already-canceled balance" without
 * relying on the `result` discriminator alone.
 */
export const CancelDeferredRevenueResponseSchema = z
  .object({
    balanceId: z.string().min(1).max(64),
    subscriptionId: z.string().min(1).max(64),
    previousStatus: DeferredRevenueStatusSchema,
    status: DeferredRevenueStatusSchema,
    remainingDeferredMinor: z.number().int().min(0),
    result: z.enum(['canceled', 'idempotent_replay']),
  })
  .strict();
export type CancelDeferredRevenueResponse = z.infer<typeof CancelDeferredRevenueResponseSchema>;

/**
 * Request body for `POST /api/v1/admin/subscription/recognize-daily`.
 *
 * `asOf` defaults to "now" on the server. Useful for ops / testing /
 * back-fills against a fixed point in time (e.g. running the sweep
 * for 2026-05-15 to recover from a missed cron tick).
 */
export const RecognizeDailyRequestSchema = z
  .object({
    asOf: z.string().datetime().optional(),
  })
  .strict();
export type RecognizeDailyRequest = z.infer<typeof RecognizeDailyRequestSchema>;

/**
 * Response shape for the daily-sweep endpoint.
 *
 * Captures per-outcome counts so the admin UI + observability layer
 * can render the sweep result. The journals + balance ids touched in
 * this sweep are NOT included in the response — at scale that's a
 * large array; the admin journal browser (TS-081-followup-7) is the
 * canonical way to inspect what landed.
 */
export const RecognizeDailyReportSchema = z
  .object({
    asOf: z.string().datetime(),
    scannedCount: z.number().int().min(0),
    recognizedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
    completedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    totalRecognizedMinor: z.number().int().min(0),
  })
  .strict();
export type RecognizeDailyReport = z.infer<typeof RecognizeDailyReportSchema>;
