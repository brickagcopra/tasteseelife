import { Injectable, Logger } from '@nestjs/common';
import {
  SAAS_METRICS_RANGE_MAX_ROWS,
  type ListSaasMetricsResponse,
  type SaasMetricsRecord,
} from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  asDecimal,
  computeArpu,
  decimalToMinor,
  decomposeMovement,
  normalizeMonthlyMrr,
  ratioToPpm,
  toUtcDateOnly,
  utcDateKey,
} from './saas-metrics-math';

type CustomerGroup = 'family' | 'provider' | 'academy';

/**
 * Slim projection of `DeferredRevenueBalance` consumed by the metrics
 * computation. Only the columns the MRR roll-up needs are selected
 * (CLAUDE.md §4.1 — no `SELECT *`).
 */
interface ActiveBalanceRow {
  readonly subscriptionId: string;
  readonly customerGroup: CustomerGroup;
  readonly planCode: string;
  readonly originalAmount: unknown;
  readonly currency: string;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  /**
   * Accumulated suspended seconds (TS-042-followup-3b2). Netted off the
   * period so a resumed subscription's extended `servicePeriodEnd` does
   * not read as a contraction.
   */
  readonly pausedDurationSeconds: number;
}

interface PerSubscriptionMrr {
  customerGroup: CustomerGroup;
  planCode: string;
  mrr: Decimal;
}

export interface ComputeSaasMetricsOutput {
  readonly metrics: SaasMetricsRecord;
  readonly subscriptionsSnapshotted: number;
}

const ACTIVE_BALANCE_SELECT = {
  subscriptionId: true,
  customerGroup: true,
  planCode: true,
  originalAmount: true,
  currency: true,
  servicePeriodStart: true,
  servicePeriodEnd: true,
  pausedDurationSeconds: true,
} as const;

/**
 * Explicit projection of `SaasMetricsDaily` for the dashboard read
 * (TS-266) — no `SELECT *` (CLAUDE.md §4.1). Every column the
 * `SaasMetricsRecord` wire shape needs, nothing more.
 */
const METRICS_ROW_SELECT = {
  metricDate: true,
  currency: true,
  mrr: true,
  arr: true,
  arpu: true,
  activeSubscriptions: true,
  newMrr: true,
  expansionMrr: true,
  contractionMrr: true,
  churnedMrr: true,
  churnedSubscriptions: true,
  netNewMrr: true,
  priorMrr: true,
  netRevenueRetention: true,
  grossRevenueRetention: true,
  ltv: true,
  cac: true,
  comparisonDate: true,
  computedAt: true,
} as const;

/**
 * Slim row shape returned by the `METRICS_ROW_SELECT` projection. Decimal
 * columns arrive as Prisma `Decimal` (typed `unknown` + coerced through
 * `asDecimal`, matching the `ActiveBalanceRow` precedent above).
 */
interface SaasMetricsDailyRow {
  readonly metricDate: Date;
  readonly currency: string;
  readonly mrr: unknown;
  readonly arr: unknown;
  readonly arpu: unknown;
  readonly activeSubscriptions: number;
  readonly newMrr: unknown;
  readonly expansionMrr: unknown;
  readonly contractionMrr: unknown;
  readonly churnedMrr: unknown;
  readonly churnedSubscriptions: number;
  readonly netNewMrr: unknown;
  readonly priorMrr: unknown;
  readonly netRevenueRetention: unknown | null;
  readonly grossRevenueRetention: unknown | null;
  readonly ltv: unknown | null;
  readonly cac: unknown | null;
  readonly comparisonDate: Date | null;
  readonly computedAt: Date;
}

/**
 * Map a persisted daily row to the `SaasMetricsRecord` wire shape — the
 * read-side inverse of the `computeForDate` write. Decimals become integer
 * minor units (cents); retention ratios become integer parts-per-million;
 * dates become `YYYY-MM-DD` UTC keys. Mirrors the projection
 * `computeForDate` builds inline so the compute + read surfaces agree
 * exactly on the wire shape.
 */
function toSaasMetricsRecord(row: SaasMetricsDailyRow): SaasMetricsRecord {
  return {
    metricDate: utcDateKey(row.metricDate),
    currency: row.currency as SaasMetricsRecord['currency'],
    mrrMinor: decimalToMinor(asDecimal(row.mrr)),
    arrMinor: decimalToMinor(asDecimal(row.arr)),
    arpuMinor: decimalToMinor(asDecimal(row.arpu)),
    activeSubscriptions: row.activeSubscriptions,
    newMrrMinor: decimalToMinor(asDecimal(row.newMrr)),
    expansionMrrMinor: decimalToMinor(asDecimal(row.expansionMrr)),
    contractionMrrMinor: decimalToMinor(asDecimal(row.contractionMrr)),
    churnedMrrMinor: decimalToMinor(asDecimal(row.churnedMrr)),
    churnedSubscriptions: row.churnedSubscriptions,
    netNewMrrMinor: decimalToMinor(asDecimal(row.netNewMrr)),
    priorMrrMinor: decimalToMinor(asDecimal(row.priorMrr)),
    netRevenueRetentionPpm:
      row.netRevenueRetention === null ? null : ratioToPpm(asDecimal(row.netRevenueRetention)),
    grossRevenueRetentionPpm:
      row.grossRevenueRetention === null ? null : ratioToPpm(asDecimal(row.grossRevenueRetention)),
    ltvMinor: row.ltv === null ? null : decimalToMinor(asDecimal(row.ltv)),
    cacMinor: row.cac === null ? null : decimalToMinor(asDecimal(row.cac)),
    comparisonDate: row.comparisonDate === null ? null : utcDateKey(row.comparisonDate),
    computedAt: row.computedAt.toISOString(),
  };
}

/**
 * `SaasMetricsService` — computes the daily SaaS-metrics snapshot from
 * accounting ledger primitives (TS-260, PDD §11.2 + §23.2).
 *
 * **Ledger-derived, not subscription-service-derived.** MRR is computed
 * from the service-local `deferred_revenue_balances` rows — never by
 * reaching across the schema boundary into `subscription.subscriptions`
 * (CLAUDE.md §2.3). Each active balance whose service period covers the
 * metric date contributes its monthly-normalised face value; the sum is
 * MRR. This keeps the metrics a derived read-model of the ledger,
 * recomputable at any time from durable rows.
 *
 * **Per-subscription snapshot for exact movement.** Movement metrics
 * (new / expansion / contraction / churn) compare each subscription's MRR
 * today against its MRR on the prior snapshot date. The
 * `deferred_revenue_balances` table reflects only CURRENT status, so a
 * subscription canceled between two runs would be misclassified if we
 * recomputed the prior day from current state. We therefore persist a
 * per-subscription snapshot (`saas_subscription_mrr_daily`) at compute
 * time and compare against the most recent prior snapshot date.
 *
 * **Idempotent recompute.** Re-running for the same UTC date deletes that
 * date's per-subscription rows + re-inserts, and upserts the daily
 * metrics row — all in one transaction. The computation is deterministic
 * given ledger state, so a recompute reproduces the same row.
 *
 * **`computedAt` == `asOf`.** In the live nightly path the worker passes
 * `asOf = now`, so `computedAt` is the run moment. For an ops back-fill
 * (`asOf` in the past) `computedAt` reflects the as-of point — the
 * "metrics as computed for that point in time" reading — which keeps the
 * function deterministic for tests + replays.
 *
 * **Money discipline.** All math is `Decimal`; values round once to the
 * cent (CLAUDE.md §17.6). Non-USD balances are skipped with a warning —
 * Phase 1 is USD-only and a stray non-USD balance must not silently
 * corrupt the USD roll-up (multi-currency aggregation is TS-264 territory).
 */
@Injectable()
export class SaasMetricsService {
  private readonly logger = new Logger(SaasMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compute + persist the SaaS-metrics snapshot for the UTC calendar date
   * of `asOf`.
   */
  async computeForDate(asOf: Date): Promise<ComputeSaasMetricsOutput> {
    const metricDate = toUtcDateOnly(asOf);
    const dateKey = utcDateKey(asOf);

    const balances = (await this.prisma.deferredRevenueBalance.findMany({
      where: {
        status: 'active',
        servicePeriodStart: { lte: asOf },
        servicePeriodEnd: { gte: asOf },
      },
      select: ACTIVE_BALANCE_SELECT,
    })) as ActiveBalanceRow[];

    const perSub = new Map<string, PerSubscriptionMrr>();
    let skippedNonUsd = 0;
    for (const balance of balances) {
      if (balance.currency !== 'USD') {
        skippedNonUsd += 1;
        continue;
      }
      const contribution = normalizeMonthlyMrr({
        originalAmount: asDecimal(balance.originalAmount),
        servicePeriodStart: balance.servicePeriodStart,
        servicePeriodEnd: balance.servicePeriodEnd,
        pausedDurationSeconds: balance.pausedDurationSeconds,
      });
      if (contribution.lte(0)) {
        continue;
      }
      const existing = perSub.get(balance.subscriptionId);
      if (existing !== undefined) {
        existing.mrr = existing.mrr.add(contribution);
      } else {
        perSub.set(balance.subscriptionId, {
          customerGroup: balance.customerGroup,
          planCode: balance.planCode,
          mrr: contribution,
        });
      }
    }

    if (skippedNonUsd > 0) {
      this.logger.warn(
        { metricDate: dateKey, skippedNonUsd },
        'saas-metrics.compute.non-usd-balances-skipped',
      );
    }

    const current = new Map<string, Decimal>();
    let mrr = new Decimal(0);
    for (const [subscriptionId, value] of perSub) {
      current.set(subscriptionId, value.mrr);
      mrr = mrr.add(value.mrr);
    }
    const activeSubscriptions = perSub.size;

    const { prior, comparisonDate } = await this.loadPriorSnapshot(metricDate);
    const movement = decomposeMovement({ current, prior });

    const arpu = computeArpu(mrr, activeSubscriptions);
    const arr = mrr.mul(12);

    await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.saasSubscriptionMrrDaily.deleteMany({ where: { metricDate } });
      if (perSub.size > 0) {
        await tx.saasSubscriptionMrrDaily.createMany({
          data: [...perSub.entries()].map(([subscriptionId, value]) => ({
            metricDate,
            subscriptionId,
            customerGroup: value.customerGroup,
            planCode: value.planCode,
            mrr: value.mrr,
            currency: 'USD',
          })),
        });
      }
      await tx.saasMetricsDaily.upsert({
        where: { metricDate },
        create: {
          metricDate,
          currency: 'USD',
          mrr,
          arr,
          arpu,
          activeSubscriptions,
          newMrr: movement.newMrr,
          expansionMrr: movement.expansionMrr,
          contractionMrr: movement.contractionMrr,
          churnedMrr: movement.churnedMrr,
          churnedSubscriptions: movement.churnedSubscriptions,
          netNewMrr: movement.netNewMrr,
          priorMrr: movement.priorMrr,
          netRevenueRetention: movement.netRevenueRetention,
          grossRevenueRetention: movement.grossRevenueRetention,
          ltv: null,
          cac: null,
          comparisonDate,
          computedAt: asOf,
        },
        update: {
          currency: 'USD',
          mrr,
          arr,
          arpu,
          activeSubscriptions,
          newMrr: movement.newMrr,
          expansionMrr: movement.expansionMrr,
          contractionMrr: movement.contractionMrr,
          churnedMrr: movement.churnedMrr,
          churnedSubscriptions: movement.churnedSubscriptions,
          netNewMrr: movement.netNewMrr,
          priorMrr: movement.priorMrr,
          netRevenueRetention: movement.netRevenueRetention,
          grossRevenueRetention: movement.grossRevenueRetention,
          ltv: null,
          cac: null,
          comparisonDate,
          computedAt: asOf,
        },
      });
    });

    const metrics: SaasMetricsRecord = {
      metricDate: dateKey,
      currency: 'USD',
      mrrMinor: decimalToMinor(mrr),
      arrMinor: decimalToMinor(arr),
      arpuMinor: decimalToMinor(arpu),
      activeSubscriptions,
      newMrrMinor: decimalToMinor(movement.newMrr),
      expansionMrrMinor: decimalToMinor(movement.expansionMrr),
      contractionMrrMinor: decimalToMinor(movement.contractionMrr),
      churnedMrrMinor: decimalToMinor(movement.churnedMrr),
      churnedSubscriptions: movement.churnedSubscriptions,
      netNewMrrMinor: decimalToMinor(movement.netNewMrr),
      priorMrrMinor: decimalToMinor(movement.priorMrr),
      netRevenueRetentionPpm: ratioToPpm(movement.netRevenueRetention),
      grossRevenueRetentionPpm: ratioToPpm(movement.grossRevenueRetention),
      ltvMinor: null,
      cacMinor: null,
      comparisonDate: comparisonDate === null ? null : utcDateKey(comparisonDate),
      computedAt: asOf.toISOString(),
    };

    this.logger.log(
      {
        metricDate: dateKey,
        activeSubscriptions,
        mrrMinor: metrics.mrrMinor,
        arrMinor: metrics.arrMinor,
        newMrrMinor: metrics.newMrrMinor,
        churnedSubscriptions: metrics.churnedSubscriptions,
        comparisonDate: metrics.comparisonDate,
      },
      'saas-metrics.compute.persisted',
    );

    return { metrics, subscriptionsSnapshotted: activeSubscriptions };
  }

  /**
   * Read the daily SaaS-metrics series for the admin dashboard (TS-266,
   * PRD §10.1, PDD §23.2).
   *
   * Both bounds are optional + inclusive. The query scans the
   * `saas_metrics_daily.metric_date` unique b-tree backwards (newest
   * first) and takes at most `SAAS_METRICS_RANGE_MAX_ROWS` rows, so a very
   * wide range truncates to the most recent N snapshots rather than
   * unbounding the scan. The result is reversed to ascending
   * `metricDate` order — oldest first — so the dashboard plots
   * left-to-right without re-sorting, and the echoed `from`/`to` report
   * the EFFECTIVE window actually returned (which differ from the request
   * when a bound was omitted or the cap truncated).
   *
   * Read-only; no tenant data — `saas_metrics_daily` is a platform-wide
   * ops table. Runs under the caller's scoped frame seeded by
   * `AccessTokenGuard` (same posture as the admin compute trigger).
   */
  async listForDateRange(range: {
    readonly from?: Date;
    readonly to?: Date;
  }): Promise<ListSaasMetricsResponse> {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (range.from !== undefined) dateFilter.gte = toUtcDateOnly(range.from);
    if (range.to !== undefined) dateFilter.lte = toUtcDateOnly(range.to);

    const rows = (await this.prisma.saasMetricsDaily.findMany({
      ...(Object.keys(dateFilter).length > 0 && { where: { metricDate: dateFilter } }),
      select: METRICS_ROW_SELECT,
      orderBy: { metricDate: 'desc' },
      take: SAAS_METRICS_RANGE_MAX_ROWS,
    })) as SaasMetricsDailyRow[];

    // Newest-first off the b-tree → ascending for left-to-right plotting.
    const metrics = [...rows].reverse().map(toSaasMetricsRecord);

    const from = metrics.at(0)?.metricDate ?? null;
    const to = metrics.at(-1)?.metricDate ?? null;

    this.logger.log({ snapshots: metrics.length, from, to }, 'saas-metrics.dashboard.read');

    return { metrics, from, to };
  }

  /**
   * Load the most recent per-subscription snapshot STRICTLY BEFORE the
   * metric date — the retention/movement baseline. Returns `prior: null`
   * when no earlier snapshot exists (the first-ever run), in which case
   * every subscription counts as new and retention is undefined.
   */
  private async loadPriorSnapshot(
    metricDate: Date,
  ): Promise<{ prior: Map<string, Decimal> | null; comparisonDate: Date | null }> {
    const priorDateRow = await this.prisma.saasSubscriptionMrrDaily.findFirst({
      where: { metricDate: { lt: metricDate } },
      orderBy: { metricDate: 'desc' },
      select: { metricDate: true },
    });
    if (priorDateRow === null) {
      return { prior: null, comparisonDate: null };
    }
    const priorRows = await this.prisma.saasSubscriptionMrrDaily.findMany({
      where: { metricDate: priorDateRow.metricDate },
      select: { subscriptionId: true, mrr: true },
    });
    const prior = new Map<string, Decimal>();
    for (const row of priorRows) {
      prior.set(row.subscriptionId, asDecimal(row.mrr));
    }
    return { prior, comparisonDate: priorDateRow.metricDate };
  }
}
