import { Injectable, Logger } from '@nestjs/common';
import type {
  JournalLineInput,
  JournalResponse,
  ManualAdjustmentRequest,
  PostJournalRequest,
  ReverseJournalRequest,
} from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

import type { Prisma } from '../../../../prisma/generated';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { toJournalResponse, type PersistedJournalWithLines } from '../mappers/journal.mapper';
import {
  AccountingPeriodService,
  type ResolvedAccountingPeriod,
} from './accounting-period.service';

/**
 * Failure variants from `JournalPostingService.post` /
 * `postManualAdjustment` / `reverse`.
 *
 * The service returns `Result<T, Failure>` rather than throwing
 * across boundaries (CLAUDE.md §2.1: fallible operations crossing
 * service or transaction boundaries use Result). Each variant
 * maps to a controller-side HTTP status:
 *
 * - `account_not_found` / `account_inactive` → 404
 * - `journal_unbalanced` / `mixed_currency` → 422 (the request is
 *   syntactically valid but accounting-invalid)
 * - `period_closed` → 422 (post requires finance:adjust + reopen)
 * - `already_posted` → 200 with the existing journal returned (the
 *   relay's at-least-once redelivery is squashed to exactly-once
 *   posting; the caller gets the canonical persisted row)
 * - `journal_not_found` (reverse only) → 404
 * - `already_reversed` (reverse only) → 409
 */
export type PostJournalFailure =
  | {
      readonly kind: 'account_not_found';
      readonly accountCode: string;
    }
  | {
      readonly kind: 'account_inactive';
      readonly accountCode: string;
    }
  | {
      readonly kind: 'journal_unbalanced';
      readonly debitTotalMinor: number;
      readonly creditTotalMinor: number;
    }
  | {
      readonly kind: 'mixed_currency';
      readonly currencies: readonly string[];
    }
  | {
      readonly kind: 'period_closed';
      readonly periodId: string;
      readonly periodName: string;
    };

export type ReverseJournalFailure =
  | {
      readonly kind: 'journal_not_found';
      readonly journalId: string;
    }
  | {
      readonly kind: 'already_reversed';
      readonly journalId: string;
      readonly reversedByJournalId: string;
    }
  | { readonly kind: 'period_closed'; readonly periodId: string; readonly periodName: string }
  | { readonly kind: 'account_inactive'; readonly accountCode: string };

/**
 * `Result<T, E>` discriminated union mirroring the pattern used in
 * service-subscription / service-provider. Failure carriers are
 * narrow (no surplus context) so the controller can map each
 * variant to a specific HTTP response without leaking internals.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(failure: E): Result<never, E> => ({ ok: false, failure });

/**
 * `JournalPostingService` — the financial source of truth's
 * write surface.
 *
 * The double-entry invariant is enforced HERE at the service
 * layer (CLAUDE.md §6 "surgical posture" + §17.7
 * "Mutating audit log entries" prohibition). The DB-level
 * `journal_lines_debit_or_credit_only` + `journal_lines_non_negative`
 * CHECK constraints defend against ad-hoc inserts; this service is
 * the only application-layer path that posts journals through
 * `prisma.$transaction` so the invariant + persistence are atomic.
 *
 * **Money math.** All arithmetic uses `Decimal` (CLAUDE.md §17.6).
 * The contract layer's wire shape is integer minor units
 * (`debitMinor: 29900`); the service converts to `Decimal` at the
 * boundary (`new Decimal(29900).div(100) === Decimal('299.00')`)
 * and the Prisma column is `Decimal(12, 2)`. Rounding never
 * occurs in the posting path — the integer cents on the wire and
 * the two-decimal Prisma column are exact representations of the
 * same value.
 *
 * **Idempotency.** Journals are unique on `source_event_id` at
 * the DB layer. The service catches a P2002 violation, refetches
 * the existing row, and returns it as a successful Result — the
 * relay's at-least-once redelivery surfaces as exactly-once
 * posting. The outbox event id (or admin request id) is the
 * canonical source for this column.
 *
 * **Immutability.** No journal row is ever updated by this
 * service except for the one-time `reversedByJournalId` back-
 * pointer (CLAUDE.md §6 — the back-pointer IS the audit
 * record). Corrections are explicit reversal journals + a
 * replacement journal of the appropriate kind.
 *
 * **Tenant scoping.** Accounting rows are not tenant-scoped —
 * the platform's books are one set for one company. Row-level
 * checks live in the controller (only finance role-holders can
 * post manual adjustments).
 */
@Injectable()
export class JournalPostingService {
  private readonly logger = new Logger(JournalPostingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: AccountingPeriodService,
  ) {}

  /**
   * Post a system-driven journal (kind ∈ subscription_activation,
   * booking_completion, ..., manual_adjustment).
   *
   * `postedByUserId = null` for system-driven posts (the outbox
   * relay is the actor; the source event id is the audit trail).
   */
  async post(
    request: PostJournalRequest,
    postedByUserId: string | null,
  ): Promise<Result<JournalResponse, PostJournalFailure>> {
    return this.postInternal({
      kind: request.kind,
      occurredAt: new Date(request.occurredAt),
      sourceEventId: request.sourceEventId,
      description: request.description,
      lines: request.lines,
      context: request.context ?? {},
      postedByUserId,
      reversedJournalId: null,
    });
  }

  /**
   * Post a manual adjustment. The kind is locked to
   * `manual_adjustment`; the reason code is woven into the
   * `context` jsonb column so finance audit reports can drill in
   * without a separate table.
   */
  async postManualAdjustment(
    request: ManualAdjustmentRequest,
    postedByUserId: string,
  ): Promise<Result<JournalResponse, PostJournalFailure>> {
    return this.postInternal({
      kind: 'manual_adjustment',
      occurredAt: new Date(request.occurredAt),
      sourceEventId: request.sourceEventId,
      description: request.description,
      lines: request.lines,
      context: { reasonCode: request.reasonCode, ...(request.context ?? {}) },
      postedByUserId,
      reversedJournalId: null,
    });
  }

  /**
   * Reverse an existing journal. The reversal's lines mirror the
   * original's with debit↔credit swapped; the new journal carries
   * `kind = 'reversal'` and `reversed_journal_id` pointing at the
   * original; the original's `reversed_by_journal_id` back-pointer
   * is set in the same transaction.
   *
   * Idempotency: the reversal's `sourceEventId` (carried on the
   * request body) is unique at the DB layer just like a normal
   * post; a redelivery of the same reversal event surfaces as
   * exactly-once.
   *
   * Once a journal is reversed, a second reversal request is
   * rejected with `already_reversed` — the existing reversal is
   * the audit record.
   */
  async reverse(
    journalId: string,
    request: ReverseJournalRequest,
    postedByUserId: string,
  ): Promise<Result<JournalResponse, ReverseJournalFailure | PostJournalFailure>> {
    const original = await this.prisma.journal.findUnique({
      where: { id: journalId },
      select: ORIGINAL_FOR_REVERSAL_SELECT,
    });
    if (original === null) {
      return fail({ kind: 'journal_not_found', journalId });
    }
    if (original.reversedByJournalId !== null) {
      return fail({
        kind: 'already_reversed',
        journalId,
        reversedByJournalId: original.reversedByJournalId,
      });
    }

    // Build the reversal's input lines from the original's lines,
    // swapping debit↔credit. Convert Prisma Decimal back to integer
    // minor units for the inner call (the service is the single
    // boundary between wire-shape integers and DB-shape Decimals).
    const reversalLines: JournalLineInput[] = (
      original.lines as readonly OriginalLineForReversal[]
    ).map((line) => {
      const debit = anyToDecimal(line.debit);
      const credit = anyToDecimal(line.credit);
      const debitMinor = decimalToMinor(debit);
      const creditMinor = decimalToMinor(credit);
      return {
        accountCode: line.account.code,
        // Swap: the original's credit becomes the reversal's debit
        // and vice versa.
        ...(creditMinor > 0 ? { debitMinor: creditMinor } : { creditMinor: debitMinor }),
        currency: line.currency as 'USD',
        ...(line.memo !== null && { memo: line.memo }),
      };
    });

    const reversalDescription =
      request.description ?? `Reversal of journal ${journalId}: ${request.reasonCode}`;

    const result = await this.postInternal({
      kind: 'reversal',
      occurredAt: new Date(request.occurredAt),
      sourceEventId: request.sourceEventId,
      description: reversalDescription,
      lines: reversalLines,
      context: {
        reasonCode: request.reasonCode,
        reversedJournalId: journalId,
        originalSourceEventId: original.sourceEventId,
      },
      postedByUserId,
      reversedJournalId: journalId,
    });

    return result;
  }

  /**
   * Core posting routine. The single $transaction wraps:
   *
   *   1. Resolve accounting period for `occurredAt` (lazy-create
   *      monthly if needed). Reject if the period is closed.
   *   2. Resolve every `accountCode` to its persisted row id +
   *      active flag. Reject `account_not_found` /
   *      `account_inactive`.
   *   3. Validate the lines' currencies (all share one) and the
   *      double-entry invariant (sum DR = sum CR).
   *   4. Insert the journal + lines + (for reversals) flip the
   *      original's `reversed_by_journal_id` back-pointer.
   *   5. Read the persisted journal back for the response shape.
   *
   * The Prisma transaction's read-committed isolation is
   * sufficient because the only inter-statement coordination is
   * (a) the period lazy-create UNIQUE race (handled inside
   * `AccountingPeriodService`) and (b) the journal's
   * `source_event_id` UNIQUE race (handled by the P2002 catch
   * below).
   */
  private async postInternal(
    spec: InternalPostSpec,
  ): Promise<Result<JournalResponse, PostJournalFailure>> {
    // Validate currency homogeneity + the double-entry invariant
    // BEFORE opening a transaction. These checks are pure CPU on
    // the request body; failing them early avoids a transactional
    // round-trip for a malformed input.
    const currencyCheck = checkSingleCurrency(spec.lines);
    if (!currencyCheck.ok) {
      return fail(currencyCheck.failure);
    }
    const balanceCheck = checkBalanced(spec.lines);
    if (!balanceCheck.ok) {
      return fail(balanceCheck.failure);
    }

    try {
      const persisted = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const period = await this.periods.findOrCreateContaining(spec.occurredAt, tx);
        if (period.status === 'closed') {
          throw new ClosedPeriodError(period);
        }

        const accountIdsByCode = await resolveAccountIdsByCode(
          tx,
          spec.lines.map((line) => line.accountCode),
        );

        const journal = await tx.journal.create({
          data: {
            kind: spec.kind,
            occurredAt: spec.occurredAt,
            sourceEventId: spec.sourceEventId,
            description: spec.description,
            periodId: period.id,
            postedByUserId: spec.postedByUserId,
            reversedJournalId: spec.reversedJournalId,
            // `context` is a non-nullable `Json @default("{}")` column, so
            // the input alias is `Prisma.InputJsonValue`. A bare
            // `Record<string, unknown>` is not assignable to it — the index
            // signature admits values Prisma cannot serialise (TS-501).
            context: spec.context as Prisma.InputJsonValue,
            lines: {
              create: spec.lines.map((line) => ({
                accountId: accountIdsByCode[line.accountCode] as string,
                debit: minorToDecimal(line.debitMinor ?? 0),
                credit: minorToDecimal(line.creditMinor ?? 0),
                currency: line.currency,
                memo: line.memo ?? null,
              })),
            },
          },
          select: JOURNAL_WITH_LINES_SELECT,
        });

        if (spec.reversedJournalId !== null) {
          // Set the original's back-pointer in the same
          // transaction. This is the ONLY mutation accepted on a
          // posted journal — the mutation IS the audit record
          // (CLAUDE.md §6).
          await tx.journal.update({
            where: { id: spec.reversedJournalId },
            data: { reversedByJournalId: journal.id },
          });
        }

        return journal as PersistedJournalWithLines;
      });

      this.logger.log(
        {
          journalId: persisted.id,
          kind: persisted.kind,
          sourceEventId: persisted.sourceEventId,
          periodName: persisted.period.name,
          lineCount: persisted.lines.length,
        },
        'journal.posted',
      );
      return ok(toJournalResponse(persisted));
    } catch (err) {
      // Account-resolution failures + closed-period rejection are
      // thrown from within the transaction as typed Errors so the
      // surrounding $transaction rolls back; here we narrow them
      // back to Result variants.
      if (err instanceof AccountResolutionError) {
        return fail(err.failure);
      }
      if (err instanceof ClosedPeriodError) {
        return fail({
          kind: 'period_closed',
          periodId: err.period.id,
          periodName: err.period.name,
        });
      }
      // P2002 on `source_event_id` — at-least-once redelivery.
      // Refetch the existing journal and return it; the caller
      // gets the canonical posted row.
      if (isUniqueViolationOn(err, 'source_event_id')) {
        const existing = await this.prisma.journal.findUnique({
          where: { sourceEventId: spec.sourceEventId },
          select: JOURNAL_WITH_LINES_SELECT,
        });
        if (existing !== null) {
          this.logger.log(
            {
              journalId: existing.id,
              sourceEventId: spec.sourceEventId,
              kind: existing.kind,
            },
            'journal.idempotent-replay',
          );
          return ok(toJournalResponse(existing as PersistedJournalWithLines));
        }
      }
      throw err;
    }
  }
}

type AnyJournalKind =
  | 'subscription_activation'
  | 'subscription_recognition'
  | 'subscription_cancellation'
  | 'booking_completion'
  | 'provider_payout'
  | 'refund'
  | 'coupon_redemption'
  | 'payment_processing_fee'
  | 'manual_adjustment'
  | 'period_close'
  | 'reversal';

interface InternalPostSpec {
  readonly kind: AnyJournalKind;
  readonly occurredAt: Date;
  readonly sourceEventId: string;
  readonly description: string;
  readonly lines: readonly JournalLineInput[];
  readonly context: Record<string, unknown>;
  readonly postedByUserId: string | null;
  readonly reversedJournalId: string | null;
}

/**
 * Currency homogeneity check. Phase-1 has one currency in play
 * (USD); the check is forward-compatible against the multi-currency
 * Phase-3 schema. A mixed-currency journal is accounting-invalid
 * — debits and credits across currencies can't sum to zero
 * without FX, and FX has its own posting flow (out of scope here).
 */
function checkSingleCurrency(lines: readonly JournalLineInput[]): Result<void, PostJournalFailure> {
  const currencies = new Set<string>();
  for (const line of lines) {
    currencies.add(line.currency);
  }
  if (currencies.size > 1) {
    return fail({
      kind: 'mixed_currency',
      currencies: Array.from(currencies).sort(),
    });
  }
  return ok(undefined);
}

/**
 * Double-entry invariant. `SUM(debitMinor) === SUM(creditMinor)`
 * across every line in the journal. Computed in integer minor
 * units (the wire shape) to keep the check exact — Decimal is
 * unnecessary here because the integer cents ARE the canonical
 * representation on the wire.
 */
function checkBalanced(lines: readonly JournalLineInput[]): Result<void, PostJournalFailure> {
  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of lines) {
    debitTotal += line.debitMinor ?? 0;
    creditTotal += line.creditMinor ?? 0;
  }
  if (debitTotal !== creditTotal) {
    return fail({
      kind: 'journal_unbalanced',
      debitTotalMinor: debitTotal,
      creditTotalMinor: creditTotal,
    });
  }
  return ok(undefined);
}

/**
 * Resolve `accountCode → accountId` for every distinct code in
 * the request. Rejects unknown codes (`account_not_found`) and
 * retired/inactive accounts (`account_inactive`) — both
 * surface as a thrown `AccountResolutionError` so the
 * surrounding $transaction rolls back.
 */
async function resolveAccountIdsByCode(
  tx: PrismaTransactionClient,
  codes: readonly string[],
): Promise<Record<string, string>> {
  const distinct = Array.from(new Set(codes));
  const rows = await tx.chartOfAccount.findMany({
    where: { code: { in: distinct } },
    select: { id: true, code: true, active: true },
  });

  const found = new Map<string, { id: string; active: boolean }>();
  for (const row of rows) {
    found.set(row.code, { id: row.id, active: row.active });
  }

  const result: Record<string, string> = {};
  for (const code of distinct) {
    const row = found.get(code);
    if (row === undefined) {
      throw new AccountResolutionError({
        kind: 'account_not_found',
        accountCode: code,
      });
    }
    if (!row.active) {
      throw new AccountResolutionError({
        kind: 'account_inactive',
        accountCode: code,
      });
    }
    result[code] = row.id;
  }
  return result;
}

/**
 * Conversion between wire-shape integer minor units (cents) and
 * Prisma `Decimal(12,2)` dollars-and-cents.
 */
function minorToDecimal(minor: number): Decimal {
  return new Decimal(minor).div(100);
}

function decimalToMinor(d: Decimal): number {
  return Number(d.mul(100).toFixed(0));
}

/**
 * Coerce Prisma's runtime Decimal (or any decimal-string-compatible
 * value) into a `decimal.js` instance. Prisma's Decimal class is
 * structurally compatible at the `.toString()` level — the
 * canonical decimal representation round-trips losslessly.
 */
function anyToDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Decimal(value);
  }
  throw new Error(`journal-posting: unexpected non-Decimal value: ${String(value)}`);
}

/**
 * Hand-typed mirror of the Prisma row shape returned by
 * `ORIGINAL_FOR_REVERSAL_SELECT.lines`. TS-080-followup-3 / TS-021-
 * followup-2 capture the cleanup to a generated Prisma payload type
 * once the namespace value-side resolves.
 */
interface OriginalLineForReversal {
  readonly debit: unknown;
  readonly credit: unknown;
  readonly currency: string;
  readonly memo: string | null;
  readonly account: { readonly code: string };
}

const ORIGINAL_FOR_REVERSAL_SELECT = {
  id: true,
  sourceEventId: true,
  reversedByJournalId: true,
  lines: {
    select: {
      debit: true,
      credit: true,
      currency: true,
      memo: true,
      account: { select: { code: true } },
    },
  },
} as const;

export const JOURNAL_WITH_LINES_SELECT = {
  id: true,
  kind: true,
  occurredAt: true,
  postedAt: true,
  sourceEventId: true,
  description: true,
  periodId: true,
  period: { select: { id: true, name: true, status: true } },
  postedByUserId: true,
  reversedJournalId: true,
  reversedByJournalId: true,
  context: true,
  lines: {
    select: {
      id: true,
      accountId: true,
      debit: true,
      credit: true,
      currency: true,
      memo: true,
      account: { select: { code: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

class AccountResolutionError extends Error {
  constructor(public readonly failure: PostJournalFailure) {
    super(`account resolution failed: ${JSON.stringify(failure)}`);
    this.name = 'AccountResolutionError';
  }
}

class ClosedPeriodError extends Error {
  constructor(public readonly period: ResolvedAccountingPeriod) {
    super(`period ${period.name} is closed`);
    this.name = 'ClosedPeriodError';
  }
}

function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as {
    code?: unknown;
    name?: unknown;
    meta?: { target?: unknown };
  };
  if (candidate.code !== 'P2002' || candidate.name !== 'PrismaClientKnownRequestError') {
    return false;
  }
  const target = candidate.meta?.target;
  if (Array.isArray(target)) {
    return target.includes(column);
  }
  if (typeof target === 'string') {
    return target.includes(column);
  }
  return false;
}
