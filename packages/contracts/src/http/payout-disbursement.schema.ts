import { z } from 'zod';

import {
  PAYOUT_PROVIDER_ID_MAX_LENGTH,
  PAYOUT_STRIPE_ACCOUNT_ID_MAX_LENGTH,
} from './payouts.schema';

/**
 * Payout disbursement HTTP DTOs (TS-091; PDD §11.3 provider payouts).
 *
 * Scope: the post-onboarding side of the payouts surface — actually
 * moving money from the platform's Stripe balance to a provider's
 * connected Express account.
 *
 *   1. **Sweep run** — the operator-triggered (or scheduler-triggered)
 *      "process today's payable balances" entry point. Walks the active
 *      payout accounts whose balances clear the threshold AND whose
 *      most-recent booking-completion is past the T+2 hold window,
 *      schedules one disbursement per qualifying provider.
 *
 *   2. **Manual disbursement** — admin endpoint to force a per-provider
 *      disbursement outside the daily sweep (refund hold release, ops
 *      makegood, etc.).
 *
 *   3. **Transfer-event ingest** — Stripe `transfer.paid` /
 *      `transfer.failed` webhook hand-off. Idempotent on Stripe event
 *      id; flips the local disbursement row's status + triggers the
 *      DR Provider Payable / CR Cash journal posting in service-
 *      accounting (TS-083-followup-9 closes the loop).
 *
 *   4. **History reads** — provider self-service + admin queries.
 *
 * **Stripe Transfer SDK is stub-mode in Phase 1**: when the live secret
 * isn't configured (or the explicit stub sentinel is set), the service
 * mints deterministic `tr_stub_<disbursementId>` transfer ids. Live SDK
 * wiring lands as TS-091-followup-1.
 *
 * **`.strict()` everywhere** — typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/** Disbursement surrogate id (cuid2 — 24 chars is the standard cap). */
export const DISBURSEMENT_ID_MAX_LENGTH = 64;

/**
 * Stripe Transfer ids are `tr_` + 16+ random base58 chars
 * (`tr_1NfXyZAbCd012345`). 64 is a defensive cap.
 */
export const DISBURSEMENT_STRIPE_TRANSFER_ID_MAX_LENGTH = 64;

/** Stripe `evt_*` id for the transfer-event ingest. */
export const DISBURSEMENT_STRIPE_EVENT_ID_MAX_LENGTH = 128;

/**
 * Service-managed idempotency key on the disbursement row. Disbursements
 * scheduled by the daily sweep use `sweep:<asOfDate>:<providerId>`;
 * admin-triggered disbursements use a caller-supplied opaque token.
 */
export const DISBURSEMENT_IDEMPOTENCY_KEY_MIN_LENGTH = 1;
export const DISBURSEMENT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * Cross-service source-event id — surfaces the disbursement id (or a
 * sibling identifier) into the accounting service's journal-posting
 * idempotency key.
 */
export const DISBURSEMENT_SOURCE_EVENT_ID_MAX_LENGTH = 200;

/**
 * Free-text failure reason from Stripe (e.g. `account_closed`,
 * `insufficient_funds`). Capped defensively.
 */
export const DISBURSEMENT_FAILURE_REASON_MAX_LENGTH = 500;

/** Free-text memo / note carried alongside a manual disbursement. */
export const DISBURSEMENT_MEMO_MAX_LENGTH = 500;

/** Amount cap — defensive (a billion dollars in minor units). */
export const DISBURSEMENT_AMOUNT_MINOR_MAX = 100_000_000_000;

/** Cursor pagination caps for admin / provider history list endpoints. */
export const DISBURSEMENT_LIST_LIMIT_DEFAULT = 50;
export const DISBURSEMENT_LIST_LIMIT_MAX = 200;

/** Hold-window cap. Phase 1 default is 2 (T+2); admin may override per run. */
export const DISBURSEMENT_HOLD_DAYS_MIN = 0;
export const DISBURSEMENT_HOLD_DAYS_MAX = 30;

/** Sweep `providerIds` filter cap (defensive against pathological input). */
export const DISBURSEMENT_SWEEP_PROVIDER_FILTER_MAX = 200;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Disbursement lifecycle status.
 *
 *   - `pending` — row created by the scheduler / admin; Stripe Transfer
 *     not yet attempted (or attempt deferred to the next worker pass).
 *
 *   - `in_transit` — Stripe accepted the Transfer call and assigned a
 *     `tr_*` id. Awaiting `transfer.paid` / `transfer.failed`.
 *
 *   - `paid` — Stripe confirmed the funds reached the connected
 *     account. Triggers the DR Provider Payable / CR Cash journal in
 *     service-accounting (TS-091-followup-3).
 *
 *   - `failed` — Stripe rejected the Transfer (account closed,
 *     insufficient platform balance, etc.). Manual retry required.
 *
 *   - `canceled` — operator-issued cancellation BEFORE Stripe accepted.
 *     Once Stripe accepts a transfer (`in_transit`), Stripe's own
 *     cancellation API is the path forward; we don't expose that today.
 */
export const PayoutDisbursementStatusSchema = z.enum([
  'pending',
  'in_transit',
  'paid',
  'failed',
  'canceled',
]);
export type PayoutDisbursementStatus = z.infer<typeof PayoutDisbursementStatusSchema>;

/**
 * Transfer-event outcome reported by Stripe (or by the operator on a
 * manual mark). Mirrors the disbursement-status flip the event causes:
 *
 *   - `paid` — Stripe `transfer.paid`. Disbursement → `paid`.
 *   - `failed` — Stripe `transfer.failed`. Disbursement → `failed`.
 */
export const PayoutTransferEventOutcomeSchema = z.enum(['paid', 'failed']);
export type PayoutTransferEventOutcome = z.infer<typeof PayoutTransferEventOutcomeSchema>;

// ─── Re-used field schemas ──────────────────────────────────────────────

const ProviderIdSchema = z.string().min(1).max(PAYOUT_PROVIDER_ID_MAX_LENGTH);

/**
 * Phase 1 is USD-only (PRD §11.4). Schema is generic so a Phase 3
 * multi-currency expansion is a contract-additive change.
 */
const CurrencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code (upper-case)');

const AmountMinorSchema = z
  .number()
  .int('amountMinor must be an integer')
  .positive('amountMinor must be > 0')
  .max(DISBURSEMENT_AMOUNT_MINOR_MAX);

const IdempotencyKeySchema = z
  .string()
  .min(DISBURSEMENT_IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(DISBURSEMENT_IDEMPOTENCY_KEY_MAX_LENGTH);

const SourceEventIdSchema = z.string().min(1).max(DISBURSEMENT_SOURCE_EVENT_ID_MAX_LENGTH);

/**
 * `YYYY-MM-DD` calendar date in the platform's accounting time zone
 * (UTC for Phase 1; PRD §11.4 multi-region considerations land in
 * Phase 3). Used for the sweep `asOfDate` plus the disbursement
 * `scheduledFor` date.
 */
const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD calendar date');

// ─── Request schemas ────────────────────────────────────────────────────

/**
 * Run the daily disbursement sweep.
 *
 *   - `asOfDate` is the calendar date the sweep evaluates against
 *     (typically "today" in UTC). Disbursements are scheduled for this
 *     date; the T+2 hold-window check measures from this date back.
 *
 *   - `holdDays` overrides the default `PAYOUT_HOLD_DAYS` env config
 *     for a single run. Useful for ops to flush a backlog (`holdDays:
 *     0`) or to extend the hold for a fraud-suspect window.
 *
 *   - `providerIds` — optional allow-list. When provided, the sweep
 *     restricts to these providers (ops makegood). Absent → walk every
 *     active payout account.
 *
 *   - `dryRun` — when true, the sweep computes what it WOULD schedule
 *     and returns the summary without creating disbursement rows.
 *     Read-only.
 *
 *   - `minAmountMinor` — override the `PAYOUT_MIN_AMOUNT_MINOR` floor
 *     for a single run.
 */
export const RunDisbursementSweepRequestSchema = z
  .object({
    asOfDate: CalendarDateSchema,
    holdDays: z
      .number()
      .int()
      .min(DISBURSEMENT_HOLD_DAYS_MIN)
      .max(DISBURSEMENT_HOLD_DAYS_MAX)
      .optional(),
    providerIds: z.array(ProviderIdSchema).max(DISBURSEMENT_SWEEP_PROVIDER_FILTER_MAX).optional(),
    dryRun: z.boolean().optional().default(false),
    minAmountMinor: AmountMinorSchema.optional(),
  })
  .strict();
export type RunDisbursementSweepRequest = z.infer<typeof RunDisbursementSweepRequestSchema>;

/**
 * Admin manual disbursement trigger.
 *
 *   - `providerId` — the target provider.
 *   - `amountMinor` — explicit amount the operator wants to disburse
 *     (commonly the provider's full payable balance; staff may also
 *     issue partial disbursements during dispute hold).
 *   - `currency` — USD-only in Phase 1.
 *   - `idempotencyKey` — operator-supplied to prevent double-creates
 *     across retries (a typo'd `Authorize.net` browser back-button
 *     re-submit landed twice in prior platforms; the key prevents it).
 *   - `sourceEventId` — surfaces into the accounting service's journal-
 *     posting idempotency once TS-091-followup-3 wires the journal.
 *     Defaults server-side to `manual:<disbursementId>`.
 *   - `memo` — operator note for audit.
 *   - `scheduledFor` — calendar date the disbursement is associated
 *     with (typically today). Drives reporting + 1099 prep.
 */
export const SchedulePayoutDisbursementRequestSchema = z
  .object({
    providerId: ProviderIdSchema,
    amountMinor: AmountMinorSchema,
    currency: CurrencyCodeSchema,
    idempotencyKey: IdempotencyKeySchema,
    sourceEventId: SourceEventIdSchema.optional(),
    memo: z.string().min(1).max(DISBURSEMENT_MEMO_MAX_LENGTH).optional(),
    scheduledFor: CalendarDateSchema,
  })
  .strict();
export type SchedulePayoutDisbursementRequest = z.infer<
  typeof SchedulePayoutDisbursementRequestSchema
>;

/**
 * Internal: Stripe transfer-event ingest. service-webhook hands the
 * verified `transfer.paid` / `transfer.failed` event off here. The
 * stripeTransferId is the join key against the local row; the outcome
 * + occurredAt drive the status flip.
 *
 * Idempotent on `stripeEventId`. A failure can later flip to paid via
 * an operator-issued retry that mints a NEW transfer (and a new
 * disbursement row) — we never mutate paid → anything.
 */
export const IngestPayoutTransferEventRequestSchema = z
  .object({
    stripeEventId: z.string().min(1).max(DISBURSEMENT_STRIPE_EVENT_ID_MAX_LENGTH),
    eventType: z.string().min(1).max(80),
    stripeTransferId: z.string().min(1).max(DISBURSEMENT_STRIPE_TRANSFER_ID_MAX_LENGTH),
    outcome: PayoutTransferEventOutcomeSchema,
    occurredAt: z.string().datetime({ offset: true }),
    failureReason: z.string().min(1).max(DISBURSEMENT_FAILURE_REASON_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === 'failed' && value.failureReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureReason'],
        message: 'failureReason is required when outcome is "failed"',
      });
    }
  });
export type IngestPayoutTransferEventRequest = z.infer<
  typeof IngestPayoutTransferEventRequestSchema
>;

// ─── Response schemas ───────────────────────────────────────────────────

/**
 * Outwards-facing disbursement row. Visible to:
 *   - the provider via `GET /api/v1/payouts/me/disbursements`
 *   - admin via `GET /api/v1/admin/payouts/disbursements`
 *
 * The `stripeTransferId` is intentionally returned to the provider —
 * Stripe surfaces the same id in the Express dashboard, so the provider
 * can cross-reference. We never expose the raw Stripe error payload.
 */
export const PayoutDisbursementResponseSchema = z
  .object({
    id: z.string().min(1).max(DISBURSEMENT_ID_MAX_LENGTH),
    providerId: ProviderIdSchema,
    stripeAccountId: z.string().min(1).max(PAYOUT_STRIPE_ACCOUNT_ID_MAX_LENGTH),
    stripeTransferId: z.string().min(1).max(DISBURSEMENT_STRIPE_TRANSFER_ID_MAX_LENGTH).nullable(),
    currency: CurrencyCodeSchema,
    amountMinor: z.number().int().nonnegative(),
    status: PayoutDisbursementStatusSchema,
    idempotencyKey: IdempotencyKeySchema,
    sourceEventId: SourceEventIdSchema,
    scheduledFor: CalendarDateSchema,
    heldUntil: z.string().datetime({ offset: true }),
    initiatedAt: z.string().datetime({ offset: true }).nullable(),
    paidAt: z.string().datetime({ offset: true }).nullable(),
    failedAt: z.string().datetime({ offset: true }).nullable(),
    failureReason: z.string().max(DISBURSEMENT_FAILURE_REASON_MAX_LENGTH).nullable(),
    memo: z.string().max(DISBURSEMENT_MEMO_MAX_LENGTH).nullable(),
    liveMode: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PayoutDisbursementResponse = z.infer<typeof PayoutDisbursementResponseSchema>;

/**
 * Response for the manual-scheduling endpoint. `outcome` distinguishes a
 * fresh create from an idempotent echo (the operator hit retry).
 */
export const SchedulePayoutDisbursementResponseSchema = z
  .object({
    outcome: z.enum(['created', 'existing']),
    disbursement: PayoutDisbursementResponseSchema,
  })
  .strict();
export type SchedulePayoutDisbursementResponse = z.infer<
  typeof SchedulePayoutDisbursementResponseSchema
>;

/**
 * Per-provider summary inside a sweep response. `scheduledDisbursementId`
 * is null when the provider was skipped (insufficient balance, hold
 * not cleared, no payable balance row, account inactive, etc.).
 */
export const PayoutSweepProviderSummarySchema = z
  .object({
    providerId: ProviderIdSchema,
    decision: z.enum([
      'scheduled',
      'idempotent_existing',
      'skipped_no_account',
      'skipped_account_not_active',
      'skipped_no_balance',
      'skipped_below_threshold',
      'skipped_hold_not_cleared',
      'skipped_dry_run',
    ]),
    amountMinor: z.number().int().nonnegative(),
    currency: CurrencyCodeSchema,
    scheduledDisbursementId: z.string().min(1).max(DISBURSEMENT_ID_MAX_LENGTH).nullable(),
  })
  .strict();
export type PayoutSweepProviderSummary = z.infer<typeof PayoutSweepProviderSummarySchema>;

/**
 * Response for `POST /api/v1/admin/payouts/sweeps`. Echoes the run
 * parameters alongside the per-provider decisions so the operator can
 * audit a single sweep run end-to-end.
 */
export const RunDisbursementSweepResponseSchema = z
  .object({
    asOfDate: CalendarDateSchema,
    holdDays: z.number().int().min(DISBURSEMENT_HOLD_DAYS_MIN).max(DISBURSEMENT_HOLD_DAYS_MAX),
    minAmountMinor: z.number().int().nonnegative(),
    dryRun: z.boolean(),
    consideredProviderCount: z.number().int().nonnegative(),
    scheduledCount: z.number().int().nonnegative(),
    idempotentExistingCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    totalScheduledAmountMinor: z.number().int().nonnegative(),
    currency: CurrencyCodeSchema,
    perProvider: z.array(PayoutSweepProviderSummarySchema),
  })
  .strict();
export type RunDisbursementSweepResponse = z.infer<typeof RunDisbursementSweepResponseSchema>;

/**
 * Response for the internal transfer-event ingest. `outcome` mirrors the
 * payouts service's three classifications.
 */
export const IngestPayoutTransferEventResponseSchema = z
  .object({
    outcome: z.enum(['applied', 'replayed', 'ignored']),
    disbursement: PayoutDisbursementResponseSchema.nullable(),
  })
  .strict();
export type IngestPayoutTransferEventResponse = z.infer<
  typeof IngestPayoutTransferEventResponseSchema
>;

// ─── List / query schemas ───────────────────────────────────────────────

/**
 * Admin: list disbursements with optional filters + cursor pagination.
 */
export const ListPayoutDisbursementsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(DISBURSEMENT_LIST_LIMIT_MAX)
      .default(DISBURSEMENT_LIST_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(256).optional(),
    providerId: ProviderIdSchema.optional(),
    status: PayoutDisbursementStatusSchema.optional(),
    scheduledOnOrAfter: CalendarDateSchema.optional(),
    scheduledOnOrBefore: CalendarDateSchema.optional(),
  })
  .strict();
export type ListPayoutDisbursementsQuery = z.infer<typeof ListPayoutDisbursementsQuerySchema>;

export const PayoutDisbursementsListResponseSchema = z
  .object({
    rows: z.array(PayoutDisbursementResponseSchema),
    nextCursor: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type PayoutDisbursementsListResponse = z.infer<typeof PayoutDisbursementsListResponseSchema>;

/**
 * Provider self-service: list MY disbursements. Same fields as the
 * admin list minus the `providerId` filter (it's always the caller).
 */
export const ListMyPayoutDisbursementsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(DISBURSEMENT_LIST_LIMIT_MAX)
      .default(DISBURSEMENT_LIST_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(256).optional(),
    status: PayoutDisbursementStatusSchema.optional(),
  })
  .strict();
export type ListMyPayoutDisbursementsQuery = z.infer<typeof ListMyPayoutDisbursementsQuerySchema>;
