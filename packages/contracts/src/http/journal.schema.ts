import { z } from 'zod';

import { AccountCodeSchema, AccountCurrencySchema } from './account.schema';

/**
 * Journal posting + reversal contracts (PDD §11.2, Appendix A).
 *
 * TS-081 ships the JournalPostingService that backs three write
 * endpoints:
 *
 *   - `POST /api/v1/internal/journals` — system-driven journals
 *     produced by the outbox relay (TS-142) — subscription
 *     activation, subscription recognition, booking completion,
 *     coupon redemption, payout disbursement, refund, payment
 *     processing fee. Shared-secret pinned (header) while the relay
 *     transport is the synchronous HTTP scaffold used by the KYC +
 *     Checkr dispatchers; flips to the canonical relay subscription
 *     once TS-142 lands.
 *
 *   - `POST /api/v1/admin/journals/manual-adjustment` — explicit
 *     finance:adjust override (CLAUDE.md §6). Locked to
 *     `kind = 'manual_adjustment'` at the contract layer so an
 *     admin can never accidentally post a system-kind journal that
 *     bypasses the outbox.
 *
 *   - `POST /api/v1/admin/journals/:journalId/reverse` — reversal
 *     of an existing journal. The reversal journal mirrors the
 *     original's lines with debit↔credit swapped and links via
 *     `reversedJournalId`; the original's `reversedByJournalId`
 *     back-pointer is the only mutation the platform makes on a
 *     posted journal (CLAUDE.md §6 immutability — the mutation
 *     IS the audit record).
 *
 * **Money discipline.** Amounts cross the wire as **integer USD
 * minor units** (cents) per CLAUDE.md §17.6 — no floats touch
 * money. The service converts to `Decimal` at the boundary; the
 * database stores `Decimal(12, 2)` (dollars + cents). Wire shape:
 * `debitMinor: 29900` ≡ $299.00 stored as `Decimal('299.00')`.
 *
 * **`sourceEventId`** is the upstream identifier the journal was
 * posted FOR — the outbox event id for system journals, an admin
 * request id for manual adjustments, a separate reversal event
 * id for reversals. The accounting service enforces UNIQUE on
 * the column at the DB layer so an at-least-once relay redelivery
 * squashes to exactly-once posting; consumers of these endpoints
 * SHOULD generate a stable id per business event (the outbox
 * event id is the canonical source) and replay-safe IDs for
 * admin-driven posts.
 */

/**
 * Categorical kind of a journal entry. Mirrors
 * `accounting.journal_kind` 1:1.
 *
 * Most kinds are produced by the outbox relay against system
 * events (`subscription.activated` → `subscription_activation`,
 * etc.). `manual_adjustment` is the finance:adjust override
 * kind; `reversal` is set by the reverse endpoint and is NOT
 * accepted on the post endpoints.
 */
export const JournalKindSchema = z.enum([
  'subscription_activation',
  'subscription_recognition',
  'subscription_cancellation',
  'booking_completion',
  'provider_payout',
  'refund',
  'coupon_redemption',
  'payment_processing_fee',
  'manual_adjustment',
  'period_close',
  'reversal',
]);
export type JournalKind = z.infer<typeof JournalKindSchema>;

/**
 * The subset of `JournalKind` accepted on the system-driven post
 * endpoint. Excludes `reversal` (set only by the reverse
 * endpoint) and `period_close` (set only by the TS-085 period-
 * close workflow).
 */
export const PostableJournalKindSchema = z.enum([
  'subscription_activation',
  'subscription_recognition',
  'subscription_cancellation',
  'booking_completion',
  'provider_payout',
  'refund',
  'coupon_redemption',
  'payment_processing_fee',
  'manual_adjustment',
]);
export type PostableJournalKind = z.infer<typeof PostableJournalKindSchema>;

export const JOURNAL_DESCRIPTION_MAX_LENGTH = 1_000;
export const JOURNAL_MEMO_MAX_LENGTH = 1_000;
export const JOURNAL_LINES_MIN = 2;
export const JOURNAL_LINES_MAX = 200;
export const JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH = 200;
export const JOURNAL_REVERSAL_REASON_MAX_LENGTH = 500;
/**
 * Hard cap on a single line's debit or credit minor-unit value.
 * `Decimal(12, 2)` stores up to 10 digits left of the decimal —
 * the cap on the wire integer matches that envelope. A single
 * journal line representing more than ~$99M crosses no practical
 * Phase-1 path; a malformed/overflowing input is rejected here.
 */
export const JOURNAL_LINE_MAX_AMOUNT_MINOR = 9_999_999_999;

/**
 * Input shape for one line of a journal-posting request.
 *
 * **Exactly one** of `debitMinor` / `creditMinor` must be set
 * (non-zero); the other is omitted. The contract enforces the
 * XOR via `superRefine` so a "both set" or "neither set" payload
 * is rejected at parse time rather than reaching the service.
 *
 * `accountCode` references the chart-of-accounts row by its
 * stable code (e.g. `"1000"`, `"4000.family.tier2"`). The
 * service resolves `code → id` at post time via
 * `ChartOfAccountsService` and rejects unknown / inactive codes
 * with a typed Result failure.
 *
 * `currency` defaults to USD. All lines in a single journal
 * must share a currency; the service rejects mixed-currency
 * journals (Phase 1 is single-currency anyway).
 */
export const JournalLineInputSchema = z
  .object({
    accountCode: AccountCodeSchema,
    debitMinor: z.number().int().min(0).max(JOURNAL_LINE_MAX_AMOUNT_MINOR).optional(),
    creditMinor: z.number().int().min(0).max(JOURNAL_LINE_MAX_AMOUNT_MINOR).optional(),
    currency: AccountCurrencySchema.default('USD'),
    memo: z.string().min(1).max(JOURNAL_MEMO_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((line, ctx) => {
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    if (debit === 0 && credit === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'each line must have exactly one of `debitMinor` or `creditMinor` set to a non-zero value',
        path: ['debitMinor'],
      });
      return;
    }
    if (debit > 0 && credit > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a line cannot have both `debitMinor` and `creditMinor` set; exactly one must be non-zero',
        path: ['creditMinor'],
      });
    }
  });
export type JournalLineInput = z.infer<typeof JournalLineInputSchema>;

/**
 * Request body for `POST /api/v1/internal/journals` — system-
 * driven journal posting from the outbox relay.
 *
 * `context` is free-form JSON (size-capped at the controller
 * layer to keep round-trips bounded). Stored in `journals.context`
 * as `jsonb` so reports can drill in without joining another
 * service.
 */
export const PostJournalRequestSchema = z
  .object({
    kind: PostableJournalKindSchema,
    occurredAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    description: z.string().min(1).max(JOURNAL_DESCRIPTION_MAX_LENGTH),
    lines: z.array(JournalLineInputSchema).min(JOURNAL_LINES_MIN).max(JOURNAL_LINES_MAX),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type PostJournalRequest = z.infer<typeof PostJournalRequestSchema>;

/**
 * Request body for `POST /api/v1/admin/journals/manual-adjustment`.
 *
 * Locks `kind` to `manual_adjustment` at the contract layer so
 * an admin route never accidentally posts a system-kind journal
 * that bypasses the outbox.
 */
export const ManualAdjustmentRequestSchema = z
  .object({
    occurredAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    description: z.string().min(1).max(JOURNAL_DESCRIPTION_MAX_LENGTH),
    reasonCode: z.string().min(1).max(JOURNAL_REVERSAL_REASON_MAX_LENGTH),
    lines: z.array(JournalLineInputSchema).min(JOURNAL_LINES_MIN).max(JOURNAL_LINES_MAX),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ManualAdjustmentRequest = z.infer<typeof ManualAdjustmentRequestSchema>;

/**
 * Request body for `POST /api/v1/admin/journals/:journalId/reverse`.
 *
 * The reversal mirrors the original's lines with debit↔credit
 * swapped; the request body carries the reversal event id (so
 * the reversal is idempotent on a stable upstream id) and the
 * reason code (immutably recorded on the reversal's `context`
 * for finance audit).
 */
export const ReverseJournalRequestSchema = z
  .object({
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    occurredAt: z.string().datetime(),
    reasonCode: z.string().min(1).max(JOURNAL_REVERSAL_REASON_MAX_LENGTH),
    description: z.string().min(1).max(JOURNAL_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();
export type ReverseJournalRequest = z.infer<typeof ReverseJournalRequestSchema>;

/**
 * Response shape for one line of a posted journal.
 *
 * Mirrors `JournalLineInputSchema` plus the persisted id +
 * resolved `accountId` so consumers can link to the chart-of-
 * accounts row without re-querying.
 */
export const JournalLineResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    accountId: z.string().min(1).max(64),
    accountCode: AccountCodeSchema,
    debitMinor: z.number().int().min(0),
    creditMinor: z.number().int().min(0),
    currency: AccountCurrencySchema.default('USD'),
    memo: z.string().max(JOURNAL_MEMO_MAX_LENGTH).optional(),
  })
  .strict();
export type JournalLineResponse = z.infer<typeof JournalLineResponseSchema>;

/**
 * Response shape for `POST /api/v1/internal/journals` (and the
 * admin variants).
 *
 * `periodName` is denormalised onto the response so a consumer
 * doesn't have to fetch the period separately to render the
 * journal (`"2026-05"`). The id is also included for tooling
 * that wants to navigate to the period detail view.
 */
export const JournalResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: JournalKindSchema,
    occurredAt: z.string().datetime(),
    postedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    description: z.string().min(1).max(JOURNAL_DESCRIPTION_MAX_LENGTH),
    periodId: z.string().min(1).max(64),
    periodName: z.string().min(1).max(64),
    postedByUserId: z.string().min(1).max(64).nullable(),
    reversedJournalId: z.string().min(1).max(64).nullable(),
    reversedByJournalId: z.string().min(1).max(64).nullable(),
    context: z.record(z.string(), z.unknown()),
    lines: z.array(JournalLineResponseSchema).min(JOURNAL_LINES_MIN).max(JOURNAL_LINES_MAX),
  })
  .strict();
export type JournalResponse = z.infer<typeof JournalResponseSchema>;
