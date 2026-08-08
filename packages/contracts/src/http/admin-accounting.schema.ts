import { z } from 'zod';

import { AccountCodeSchema, AccountTypeSchema, AccountNormalBalanceSchema } from './account.schema';
import {
  JournalKindSchema,
  JOURNAL_DESCRIPTION_MAX_LENGTH,
  JOURNAL_LINES_MAX,
  JOURNAL_LINES_MIN,
  JOURNAL_MEMO_MAX_LENGTH,
  JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH,
} from './journal.schema';
import {
  PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH,
  PERIOD_LIFECYCLE_REASON_MAX_LENGTH,
  PeriodLifecycleEventKindSchema,
  PeriodNameSchema,
} from './accounting-period.schema';
import { PlanCustomerGroupSchema } from './plan.schema';
import { PlanCodeSchema } from './subscription-revenue.schema';

/**
 * Admin accounting view HTTP DTOs (TS-129 Slice 1; PRD §10.8, PDD §11.2).
 *
 * Three read-only admin surfaces:
 *
 *   - `GET /api/v1/admin/journals?periodId=&periodName=&kind=&cursor=&limit=`
 *     Cursor-paginated browser over the journals table. Returns a
 *     denormalised summary per row (kind, dated as-of, source event id,
 *     period name, integer minor-unit totals over the embedded lines,
 *     posted-by-user-id, reversal pointers).
 *
 *   - `GET /api/v1/admin/journals/:id`
 *     Full journal detail view. Carries the envelope row plus the
 *     individual journal lines (capped at `JOURNAL_LINES_MAX`),
 *     denormalised account code/name per line, integer minor-unit
 *     debit/credit per line, and the free-form `context` jsonb payload.
 *
 *   - `GET /api/v1/admin/trial-balance?periodId=&periodName=&currency=`
 *     Per-account aggregate of debits / credits / net balance. Optional
 *     period scope (one of periodId / periodName; default = all-time).
 *     Filter by currency (Phase 1: USD only). Returns one row per
 *     active account, plus footer totals — by construction
 *     `totalDebitMinor == totalCreditMinor` for a balanced ledger.
 *
 *   - `GET /api/v1/admin/periods/:periodName/events?cursor=&limit=`
 *     Cursor-paginated per-period lifecycle audit (close / reopen).
 *     Closes TS-085-followup-7.
 *
 * **Slice 1 scope.** Read-only. PRD §10.8 covers a much larger surface
 * (full SaaS metrics, period-close UI, multi-currency, Stripe
 * reconciliation, NetSuite/QuickBooks exports, audit drill-down) — all
 * deferred to TS-129-followup tasks per the established TS-126 / TS-127
 * / TS-128 slicing pattern.
 *
 * **Authorisation.** The downstream service-accounting endpoints are
 * gated by the same `SuperAdminRoleGuard` pattern used by TS-126 /
 * TS-127 / TS-128 (4th consumer — triggers TS-052-followup-11 lift to
 * `packages/nest-auth`). The api-gateway proxy enforces the gate at the
 * edge for defence-in-depth. Future per-permission gating
 * (`accounting:read` for ops + finance + auditor; `accounting:adjust`
 * for finance-only mutations) lands with TS-129-followup-N.
 *
 * **Audit.** Admin reads do NOT emit audit events in Slice 1 — only
 * mutations do, and Slice 1 is read-only.
 *
 * **Money fields.** Integer USD minor units (`debitMinor`,
 * `creditMinor`, `totalDebitMinor`, `totalCreditMinor`, `netDebitMinor`,
 * `netCreditMinor`) per CLAUDE.md §17.6 — no floats over the wire.
 * Mirrors `JournalResponseSchema`'s shape for the columns it shares.
 *
 * **`.strict()`** everywhere — unknown fields are a parse error so a
 * typo or stray field never silently round-trips.
 */

/**
 * Cursor max length. Opaque to the consumer; the service emits a
 * base64url-encoded `(occurredAt-ISO, id)` pair. 256 bytes is well past
 * the maximum encoded size; the cap exists to bound query-string
 * abuse, not to constrain the cursor format. Mirrors
 * `ADMIN_BOOKINGS_LIST_CURSOR_MAX_LENGTH`.
 */
export const ADMIN_ACCOUNTING_LIST_CURSOR_MAX_LENGTH = 256;

/** Default page size for `GET /api/v1/admin/journals`. */
export const ADMIN_JOURNALS_LIST_LIMIT_DEFAULT = 25;

/** Maximum page size for `GET /api/v1/admin/journals`. */
export const ADMIN_JOURNALS_LIST_LIMIT_MAX = 100;

/** Default page size for `GET /api/v1/admin/periods/:periodName/events`. */
export const ADMIN_PERIOD_EVENTS_LIST_LIMIT_DEFAULT = 25;

/** Maximum page size for `GET /api/v1/admin/periods/:periodName/events`. */
export const ADMIN_PERIOD_EVENTS_LIST_LIMIT_MAX = 100;

/**
 * Journal id / account id / period id / user id path-parameter max
 * length. CUID2 + safety margin. Matches the cap used across the
 * accounting contracts.
 */
export const ADMIN_ACCOUNTING_ID_MAX_LENGTH = 64;

/**
 * Wire-shape cap on the `context` jsonb payload on the detail view.
 * 16 KB is well above the typical Stripe-event-digest envelope; the
 * cap exists to bound response size against a noisy context.
 */
export const ADMIN_ACCOUNTING_CONTEXT_MAX_BYTES = 16_384;

/**
 * Hard cap on a single line's debit / credit minor-unit value on the
 * response. Mirrors `JOURNAL_LINE_MAX_AMOUNT_MINOR`.
 */
export const ADMIN_ACCOUNTING_LINE_AMOUNT_MAX_MINOR = 9_999_999_999;

/**
 * Hard cap on per-account totals + grand totals on the trial-balance
 * response. Trial-balance aggregates can run materially larger than a
 * single journal line (sum across many lines), so the cap is one
 * decimal order of magnitude wider than the per-line cap.
 */
export const ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR = 99_999_999_999_999;

/**
 * Wire-shape cap on the trial-balance row collection. The Phase-1 chart
 * of accounts has well under 100 active rows even with per-tier sub-
 * accounts; the cap bounds the response size against a future fan-out.
 */
export const ADMIN_TRIAL_BALANCE_ROWS_MAX = 1_000;

/**
 * Currency code for trial-balance + journal-line filters. Phase-1 is
 * USD only; enum-shape leaves room for Phase-3 multi-currency. Mirrors
 * `AccountCurrencySchema`.
 */
export const AdminAccountingCurrencySchema = z.enum(['USD']);
export type AdminAccountingCurrency = z.infer<typeof AdminAccountingCurrencySchema>;

/**
 * Row shape for one line on the admin journal detail view.
 *
 * `accountCode` + `accountName` are denormalised onto the response so
 * the admin tooling renders the line without an N+1 chart-of-accounts
 * fetch. `accountId` is also surfaced so the UI can deep-link.
 */
export const AdminJournalLineSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    accountId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    accountCode: AccountCodeSchema,
    accountName: z.string().min(1).max(200),
    debitMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_LINE_AMOUNT_MAX_MINOR),
    creditMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_LINE_AMOUNT_MAX_MINOR),
    currency: AdminAccountingCurrencySchema,
    memo: z.string().max(JOURNAL_MEMO_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminJournalLine = z.infer<typeof AdminJournalLineSchema>;

/**
 * Row shape for the journals list response. Carries the envelope + the
 * pre-computed integer minor-unit totals over the embedded lines so the
 * list page renders without an N+1 line fetch.
 *
 * `totalDebitMinor` and `totalCreditMinor` are equal for a balanced
 * journal (and they ARE always balanced — the service-layer invariant
 * is enforced at post time). They're carried as separate fields so the
 * UI can render the dual-column "DR / CR" admin view without parsing
 * one from the other.
 */
export const AdminJournalSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    kind: JournalKindSchema,
    occurredAt: z.string().datetime(),
    postedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    description: z.string().min(1).max(JOURNAL_DESCRIPTION_MAX_LENGTH),
    periodId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    periodName: PeriodNameSchema,
    postedByUserId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).nullable(),
    reversedJournalId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).nullable(),
    reversedByJournalId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).nullable(),
    lineCount: z.number().int().min(JOURNAL_LINES_MIN).max(JOURNAL_LINES_MAX),
    totalDebitMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    totalCreditMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    currency: AdminAccountingCurrencySchema,
  })
  .strict();
export type AdminJournalSummary = z.infer<typeof AdminJournalSummarySchema>;

/**
 * Detail view shape. Composes the envelope columns with the embedded
 * `lines` array + the free-form `context` jsonb payload. Carries the
 * same pre-computed totals as the summary for symmetry — the UI uses
 * one schema for both views.
 */
export const AdminJournalDetailSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    kind: JournalKindSchema,
    occurredAt: z.string().datetime(),
    postedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    description: z.string().min(1).max(JOURNAL_DESCRIPTION_MAX_LENGTH),
    periodId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    periodName: PeriodNameSchema,
    postedByUserId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).nullable(),
    reversedJournalId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).nullable(),
    reversedByJournalId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).nullable(),
    totalDebitMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    totalCreditMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    currency: AdminAccountingCurrencySchema,
    /**
     * Free-form jsonb payload (the originating Stripe-event digest, the
     * booking id triggering a commission post, etc.). Returned as a
     * plain `Record<string, unknown>` on the wire; the controller caps
     * the serialised size to `ADMIN_ACCOUNTING_CONTEXT_MAX_BYTES`.
     */
    context: z.record(z.string(), z.unknown()),
    /**
     * Embedded journal lines, ordered by created_at ASC (the canonical
     * presentation order matches the original posting order).
     */
    lines: z.array(AdminJournalLineSchema).min(JOURNAL_LINES_MIN).max(JOURNAL_LINES_MAX),
  })
  .strict();
export type AdminJournalDetail = z.infer<typeof AdminJournalDetailSchema>;

/**
 * Query shape for `GET /api/v1/admin/journals`.
 *
 * - `periodId`   — optional exact-match filter against `period_id`.
 *                  Wins if both are supplied (UNIQUE id is more
 *                  specific than the human-readable name).
 * - `periodName` — optional exact-match filter against the period's
 *                  display name (YYYY-MM). The service resolves
 *                  name → id internally; an unknown name returns an
 *                  empty page.
 * - `kind`       — optional exact-match filter against `journals.kind`.
 * - `cursor`     — opaque pagination cursor from the previous page's
 *                  `nextCursor`.
 * - `limit`      — page size; defaults to 25, max 100.
 */
export const AdminJournalsListQuerySchema = z
  .object({
    periodId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).optional(),
    periodName: PeriodNameSchema.optional(),
    kind: JournalKindSchema.optional(),
    cursor: z.string().min(1).max(ADMIN_ACCOUNTING_LIST_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_JOURNALS_LIST_LIMIT_MAX)
      .default(ADMIN_JOURNALS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type AdminJournalsListQuery = z.infer<typeof AdminJournalsListQuerySchema>;

export const AdminJournalsListResponseSchema = z
  .object({
    journals: z.array(AdminJournalSummarySchema),
    nextCursor: z.string().min(1).max(ADMIN_ACCOUNTING_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminJournalsListResponse = z.infer<typeof AdminJournalsListResponseSchema>;

export const AdminJournalDetailResponseSchema = z
  .object({
    journal: AdminJournalDetailSchema,
  })
  .strict();
export type AdminJournalDetailResponse = z.infer<typeof AdminJournalDetailResponseSchema>;

/**
 * Per-account aggregate row on the trial-balance response.
 *
 * `debitTotalMinor` and `creditTotalMinor` are the gross totals across
 * every journal line that hit this account in the queried scope.
 * `netDebitMinor` / `netCreditMinor` are derived: exactly one is
 * non-zero, representing the account's net balance. By accounting
 * convention the net falls on the account's `normalBalance` side for
 * "normal" balances and on the opposite side for "abnormal" balances
 * (e.g. a refund-laden revenue account that swung negative).
 *
 * Carries `accountType` + `normalBalance` so the trial-balance UI can
 * present the rows grouped by category (assets → liabilities → equity →
 * revenue → contra-revenue → expense) without an N+1 chart-of-accounts
 * fetch.
 */
export const AdminTrialBalanceRowSchema = z
  .object({
    accountId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    accountCode: AccountCodeSchema,
    accountName: z.string().min(1).max(200),
    accountType: AccountTypeSchema,
    normalBalance: AccountNormalBalanceSchema,
    debitTotalMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    creditTotalMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    netDebitMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    netCreditMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    currency: AdminAccountingCurrencySchema,
  })
  .strict();
export type AdminTrialBalanceRow = z.infer<typeof AdminTrialBalanceRowSchema>;

/**
 * Query shape for `GET /api/v1/admin/trial-balance`.
 *
 * - `periodId`   — optional exact-match scope.
 * - `periodName` — optional exact-match scope. `periodId` wins if both
 *                  are provided.
 * - `currency`   — optional currency filter. Defaults to `USD` (the
 *                  only Phase-1 currency).
 *
 * When neither `periodId` nor `periodName` is provided, the trial
 * balance aggregates across ALL periods (all-time view).
 */
export const AdminTrialBalanceQuerySchema = z
  .object({
    periodId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).optional(),
    periodName: PeriodNameSchema.optional(),
    currency: AdminAccountingCurrencySchema.optional(),
  })
  .strict();
export type AdminTrialBalanceQuery = z.infer<typeof AdminTrialBalanceQuerySchema>;

/**
 * Response shape for `GET /api/v1/admin/trial-balance`.
 *
 * `rows` is sorted by `accountType` (asset → liability → equity →
 * revenue → contra_revenue → expense) then by `accountCode` ascending
 * within each type (the canonical trial-balance display order).
 *
 * `totalDebitMinor` / `totalCreditMinor` are the grand totals across
 * every row — for a balanced ledger they are equal. The discrepancy
 * (if any) is the most important diagnostic on the trial-balance view;
 * surfacing both totals lets the UI render the equality check
 * prominently. `imbalanceMinor` is the absolute difference for the
 * "out of balance by X" headline.
 *
 * `periodId` / `periodName` echo the resolved scope (null when the
 * query was all-time).
 */
export const AdminTrialBalanceResponseSchema = z
  .object({
    rows: z.array(AdminTrialBalanceRowSchema).max(ADMIN_TRIAL_BALANCE_ROWS_MAX),
    totalDebitMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    totalCreditMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    imbalanceMinor: z.number().int().min(0).max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    currency: AdminAccountingCurrencySchema,
    periodId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH).nullable(),
    periodName: PeriodNameSchema.nullable(),
  })
  .strict();
export type AdminTrialBalanceResponse = z.infer<typeof AdminTrialBalanceResponseSchema>;

/**
 * Row shape for one lifecycle event on the per-period audit list.
 * Mirrors `PeriodLifecycleEventResponseSchema` 1:1 — the admin browser
 * surfaces the same shape as the close/reopen response so the UI can
 * reuse one render path.
 */
export const AdminPeriodEventSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    periodId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    periodName: PeriodNameSchema,
    kind: PeriodLifecycleEventKindSchema,
    actorUserId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    reasonCode: z.string().min(1).max(PERIOD_LIFECYCLE_REASON_MAX_LENGTH),
    description: z.string().min(1).max(PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH).nullable(),
    occurredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminPeriodEvent = z.infer<typeof AdminPeriodEventSchema>;

/**
 * Query shape for `GET /api/v1/admin/periods/:periodName/events`.
 *
 * Only `cursor` / `limit` — the period scope is in the path.
 */
export const AdminPeriodEventsListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(ADMIN_ACCOUNTING_LIST_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_PERIOD_EVENTS_LIST_LIMIT_MAX)
      .default(ADMIN_PERIOD_EVENTS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type AdminPeriodEventsListQuery = z.infer<typeof AdminPeriodEventsListQuerySchema>;

export const AdminPeriodEventsListResponseSchema = z
  .object({
    events: z.array(AdminPeriodEventSchema),
    nextCursor: z.string().min(1).max(ADMIN_ACCOUNTING_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminPeriodEventsListResponse = z.infer<typeof AdminPeriodEventsListResponseSchema>;

/* -------------------------------------------------------------------------
 * Paused deferred-revenue balances (TS-042-followup-3b2-followup-2a)
 * ---------------------------------------------------------------------- */

/**
 * Maximum number of paused balances enumerated on one response.
 *
 * The enumeration is capped and the counts are NOT: `pausedCount`,
 * `pastServicePeriodEndCount`, `unknownPausedAtCount` and
 * `totalRemainingDeferredMinor` are computed over every paused row, then
 * the oldest `limit` rows are listed. That split is the whole point of
 * the surface — `accounting_recognition_pause_total` is a *flow* and
 * cannot answer "is anything stuck right now", so an answer that silently
 * stopped at the page boundary would be the same lie in a different
 * shape. Mirrors the overdue-DSAR sweep (TS-309a-followup-2), where the
 * count is uncapped and the enumeration states its own truncation.
 */
export const ADMIN_PAUSED_BALANCES_LIST_LIMIT_MAX = 200;

/** Default enumeration size for `GET /api/v1/admin/deferred-revenue/paused`. */
export const ADMIN_PAUSED_BALANCES_LIST_LIMIT_DEFAULT = 50;

/**
 * One suspended deferred-revenue balance on the ops queue.
 *
 * **Every field is a measurement, not a verdict** (the TS-308c-followup-2
 * console rule). `pastServicePeriodEnd` states a comparison the reader
 * could make themselves from the two timestamps beside it; nothing here
 * calls a balance broken, because a legitimately long pause and a stranded
 * one look identical from the accounting schema and only the subscription's
 * own history distinguishes them.
 *
 * **`pausedAt` is nullable and that is not defensive padding.**
 * `deferred_revenue_balances.paused_at` is nullable, the resume path
 * already tolerates a `paused` row without one (`suspendedDurationSeconds`
 * yields 0), and such a row is the *worst* case on this queue: its age is
 * unknowable, so its suspension can never be shown to be too long. It
 * sorts FIRST and is counted separately rather than being dropped or
 * rendered as age zero. Same reasoning as the null `statutoryDueAt` in the
 * mandated-reporter queue (TS-303c2a) — "nobody established this clock" is
 * the top of the queue, not the bottom.
 *
 * **Money is integer minor units** (CLAUDE.md §17.6). `remainingDeferredMinor`
 * is the stranded amount — `original - recognized` — and is the number an
 * operator is actually triaging on.
 */
export const AdminPausedDeferredRevenueBalanceSchema = z
  .object({
    balanceId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    subscriptionId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    customerId: z.string().min(1).max(ADMIN_ACCOUNTING_ID_MAX_LENGTH),
    customerGroup: PlanCustomerGroupSchema,
    planCode: PlanCodeSchema,
    currency: AdminAccountingCurrencySchema,
    /** Instant the CURRENT pause window opened. Null = unknowable age. */
    pausedAt: z.string().datetime().nullable(),
    /**
     * Whole seconds the current pause window has been open as of `asOf`.
     * Null exactly when `pausedAt` is null — a missing clock has no
     * duration, and reporting `0` would make the least-diagnosable row on
     * the queue look like the freshest one.
     */
    pausedForSeconds: z.number().int().nonnegative().nullable(),
    /**
     * Suspended time already accumulated across PRIOR completed pause
     * windows (`paused_duration_seconds`). Separate from
     * `pausedForSeconds` because the two answer different questions: this
     * one is how much service time has already been given back, that one
     * is how long the balance has been stopped right now.
     */
    priorPausedSeconds: z.number().int().nonnegative(),
    servicePeriodStart: z.string().datetime(),
    servicePeriodEnd: z.string().datetime(),
    /**
     * `servicePeriodEnd < asOf`. A resume EXTENDS `servicePeriodEnd` by
     * the suspended duration, so a still-paused balance carries an
     * un-extended end date: once that date is in the past, the pause has
     * outlasted the entire period the family paid for. That is the shape
     * of the TS-042-followup-3b2-followup-1 defect, and it is the only
     * threshold on this surface that needs no product confirmation
     * because the row supplies it.
     */
    pastServicePeriodEnd: z.boolean(),
    originalAmountMinor: z
      .number()
      .int()
      .nonnegative()
      .max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    recognizedAmountMinor: z
      .number()
      .int()
      .nonnegative()
      .max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    remainingDeferredMinor: z
      .number()
      .int()
      .nonnegative()
      .max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
  })
  .strict();
export type AdminPausedDeferredRevenueBalance = z.infer<
  typeof AdminPausedDeferredRevenueBalanceSchema
>;

/**
 * Uncapped summary over EVERY paused balance, computed independently of
 * the enumeration. Read this before the rows: if `pausedCount` is zero the
 * answer to "is anything stuck" is no, and no page needs reading.
 */
export const AdminPausedDeferredRevenueSummarySchema = z
  .object({
    /** Every row with `status = 'paused'`. Never capped by `limit`. */
    pausedCount: z.number().int().nonnegative(),
    /** Of those, how many are already past their own service period end. */
    pastServicePeriodEndCount: z.number().int().nonnegative(),
    /**
     * Of those, how many carry no `pausedAt`. A non-zero value is a data
     * defect in its own right — the pause path stamps the column — and it
     * is surfaced rather than folded into the total because it bounds how
     * much of `oldestPausedAt` can be trusted.
     */
    unknownPausedAtCount: z.number().int().nonnegative(),
    /**
     * Earliest `pausedAt` across every paused row, or null when nothing is
     * paused OR every paused row is missing the column. Both cases mean
     * the same thing to a reader — there is no oldest known pause — and
     * `unknownPausedAtCount` distinguishes them.
     */
    oldestPausedAt: z.string().datetime().nullable(),
    /** Stranded deferred revenue across every paused row, in minor units. */
    totalRemainingDeferredMinor: z
      .number()
      .int()
      .nonnegative()
      .max(ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR),
    currency: AdminAccountingCurrencySchema,
  })
  .strict();
export type AdminPausedDeferredRevenueSummary = z.infer<
  typeof AdminPausedDeferredRevenueSummarySchema
>;

/**
 * Query shape for `GET /api/v1/admin/deferred-revenue/paused`.
 *
 * No filters and no cursor. The queue is a small ops list bounded by how
 * many subscriptions are suspended at once; a cursor over a NULLS-FIRST
 * nullable sort key buys nothing here and costs the `total` an operator
 * came for (the TS-305c-followup-1 offset-vs-cursor reasoning, one step
 * further). `asOf` exists so the age comparison is reproducible in a test
 * and in a support conversation.
 */
export const AdminPausedDeferredRevenueQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_PAUSED_BALANCES_LIST_LIMIT_MAX)
      .default(ADMIN_PAUSED_BALANCES_LIST_LIMIT_DEFAULT),
    asOf: z.string().datetime().optional(),
  })
  .strict();
export type AdminPausedDeferredRevenueQuery = z.infer<typeof AdminPausedDeferredRevenueQuerySchema>;

export const AdminPausedDeferredRevenueResponseSchema = z
  .object({
    /** The instant every age + `pastServicePeriodEnd` was computed against. */
    asOf: z.string().datetime(),
    summary: AdminPausedDeferredRevenueSummarySchema,
    /**
     * The oldest-first page. Ordered `pausedAt ASC NULLS FIRST, id ASC` —
     * longest-suspended at the top, unknown-age above everything.
     */
    balances: z.array(AdminPausedDeferredRevenueBalanceSchema),
    /**
     * True when `summary.pausedCount` exceeds the rows returned. Stated
     * rather than inferred: a consumer comparing lengths would have to
     * know the requested limit to tell a full page from a truncated one.
     */
    truncated: z.boolean(),
  })
  .strict();
export type AdminPausedDeferredRevenueResponse = z.infer<
  typeof AdminPausedDeferredRevenueResponseSchema
>;
