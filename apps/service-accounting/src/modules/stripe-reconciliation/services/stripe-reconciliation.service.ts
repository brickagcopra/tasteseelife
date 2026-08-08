import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STRIPE_RECONCILIATION_CHECKS_RANGE_MAX_ROWS,
  type StripeReconciliationCategory,
  type StripeReconciliationCheckRecord,
  type StripeReconciliationMode,
  type StripeReconciliationStatus,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  toStripeReconciliationCheckRecord,
  type StripeReconciliationCheckRow,
} from '../mappers/stripe-reconciliation.mapper';

import {
  aggregateToDecimal,
  dayWindowUtc,
  decimalToMinor,
  defaultReconciliationDayKey,
  minorToDecimal,
  utcDayKey,
} from './reconciliation-math';
import { StripeReportReader } from './stripe-report-reader.service';

/** Stable code of the Cash account in the seeded chart of accounts. */
const CASH_ACCOUNT_CODE = '1000';

/** Phase-1 reconciliation currency. */
const RECONCILIATION_CURRENCY = 'USD' as const;

/** The two reconciliation dimensions, in display order. */
const CATEGORIES: readonly StripeReconciliationCategory[] = ['balance', 'activity'];

/** Explicit column projection for check reads (no `SELECT *`). */
const CHECK_ROW_SELECT = {
  reconciliationDate: true,
  category: true,
  status: true,
  mode: true,
  currency: true,
  expectedAmount: true,
  actualAmount: true,
  deltaAmount: true,
  toleranceAmount: true,
  stripeTransactionCount: true,
  windowStart: true,
  windowEnd: true,
  detail: true,
  computedAt: true,
  resolvedAt: true,
  resolvedByUserId: true,
  resolutionNotes: true,
} as const;

export interface ReconcileInput {
  /** Explicit reconciliation target (ops back-fill). Omitted → yesterday. */
  readonly asOf?: Date | undefined;
  /** Injectable clock for the "yesterday" default. Defaults to `new Date()`. */
  readonly now?: Date | undefined;
}

export interface ReconcileOutput {
  readonly reconciliationDate: string;
  readonly mode: StripeReconciliationMode;
  readonly checks: readonly StripeReconciliationCheckRecord[];
  readonly openMismatchCount: number;
}

export interface ListChecksInput {
  readonly status?: StripeReconciliationStatus | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface ListChecksOutput {
  readonly checks: readonly StripeReconciliationCheckRecord[];
  readonly from: string | null;
  readonly to: string | null;
}

export interface ResolveCheckInput {
  readonly checkId: string;
  readonly actorUserId: string;
  readonly resolutionNotes: string;
  readonly now?: Date | undefined;
}

export type ResolveCheckResult =
  | { readonly ok: true; readonly check: StripeReconciliationCheckRecord }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_open' };

/**
 * Daily Stripe → ledger reconciliation (TS-261; PRD §10.3; PDD §11.2;
 * CLAUDE.md §6).
 *
 * For a UTC calendar day, runs two independent checks against the platform
 * ledger's Cash account (`1000`):
 *
 *   - `balance`  — Stripe's current reported balance (available + pending)
 *     vs. the ledger Cash net balance (all-time). A point-in-time "are we
 *     in sync right now" check.
 *   - `activity` — Stripe's net balance-transaction activity for the day
 *     vs. the ledger Cash net movement over the same UTC-day window.
 *
 * A check whose `|delta| > tolerance` lands as a `mismatch_open` ops
 * ticket. **The reconciliation NEVER mutates the ledger** (CLAUDE.md §6 —
 * "do not auto-correct silently"); an operator triages + resolves via the
 * admin surface.
 *
 * **Idempotent re-run.** Each `(reconciliation_date, category)` row is
 * upserted: a re-run refreshes figures + `computed_at` and recomputes
 * status, but a `mismatch_resolved` row that still mismatches is NOT
 * silently reopened — the human decision is preserved. A row that newly
 * matches clears any prior resolution.
 *
 * **Stub mode.** When no live Stripe secret key is configured (Phase 1),
 * the reader returns null and each check is recorded as `skipped_stub`
 * (mode `stub`) carrying the ledger figure with null Stripe figures — no
 * ticket. Live SDK wiring is TS-261-followup-1.
 */
@Injectable()
export class StripeReconciliationService {
  private readonly logger = new Logger(StripeReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: StripeReportReader,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  async reconcile(input: ReconcileInput = {}): Promise<ReconcileOutput> {
    const now = input.now ?? new Date();
    const dayKey =
      input.asOf !== undefined ? utcDayKey(input.asOf) : defaultReconciliationDayKey(now);
    const window = dayWindowUtc(dayKey);
    const toleranceMinor = this.env.STRIPE_RECONCILIATION_TOLERANCE_MINOR;

    const cashAccountId = await this.resolveCashAccountId();

    const ledgerBalanceMinor = await this.cashNetMinor(cashAccountId, {});
    const ledgerMovementMinor = await this.cashNetMinor(cashAccountId, {
      journal: { occurredAt: { gte: window.start, lt: window.end } },
    });

    const stripeReport = await this.reader.read({
      start: window.start,
      end: window.end,
      currency: RECONCILIATION_CURRENCY,
    });
    const mode: StripeReconciliationMode = stripeReport === null ? 'stub' : 'live';

    const checks: StripeReconciliationCheckRecord[] = [];
    let openMismatchCount = 0;

    for (const category of CATEGORIES) {
      const expectedMinor = category === 'balance' ? ledgerBalanceMinor : ledgerMovementMinor;

      const actualMinor =
        stripeReport === null
          ? null
          : category === 'balance'
            ? stripeReport.balanceMinor
            : stripeReport.activityNetMinor;
      const stripeTxnCount =
        stripeReport === null || category === 'balance' ? null : stripeReport.transactionCount;

      const record = await this.upsertCheck({
        dayKey,
        window,
        category,
        mode,
        expectedMinor,
        actualMinor,
        toleranceMinor,
        stripeTxnCount,
        now,
      });
      checks.push(record);
      if (record.status === 'mismatch_open') openMismatchCount += 1;
    }

    this.logger.log(
      {
        reconciliationDate: dayKey,
        mode,
        openMismatchCount,
        ledgerBalanceMinor,
        ledgerMovementMinor,
        toleranceMinor,
      },
      openMismatchCount > 0 ? 'stripe-reconciliation.run.mismatch' : 'stripe-reconciliation.run.ok',
    );

    return { reconciliationDate: dayKey, mode, checks, openMismatchCount };
  }

  async listChecks(input: ListChecksInput): Promise<ListChecksOutput> {
    const where: Record<string, unknown> = {};
    if (input.status !== undefined) where['status'] = input.status;
    const dateFilter: Record<string, Date> = {};
    if (input.from !== undefined) dateFilter['gte'] = dayWindowUtc(input.from).start;
    if (input.to !== undefined) dateFilter['lte'] = dayWindowUtc(input.to).start;
    if (Object.keys(dateFilter).length > 0) where['reconciliationDate'] = dateFilter;

    const rows = (await this.prisma.stripeReconciliationCheck.findMany({
      where,
      orderBy: [{ reconciliationDate: 'desc' }, { category: 'asc' }],
      take: STRIPE_RECONCILIATION_CHECKS_RANGE_MAX_ROWS,
      select: CHECK_ROW_SELECT,
    })) as readonly StripeReconciliationCheckRow[];

    const checks = rows.map(toStripeReconciliationCheckRecord);
    // Rows are newest-first: the first is the latest date (`to`), the last
    // is the earliest (`from`). Echo the EFFECTIVE window.
    const to = checks.length > 0 ? checks[0]!.reconciliationDate : null;
    const from = checks.length > 0 ? checks[checks.length - 1]!.reconciliationDate : null;

    return { checks, from, to };
  }

  async resolveCheck(input: ResolveCheckInput): Promise<ResolveCheckResult> {
    const now = input.now ?? new Date();
    const existing = (await this.prisma.stripeReconciliationCheck.findUnique({
      where: { id: input.checkId },
      select: { id: true, status: true },
    })) as { id: string; status: StripeReconciliationStatus } | null;

    if (existing === null) return { ok: false, reason: 'not_found' };
    if (existing.status !== 'mismatch_open') return { ok: false, reason: 'not_open' };

    const updated = (await this.prisma.stripeReconciliationCheck.update({
      where: { id: input.checkId },
      data: {
        status: 'mismatch_resolved',
        resolvedAt: now,
        resolvedByUserId: input.actorUserId,
        resolutionNotes: input.resolutionNotes,
      },
      select: CHECK_ROW_SELECT,
    })) as StripeReconciliationCheckRow;

    this.logger.warn(
      { checkId: input.checkId, actorId: input.actorUserId },
      'stripe-reconciliation.check.resolved',
    );

    return { ok: true, check: toStripeReconciliationCheckRecord(updated) };
  }

  /**
   * Upsert one `(reconciliation_date, category)` check, computing the status
   * from the figures while preserving a prior human resolution.
   */
  private async upsertCheck(args: {
    readonly dayKey: string;
    readonly window: { start: Date; end: Date };
    readonly category: StripeReconciliationCategory;
    readonly mode: StripeReconciliationMode;
    readonly expectedMinor: number;
    readonly actualMinor: number | null;
    readonly toleranceMinor: number;
    readonly stripeTxnCount: number | null;
    readonly now: Date;
  }): Promise<StripeReconciliationCheckRecord> {
    const { window, category, mode, expectedMinor, actualMinor, toleranceMinor } = args;

    const existing = (await this.prisma.stripeReconciliationCheck.findUnique({
      where: {
        reconciliation_date_category_unique: {
          reconciliationDate: window.start,
          category,
        },
      },
      select: {
        status: true,
        resolvedAt: true,
        resolvedByUserId: true,
        resolutionNotes: true,
      },
    })) as {
      status: StripeReconciliationStatus;
      resolvedAt: Date | null;
      resolvedByUserId: string | null;
      resolutionNotes: string | null;
    } | null;

    const deltaMinor = actualMinor === null ? null : actualMinor - expectedMinor;
    const matched = deltaMinor !== null && Math.abs(deltaMinor) <= toleranceMinor;

    let status: StripeReconciliationStatus;
    let preserveResolution = false;
    if (actualMinor === null) {
      status = 'skipped_stub';
    } else if (matched) {
      status = 'matched';
    } else if (existing?.status === 'mismatch_resolved') {
      // A previously human-resolved ticket that STILL mismatches keeps its
      // resolution — never silently reopen a human decision (CLAUDE.md §6).
      status = 'mismatch_resolved';
      preserveResolution = true;
    } else {
      status = 'mismatch_open';
    }

    const detail = buildDetail({
      category,
      mode,
      status,
      expectedMinor,
      actualMinor,
      deltaMinor,
      toleranceMinor,
      stripeTxnCount: args.stripeTxnCount,
    });

    const resolution =
      preserveResolution && existing !== null
        ? {
            resolvedAt: existing.resolvedAt,
            resolvedByUserId: existing.resolvedByUserId,
            resolutionNotes: existing.resolutionNotes,
          }
        : { resolvedAt: null, resolvedByUserId: null, resolutionNotes: null };

    const writeFields = {
      status,
      mode,
      currency: RECONCILIATION_CURRENCY,
      expectedAmount: minorToDecimalString(expectedMinor),
      actualAmount: actualMinor === null ? null : minorToDecimalString(actualMinor),
      deltaAmount: deltaMinor === null ? null : minorToDecimalString(deltaMinor),
      toleranceAmount: minorToDecimalString(toleranceMinor),
      stripeTransactionCount: args.stripeTxnCount,
      windowStart: window.start,
      windowEnd: window.end,
      detail,
      computedAt: args.now,
      ...resolution,
    };

    const row = (await this.prisma.stripeReconciliationCheck.upsert({
      where: {
        reconciliation_date_category_unique: {
          reconciliationDate: window.start,
          category,
        },
      },
      create: { reconciliationDate: window.start, category, ...writeFields },
      update: writeFields,
      select: CHECK_ROW_SELECT,
    })) as StripeReconciliationCheckRow;

    return toStripeReconciliationCheckRecord(row);
  }

  private async resolveCashAccountId(): Promise<string> {
    const account = (await this.prisma.chartOfAccount.findUnique({
      where: { code: CASH_ACCOUNT_CODE },
      select: { id: true },
    })) as { id: string } | null;
    if (account === null) {
      throw new Error(
        `stripe-reconciliation: Cash account (code ${CASH_ACCOUNT_CODE}) not found — run seed:chart-of-accounts`,
      );
    }
    return account.id;
  }

  /** Net `debit − credit` (minor units) on the Cash account for a where filter. */
  private async cashNetMinor(
    cashAccountId: string,
    extraWhere: Record<string, unknown>,
  ): Promise<number> {
    const agg = (await this.prisma.journalLine.aggregate({
      _sum: { debit: true, credit: true },
      where: { accountId: cashAccountId, currency: RECONCILIATION_CURRENCY, ...extraWhere },
    })) as { _sum: { debit: unknown; credit: unknown } };
    const debit = aggregateToDecimal(agg._sum.debit as { toString(): string } | null);
    const credit = aggregateToDecimal(agg._sum.credit as { toString(): string } | null);
    return decimalToMinor(debit.minus(credit));
  }
}

/**
 * `minor / 100` as a fixed-2 string — used both for Prisma `Decimal(12,2)`
 * writes and for the human-readable `detail` (USD amount rendering).
 */
function minorToDecimalString(minor: number): string {
  return minorToDecimal(minor).toFixed(2);
}

const formatMinor = minorToDecimalString;

/** Build the human-readable check `detail` summary. */
function buildDetail(args: {
  readonly category: StripeReconciliationCategory;
  readonly mode: StripeReconciliationMode;
  readonly status: StripeReconciliationStatus;
  readonly expectedMinor: number;
  readonly actualMinor: number | null;
  readonly deltaMinor: number | null;
  readonly toleranceMinor: number;
  readonly stripeTxnCount: number | null;
}): string {
  const dimension =
    args.category === 'balance'
      ? 'Stripe balance vs ledger Cash balance'
      : 'Stripe day activity vs ledger Cash movement';

  if (args.mode === 'stub') {
    return `${dimension}: Stripe not queried (stub mode). Ledger figure USD ${formatMinor(
      args.expectedMinor,
    )}; reconciliation skipped until a live Stripe key is configured (TS-261-followup-1).`;
  }

  const actual = args.actualMinor ?? 0;
  const delta = args.deltaMinor ?? 0;
  const txnSuffix =
    args.stripeTxnCount !== null ? ` across ${args.stripeTxnCount} Stripe transaction(s)` : '';
  const verdict =
    args.status === 'matched'
      ? `within tolerance (USD ${formatMinor(args.toleranceMinor)})`
      : args.status === 'mismatch_resolved'
        ? `MISMATCH (operator-resolved; still diverging)`
        : `MISMATCH — exceeds tolerance (USD ${formatMinor(args.toleranceMinor)})`;

  return `${dimension}${txnSuffix}: expected USD ${formatMinor(
    args.expectedMinor,
  )}, Stripe USD ${formatMinor(actual)}, delta USD ${formatMinor(delta)} — ${verdict}.`;
}
