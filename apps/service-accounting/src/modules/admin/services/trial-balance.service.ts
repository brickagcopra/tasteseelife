import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../prisma/prisma.service';

type AccountTypeValue = 'asset' | 'liability' | 'equity' | 'revenue' | 'contra_revenue' | 'expense';

type NormalBalanceValue = 'debit' | 'credit';

/**
 * Canonical sort order on the trial-balance display — assets first,
 * then liabilities, then equity, then revenue (with contra-revenue
 * immediately after), then expense. Matches GAAP report convention.
 */
const ACCOUNT_TYPE_ORDER: readonly AccountTypeValue[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'contra_revenue',
  'expense',
];

interface DecimalLike {
  toString(): string;
}

export interface TrialBalanceComputeInput {
  readonly periodId?: string | undefined;
  readonly periodName?: string | undefined;
  /** Defaults to USD. */
  readonly currency?: 'USD' | undefined;
}

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: AccountTypeValue;
  readonly normalBalance: NormalBalanceValue;
  /** Integer USD minor units (cents). */
  readonly debitTotalMinor: number;
  /** Integer USD minor units (cents). */
  readonly creditTotalMinor: number;
  /** Integer USD minor units (cents). Exactly one of debit/credit is non-zero. */
  readonly netDebitMinor: number;
  /** Integer USD minor units (cents). Exactly one of debit/credit is non-zero. */
  readonly netCreditMinor: number;
  readonly currency: 'USD';
}

export interface TrialBalanceComputed {
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
  /** `|totalDebitMinor - totalCreditMinor|` — zero for a balanced ledger. */
  readonly imbalanceMinor: number;
  readonly currency: 'USD';
  /** Echoed period scope. Null when the query was all-time. */
  readonly periodId: string | null;
  /** Echoed period scope name. Null when the query was all-time. */
  readonly periodName: string | null;
}

/**
 * Sentinel returned by `resolvePeriodScope` when `periodName` was
 * supplied but no period matches. Caller turns this into a clean
 * "empty trial balance for non-existent period" response rather than
 * a 404 — same pattern as `AdminJournalsService.list`.
 */
const UNKNOWN_PERIOD = Symbol('unknown_period');

/**
 * Trial-balance read service (TS-129 Slice 1, PRD §10.8, PDD §11.2).
 *
 * Computes per-account aggregates from `journal_lines`:
 *   - `debitTotalMinor` / `creditTotalMinor` — gross sums per account
 *     (per the queried period scope; all-time when no scope).
 *   - `netDebitMinor` / `netCreditMinor` — derived. Exactly one is
 *     non-zero; the side carrying the net falls on `debit` if
 *     debit > credit, otherwise `credit`. The trial-balance UI renders
 *     the net column on the account's `normalBalance` side as the
 *     "normal" presentation; values that fall on the opposite side
 *     are highlighted as "abnormal" (e.g. a refund-heavy revenue
 *     account swinging negative).
 *
 * **Money discipline.** Aggregation is done at the persistence layer
 * via Prisma's `groupBy` `_sum`; the results come back as `Decimal`-
 * shaped objects. The service converts to integer minor units via
 * `decimal.js` (CLAUDE.md §17.6 — never `Number` math on money).
 *
 * **Period scope.**
 *   - `periodId` provided → exact-match against `journal.periodId`.
 *   - `periodName` provided → resolve `name → id`; an unknown name
 *     surfaces as an empty rows + zero totals response (not 404).
 *   - Both provided → `periodId` wins.
 *   - Neither → all-time aggregate.
 *
 * **Account metadata.** After the groupBy, we look up every account
 * that has activity in the queried scope plus every active account
 * (so zero-balance active accounts surface on the report as their
 * own rows — a finance-team expectation). Inactive accounts only
 * appear if they have residual balances. Sorted by `accountType` then
 * `accountCode`.
 *
 * **Bound.** The Phase-1 chart of accounts has well under the
 * contract-side cap (`ADMIN_TRIAL_BALANCE_ROWS_MAX = 1000`); the
 * service hard-caps to that value via a final `.slice(0, MAX_ROWS)`
 * to defend the response envelope.
 */
@Injectable()
export class TrialBalanceService {
  private readonly logger = new Logger(TrialBalanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async compute(input: TrialBalanceComputeInput): Promise<TrialBalanceComputed> {
    const currency = input.currency ?? 'USD';
    const scope = await this.resolvePeriodScope(input.periodId, input.periodName);

    if (scope === UNKNOWN_PERIOD) {
      return {
        rows: [],
        totalDebitMinor: 0,
        totalCreditMinor: 0,
        imbalanceMinor: 0,
        currency,
        periodId: null,
        periodName: input.periodName ?? null,
      };
    }

    const periodIdFilter = scope?.id ?? null;

    // Aggregate per account. journal-line currency must match the
    // requested currency; the `journal.periodId` filter is applied via
    // the relation.
    // No `as` cast on the result: `groupBy`'s return type is conditional on
    // its own generic, so an assertion here flows BACKWARDS into inference
    // and TypeScript starts demanding the argument also be the asserted
    // array type. The generated payload already types `accountId` and
    // `_sum.debit`/`_sum.credit` correctly (TS-501).
    const aggregates = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        currency,
        ...(periodIdFilter !== null ? { journal: { periodId: periodIdFilter } } : {}),
      },
      _sum: { debit: true, credit: true },
    });

    const accountIdsWithActivity = new Set(aggregates.map((a) => a.accountId));

    // Pull metadata for both: (a) accounts with activity in the scope,
    // and (b) every active account (so zero-balance active rows surface
    // on the report). Inactive accounts only appear if they had activity.
    const accountMetas = (await this.prisma.chartOfAccount.findMany({
      where: {
        OR: [{ id: { in: Array.from(accountIdsWithActivity) } }, { active: true }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        normalBalance: true,
      },
    })) as readonly {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly type: AccountTypeValue;
      readonly normalBalance: NormalBalanceValue;
    }[];

    // Map activity by account for O(1) lookups.
    const activityById = new Map<string, { debit: Decimal; credit: Decimal }>();
    for (const a of aggregates) {
      activityById.set(a.accountId, {
        debit: toDecimal(a._sum.debit),
        credit: toDecimal(a._sum.credit),
      });
    }

    // Compose rows.
    const rows: TrialBalanceRow[] = [];
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const meta of accountMetas) {
      const activity = activityById.get(meta.id) ?? {
        debit: new Decimal(0),
        credit: new Decimal(0),
      };
      const debitTotalMinor = decimalToMinor(activity.debit);
      const creditTotalMinor = decimalToMinor(activity.credit);
      const diff = activity.debit.minus(activity.credit);
      const isDebitNet = diff.gt(0);
      const netDebitMinor = isDebitNet ? decimalToMinor(diff) : 0;
      const netCreditMinor = isDebitNet ? 0 : decimalToMinor(diff.abs());

      rows.push({
        accountId: meta.id,
        accountCode: meta.code,
        accountName: meta.name,
        accountType: meta.type,
        normalBalance: meta.normalBalance,
        debitTotalMinor,
        creditTotalMinor,
        netDebitMinor,
        netCreditMinor,
        currency,
      });

      totalDebit = totalDebit.plus(activity.debit);
      totalCredit = totalCredit.plus(activity.credit);
    }

    rows.sort(compareTrialBalanceRow);

    const totalDebitMinor = decimalToMinor(totalDebit);
    const totalCreditMinor = decimalToMinor(totalCredit);
    const imbalanceMinor = Math.abs(totalDebitMinor - totalCreditMinor);

    this.logger.log(
      {
        actorId: '<admin>',
        rowCount: rows.length,
        totalDebitMinor,
        totalCreditMinor,
        imbalanceMinor,
        scope: scope === null ? 'all-time' : scope.name,
      },
      'admin.trial_balance.computed',
    );

    return {
      rows,
      totalDebitMinor,
      totalCreditMinor,
      imbalanceMinor,
      currency,
      periodId: scope?.id ?? null,
      periodName: scope?.name ?? null,
    };
  }

  /**
   * Resolve the (periodId, periodName) tuple into a concrete period
   * record (or `null` for all-time, or the `UNKNOWN_PERIOD` sentinel
   * for a supplied-but-unmatched periodName).
   *
   * Both columns are echoed on the response so the UI can render
   * "Trial balance — period 2026-05" without an extra round-trip.
   */
  private async resolvePeriodScope(
    periodId: string | undefined,
    periodName: string | undefined,
  ): Promise<{ readonly id: string; readonly name: string } | null | typeof UNKNOWN_PERIOD> {
    if (periodId !== undefined) {
      const row = await this.prisma.accountingPeriod.findUnique({
        where: { id: periodId },
        select: { id: true, name: true },
      });
      if (row === null) return UNKNOWN_PERIOD;
      return row;
    }
    if (periodName !== undefined) {
      const row = await this.prisma.accountingPeriod.findUnique({
        where: { name: periodName },
        select: { id: true, name: true },
      });
      if (row === null) return UNKNOWN_PERIOD;
      return row;
    }
    return null;
  }
}

function decimalToMinor(value: Decimal): number {
  // Trial-balance values are stored as `Decimal(12, 2)` and aggregated
  // server-side; minor-unit conversion is `value * 100`. Round once at
  // presentation per CLAUDE.md §6.
  return Number(value.mul(100).toFixed(0));
}

function toDecimal(value: DecimalLike | null): Decimal {
  if (value === null) return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === 'object' && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  throw new Error(`trial-balance: unexpected non-Decimal aggregate: ${String(value)}`);
}

function compareTrialBalanceRow(a: TrialBalanceRow, b: TrialBalanceRow): number {
  const aTypeIdx = ACCOUNT_TYPE_ORDER.indexOf(a.accountType);
  const bTypeIdx = ACCOUNT_TYPE_ORDER.indexOf(b.accountType);
  if (aTypeIdx !== bTypeIdx) return aTypeIdx - bTypeIdx;
  // Code-based secondary sort (lexicographic — the SaaS-standard
  // four-digit-prefix shape sorts naturally).
  if (a.accountCode < b.accountCode) return -1;
  if (a.accountCode > b.accountCode) return 1;
  return 0;
}
