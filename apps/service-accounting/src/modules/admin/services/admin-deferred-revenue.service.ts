import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the `accounting.deferred_revenue_customer_group` enum.
 * Declared rather than imported for the TS-021-followup-2 / TS-303c2d
 * reason repeated across this codebase — `@prisma/client` resolves to the
 * root stub during a service's own type-check, so the generated
 * namespace's value side is not reliably available and an un-annotated
 * read-path projection silently degrades to `any`.
 */
type DeferredRevenueCustomerGroupValue = 'family' | 'provider' | 'academy';

interface DecimalLike {
  toString(): string;
}

export interface ListPausedBalancesInput {
  /** Instant every age + `pastServicePeriodEnd` is measured against. */
  readonly asOf: Date;
  /** Caps the enumeration ONLY. The summary counts are never capped. */
  readonly limit: number;
}

export interface PausedBalanceRow {
  readonly balanceId: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly customerGroup: DeferredRevenueCustomerGroupValue;
  readonly planCode: string;
  readonly currency: string;
  readonly pausedAt: Date | null;
  /** Null exactly when `pausedAt` is null — an unknown clock has no age. */
  readonly pausedForSeconds: number | null;
  readonly priorPausedSeconds: number;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly pastServicePeriodEnd: boolean;
  readonly originalAmountMinor: number;
  readonly recognizedAmountMinor: number;
  readonly remainingDeferredMinor: number;
}

export interface PausedBalancesSummary {
  readonly pausedCount: number;
  readonly pastServicePeriodEndCount: number;
  readonly unknownPausedAtCount: number;
  readonly oldestPausedAt: Date | null;
  readonly totalRemainingDeferredMinor: number;
}

export interface PausedBalancesView {
  readonly asOf: Date;
  readonly summary: PausedBalancesSummary;
  readonly balances: readonly PausedBalanceRow[];
  readonly truncated: boolean;
}

const MS_PER_SECOND = 1_000;

/**
 * Persisted projection. Hand-typed for the same reason as the local enum
 * mirror above.
 */
const PAUSED_BALANCE_SELECT = {
  id: true,
  subscriptionId: true,
  customerId: true,
  customerGroup: true,
  planCode: true,
  currency: true,
  pausedAt: true,
  pausedDurationSeconds: true,
  servicePeriodStart: true,
  servicePeriodEnd: true,
  originalAmount: true,
  recognizedAmount: true,
} as const;

interface PersistedPausedBalanceRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly customerGroup: DeferredRevenueCustomerGroupValue;
  readonly planCode: string;
  readonly currency: string;
  readonly pausedAt: Date | null;
  readonly pausedDurationSeconds: number;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly originalAmount: DecimalLike;
  readonly recognizedAmount: DecimalLike;
}

/**
 * Ops read over suspended deferred-revenue balances
 * (TS-042-followup-3b2-followup-2a).
 *
 * **Why this exists.** `accounting_recognition_pause_total{operation,result}`
 * (TS-042-followup-3b2-followup-2) is a FLOW: comparing its `pause` and
 * `resume` series over time reveals a divergence, but it cannot name the
 * affected balances, cannot say how long they have been suspended, and
 * cannot answer "is anything stuck right now" at all after a pod restart.
 * This is the STOCK measure — the same question asked of the rows.
 *
 * **Why the counts and the enumeration are separate queries.** The counts
 * are computed over every paused row and the enumeration is capped. A
 * surface whose total stopped at the page boundary would answer "how much
 * revenue is stranded" with "at most one page's worth", which is the same
 * class of quiet untruth as a partial export shipping as a smaller ZIP
 * (TS-309b). Mirrors the overdue-DSAR sweep (TS-309a-followup-2), which
 * split them for exactly this reason.
 *
 * **Ordering: `pausedAt ASC NULLS FIRST, id ASC`.** Longest-suspended
 * first is the ops queue. Nulls sort ABOVE everything because a `paused`
 * row with no `pausedAt` is the worst case here, not the newest: its age
 * is unknowable, so its suspension can never be shown to have run too
 * long, and `resumeRecognition` will credit it zero suspended seconds.
 * The `id` tiebreak is load-bearing — `pausedAt` is not unique (a batch of
 * pauses from one Stripe backfill shares an instant).
 *
 * **`pastServicePeriodEnd` is the one threshold that needs no product
 * confirmation.** Every other threshold shipped on this platform is an
 * unconfirmed constant (TS-300's SLA budgets, TS-308a's speed ceiling);
 * this one comes off the row. A resume EXTENDS `servicePeriodEnd` by the
 * suspended duration, so while a balance is still paused that column
 * carries its un-extended value: once it is in the past, the pause has
 * outlasted the whole period the customer paid for. That is the shape of
 * the TS-042-followup-3b2-followup-1 defect.
 *
 * **Currency is deliberately NOT filtered.** Phase 1 is USD-only — the
 * column defaults to it and the recogniser's output type is the literal
 * `'USD'` — so `totalRemainingDeferredMinor` is a single-currency sum. If
 * a non-USD row ever appears, the contract's USD-only enum fails the
 * response parse and the surface breaks loudly. That is the intended
 * outcome: on a financial surface a visible failure beats a total that is
 * quietly wrong, and filtering to USD would instead hide the row from the
 * one queue meant to find stranded revenue.
 */
@Injectable()
export class AdminDeferredRevenueService {
  private readonly logger = new Logger(AdminDeferredRevenueService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The uncapped stock measure on its own. Split out from `listPaused`
   * because the observable gauge (`PausedBalanceGauge`) wants exactly this
   * and none of the enumeration.
   */
  async summarizePaused(asOf: Date): Promise<PausedBalancesSummary> {
    const [pausedCount, pastServicePeriodEndCount, unknownPausedAtCount, totals] =
      await Promise.all([
        this.prisma.deferredRevenueBalance.count({ where: { status: 'paused' } }),
        this.prisma.deferredRevenueBalance.count({
          where: { status: 'paused', servicePeriodEnd: { lt: asOf } },
        }),
        this.prisma.deferredRevenueBalance.count({
          where: { status: 'paused', pausedAt: null },
        }),
        this.prisma.deferredRevenueBalance.aggregate({
          where: { status: 'paused' },
          _sum: { originalAmount: true, recognizedAmount: true },
          _min: { pausedAt: true },
        }),
      ]);

    // `SUM(original) - SUM(recognized)` is identical to
    // `SUM(original - recognized)` and keeps the arithmetic in Decimal —
    // Prisma's aggregate cannot sum an expression, and CLAUDE.md §17.6
    // forbids doing it in `Number`.
    const originalTotal = toDecimal(totals._sum.originalAmount);
    const recognizedTotal = toDecimal(totals._sum.recognizedAmount);

    return {
      pausedCount,
      pastServicePeriodEndCount,
      unknownPausedAtCount,
      // Postgres `MIN` skips NULLs, which is what "oldest KNOWN pause"
      // means. `unknownPausedAtCount` is what tells the reader how much of
      // the queue this number can speak for.
      oldestPausedAt: totals._min.pausedAt ?? null,
      totalRemainingDeferredMinor: decimalToMinor(
        clampNonNegative(originalTotal.minus(recognizedTotal)),
      ),
    };
  }

  async listPaused(input: ListPausedBalancesInput): Promise<PausedBalancesView> {
    const { asOf, limit } = input;

    const summary = await this.summarizePaused(asOf);

    const rows = (await this.prisma.deferredRevenueBalance.findMany({
      where: { status: 'paused' },
      select: PAUSED_BALANCE_SELECT,
      orderBy: [{ pausedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit,
    })) as readonly PersistedPausedBalanceRow[];

    const balances = rows.map((row) => this.toRow(row, asOf));

    // INFO on every read, including the all-clear one: an operator asking
    // "was anything stuck when the alert fired" needs the zero as much as
    // the non-zero (the absent-series-vs-zero-series rule from
    // TS-510-followup-1). No customer id, no subscription id, no amount per
    // row — the aggregate is the observable, the rows are the response.
    this.logger.log(
      {
        asOf: asOf.toISOString(),
        pausedCount: summary.pausedCount,
        pastServicePeriodEndCount: summary.pastServicePeriodEndCount,
        unknownPausedAtCount: summary.unknownPausedAtCount,
        totalRemainingDeferredMinor: summary.totalRemainingDeferredMinor,
        returnedCount: balances.length,
      },
      'accounting.deferred-revenue.paused.listed',
    );

    return {
      asOf,
      summary,
      balances,
      // Stated from the uncapped count, not inferred from the array length
      // — a full page and a truncated page are the same length.
      truncated: summary.pausedCount > balances.length,
    };
  }

  private toRow(row: PersistedPausedBalanceRow, asOf: Date): PausedBalanceRow {
    const original = toDecimal(row.originalAmount);
    const recognized = toDecimal(row.recognizedAmount);

    return {
      balanceId: row.id,
      subscriptionId: row.subscriptionId,
      customerId: row.customerId,
      customerGroup: row.customerGroup,
      planCode: row.planCode,
      currency: row.currency,
      pausedAt: row.pausedAt,
      pausedForSeconds: pausedForSeconds(row.pausedAt, asOf),
      priorPausedSeconds: row.pausedDurationSeconds,
      servicePeriodStart: row.servicePeriodStart,
      servicePeriodEnd: row.servicePeriodEnd,
      pastServicePeriodEnd: row.servicePeriodEnd.getTime() < asOf.getTime(),
      originalAmountMinor: decimalToMinor(original),
      recognizedAmountMinor: decimalToMinor(recognized),
      remainingDeferredMinor: decimalToMinor(clampNonNegative(original.minus(recognized))),
    };
  }
}

/**
 * Age of the CURRENT pause window, truncated to whole seconds.
 *
 * Null for a row with no `pausedAt` — reporting `0` would render the one
 * row whose age cannot be established as the freshest on a queue sorted by
 * age, which is exactly backwards.
 *
 * Clamped at zero: `asOf` is caller-supplied and clocks skew, and a
 * negative duration is neither representable on the contract nor
 * meaningful to a reader.
 */
function pausedForSeconds(pausedAt: Date | null, asOf: Date): number | null {
  if (pausedAt === null) return null;
  const elapsed = Math.trunc((asOf.getTime() - pausedAt.getTime()) / MS_PER_SECOND);
  return elapsed > 0 ? elapsed : 0;
}

/**
 * `recognized_amount` can never exceed `original_amount` by construction
 * (the recogniser clamps), but the response field is non-negative on the
 * contract and a clamp here keeps a corrupt row from turning a read into a
 * 500 for every operator on the queue.
 */
function clampNonNegative(value: Decimal): Decimal {
  return value.isNegative() ? new Decimal(0) : value;
}

function toDecimal(value: DecimalLike | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  return new Decimal(value.toString());
}

function decimalToMinor(value: Decimal): number {
  return Number(value.mul(100).toFixed(0));
}
