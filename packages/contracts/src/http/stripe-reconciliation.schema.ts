import { z } from 'zod';

import { AccountCurrencySchema } from './account.schema';

/**
 * Stripe → ledger reconciliation contracts (TS-261, PRD §10.3, PDD §11.2,
 * CLAUDE.md §6).
 *
 * A scheduled worker (`worker-stripe-reconciliation`) triggers
 * service-accounting nightly to compare **Stripe's reported state** against
 * the **platform ledger** for a UTC calendar day and persist the outcome.
 * Two independent checks land per day:
 *
 *   - `balance`  — Stripe's reported balance (available + pending) vs. the
 *     ledger Cash account (`1000`) net balance as of end-of-day.
 *   - `activity` — Stripe's net balance-transaction activity for the day
 *     vs. the ledger Cash account's net movement over the same window.
 *
 * When a check's `|delta|` exceeds the tolerance the row lands as a
 * `mismatch_open` **ops ticket** — the reconciliation NEVER auto-corrects
 * the ledger (CLAUDE.md §6 "do not auto-correct silently"). An operator
 * triages + resolves via the admin surface. A re-run for the same day
 * refreshes the computed figures idempotently and preserves a human
 * resolution (a still-mismatching `mismatch_resolved` row is not silently
 * reopened).
 *
 * Two compute surfaces + two read/act surfaces:
 *
 *   - `POST /api/v1/internal/accounting/stripe-reconciliation/run` —
 *     shared-secret-pinned, called by the worker nightly. `asOf` defaults
 *     to "now" on the server.
 *   - `POST /api/v1/admin/accounting/stripe-reconciliation/run` —
 *     `AccessTokenGuard` + `SuperAdminRoleGuard`; ops back-fill / same-day
 *     re-run. Mirrors the `saas-metrics` + `recognize-daily` admin-trigger
 *     precedent.
 *   - `GET /api/v1/admin/accounting/stripe-reconciliation/checks` — the
 *     ops queue read (filter by status + date range).
 *   - `POST /api/v1/admin/accounting/stripe-reconciliation/checks/:id/resolve`
 *     — operator resolution of a `mismatch_open` ticket.
 *
 * **Money discipline.** Every monetary field crosses the wire as integer
 * USD minor units (cents) — CLAUDE.md §17.6, never floats. The service
 * computes in `Decimal` and rounds once at the cent; the database stores
 * `Decimal(12, 2)`. Cash balances + movements + deltas may be negative (a
 * payout-heavy day nets the Cash account below zero on the movement
 * dimension), so the monetary fields accept the signed range.
 *
 * **Stub mode.** Phase 1 runs without a live Stripe secret key. In stub
 * mode the reconciliation cannot query Stripe, so it records a
 * `skipped_stub` check (mode `stub`) carrying the ledger figures with null
 * Stripe figures — no ops ticket. Live SDK wiring is TS-261-followup-1.
 */

/** `YYYY-MM-DD` calendar-date string (UTC). The reconciliation-day key. */
export const STRIPE_RECONCILIATION_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const StripeReconciliationDateSchema = z
  .string()
  .regex(
    STRIPE_RECONCILIATION_DATE_REGEX,
    'reconciliation date must be a UTC calendar date (YYYY-MM-DD)',
  );
export type StripeReconciliationDate = z.infer<typeof StripeReconciliationDateSchema>;

/**
 * Cap on any monetary field magnitude (cents). Mirrors the `Decimal(12, 2)`
 * envelope: 9,999,999,999.99 → 999,999,999,999 minor units. A wire-shape
 * sanity bound, not a business limit.
 */
export const STRIPE_RECONCILIATION_MAX_MINOR = 999_999_999_999;

/** Max length of a human-readable check `detail` summary. */
export const STRIPE_RECONCILIATION_DETAIL_MAX_LENGTH = 1000;

/** Max length of an operator resolution note. */
export const STRIPE_RECONCILIATION_RESOLUTION_NOTES_MAX_LENGTH = 2000;

/**
 * Cap on the number of check rows a single range read returns. The ops
 * queue read scans the `(reconciliation_date, category)` ordering and takes
 * at most this many rows, most-recent first; a wider range truncates (the
 * response echoes the EFFECTIVE `from`/`to`). Bounds the scan + wire
 * payload (CLAUDE.md §7.2).
 */
export const STRIPE_RECONCILIATION_CHECKS_RANGE_MAX_ROWS = 400;

/**
 * The two reconciliation dimensions compared per day.
 *   - `balance`  — end-of-day Stripe balance vs. ledger Cash balance.
 *   - `activity` — day's Stripe net activity vs. ledger Cash net movement.
 */
export const StripeReconciliationCategorySchema = z.enum(['balance', 'activity']);
export type StripeReconciliationCategory = z.infer<typeof StripeReconciliationCategorySchema>;

/**
 * Lifecycle status of a per-(day, category) check — the row doubles as the
 * run checkpoint AND the ops ticket:
 *   - `matched`            — within tolerance; informational checkpoint.
 *   - `mismatch_open`      — beyond tolerance; an open ops ticket.
 *   - `mismatch_resolved`  — an operator triaged + closed the ticket.
 *   - `skipped_stub`       — Stripe not queried (stub mode); no ticket.
 */
export const StripeReconciliationStatusSchema = z.enum([
  'matched',
  'mismatch_open',
  'mismatch_resolved',
  'skipped_stub',
]);
export type StripeReconciliationStatus = z.infer<typeof StripeReconciliationStatusSchema>;

/** Whether Stripe was actually queried (`live`) or stubbed out (`stub`). */
export const StripeReconciliationModeSchema = z.enum(['live', 'stub']);
export type StripeReconciliationMode = z.infer<typeof StripeReconciliationModeSchema>;

const SignedMinorSchema = z
  .number()
  .int()
  .min(-STRIPE_RECONCILIATION_MAX_MINOR)
  .max(STRIPE_RECONCILIATION_MAX_MINOR);

/**
 * Persisted per-(day, category) reconciliation check
 * (`accounting.stripe_reconciliation_checks`).
 *
 * `expectedAmountMinor` is the ledger figure (the platform's expectation);
 * `actualAmountMinor` is Stripe's reported figure (null in stub mode);
 * `deltaAmountMinor = actual − expected` (null in stub mode).
 */
export const StripeReconciliationCheckRecordSchema = z
  .object({
    /** The UTC calendar date this check describes. */
    reconciliationDate: StripeReconciliationDateSchema,
    category: StripeReconciliationCategorySchema,
    status: StripeReconciliationStatusSchema,
    mode: StripeReconciliationModeSchema,
    currency: AccountCurrencySchema,
    /** Ledger figure (Cash balance for `balance`, Cash movement for `activity`). */
    expectedAmountMinor: SignedMinorSchema,
    /** Stripe reported figure. Null in stub mode. */
    actualAmountMinor: SignedMinorSchema.nullable(),
    /** `actual − expected`. Null in stub mode. */
    deltaAmountMinor: SignedMinorSchema.nullable(),
    /** Absolute tolerance applied — `|delta| > tolerance` flags a mismatch. */
    toleranceAmountMinor: z.number().int().min(0).max(STRIPE_RECONCILIATION_MAX_MINOR),
    /** Count of Stripe balance transactions scanned (activity check). Null otherwise / in stub. */
    stripeTransactionCount: z.number().int().min(0).nullable(),
    /** Start of the compared UTC-day window (ISO-8601, inclusive). */
    windowStart: z.string().datetime(),
    /** End of the compared UTC-day window (ISO-8601, exclusive). */
    windowEnd: z.string().datetime(),
    /** Human-readable summary of the check outcome. */
    detail: z.string().max(STRIPE_RECONCILIATION_DETAIL_MAX_LENGTH),
    /** When the worker computed this check (ISO-8601). */
    computedAt: z.string().datetime(),
    /** When an operator resolved the ticket (ISO-8601). Null while open / matched. */
    resolvedAt: z.string().datetime().nullable(),
    /** The operator who resolved the ticket. Null while open / matched. */
    resolvedByUserId: z.string().nullable(),
    /** Operator resolution notes. Null while open / matched. */
    resolutionNotes: z.string().max(STRIPE_RECONCILIATION_RESOLUTION_NOTES_MAX_LENGTH).nullable(),
  })
  .strict();
export type StripeReconciliationCheckRecord = z.infer<typeof StripeReconciliationCheckRecordSchema>;

/**
 * Request body for both run endpoints. `asOf` defaults to "now" on the
 * server. Supplied for ops back-fills / deterministic test runs. The check
 * rows are keyed by the UTC calendar date of `asOf`; re-running for the
 * same date refreshes the rows idempotently.
 */
export const RunStripeReconciliationRequestSchema = z
  .object({
    asOf: z.string().datetime().optional(),
  })
  .strict();
export type RunStripeReconciliationRequest = z.infer<typeof RunStripeReconciliationRequestSchema>;

/**
 * Response for both run endpoints. Returns the day's checks plus a count of
 * still-open mismatches so the worker can log "N open mismatches" without a
 * second read.
 */
export const RunStripeReconciliationResponseSchema = z
  .object({
    reconciliationDate: StripeReconciliationDateSchema,
    mode: StripeReconciliationModeSchema,
    checks: z.array(StripeReconciliationCheckRecordSchema),
    openMismatchCount: z.number().int().min(0),
  })
  .strict();
export type RunStripeReconciliationResponse = z.infer<typeof RunStripeReconciliationResponseSchema>;

/**
 * Query for the admin ops-queue read:
 * `GET /api/v1/admin/accounting/stripe-reconciliation/checks`. All filters
 * optional; `from`/`to` are inclusive UTC dates (lexical `YYYY-MM-DD`
 * comparison is date-correct). `from` must not be after `to`.
 */
export const ListStripeReconciliationChecksQuerySchema = z
  .object({
    status: StripeReconciliationStatusSchema.optional(),
    from: StripeReconciliationDateSchema.optional(),
    to: StripeReconciliationDateSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must not be after to',
      });
    }
  });
export type ListStripeReconciliationChecksQuery = z.infer<
  typeof ListStripeReconciliationChecksQuerySchema
>;

/**
 * Response for the admin ops-queue read. Checks are ordered most-recent
 * first (newest reconciliation date first, `balance` before `activity`
 * within a day). `from`/`to` echo the EFFECTIVE window — the earliest +
 * latest `reconciliationDate` actually returned — both null when empty.
 */
export const ListStripeReconciliationChecksResponseSchema = z
  .object({
    checks: z.array(StripeReconciliationCheckRecordSchema),
    from: StripeReconciliationDateSchema.nullable(),
    to: StripeReconciliationDateSchema.nullable(),
  })
  .strict();
export type ListStripeReconciliationChecksResponse = z.infer<
  typeof ListStripeReconciliationChecksResponseSchema
>;

/**
 * Request body for resolving a `mismatch_open` ticket. The resolution note
 * is mandatory — CLAUDE.md §6 demands a paper trail on every financial
 * adjustment decision (here: the decision that a divergence is explained /
 * accepted).
 */
export const ResolveStripeReconciliationCheckRequestSchema = z
  .object({
    resolutionNotes: z
      .string()
      .min(1, 'resolutionNotes is required')
      .max(STRIPE_RECONCILIATION_RESOLUTION_NOTES_MAX_LENGTH),
  })
  .strict();
export type ResolveStripeReconciliationCheckRequest = z.infer<
  typeof ResolveStripeReconciliationCheckRequestSchema
>;

/** Response for the resolve endpoint — the updated check row. */
export const ResolveStripeReconciliationCheckResponseSchema = z
  .object({
    check: StripeReconciliationCheckRecordSchema,
  })
  .strict();
export type ResolveStripeReconciliationCheckResponse = z.infer<
  typeof ResolveStripeReconciliationCheckResponseSchema
>;
