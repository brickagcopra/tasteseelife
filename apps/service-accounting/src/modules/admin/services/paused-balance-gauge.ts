import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { getMeter, type ObservableGauge } from '@taste-and-see/tracing';

import { AdminDeferredRevenueService } from './admin-deferred-revenue.service';

const METER_NAME = 'service-accounting:revenue-recognition';

/**
 * Which stock measure a point on `accounting_deferred_revenue_paused` carries.
 * Four fixed series — no id, no customer, no plan (CLAUDE.md §3.9, §10, §12).
 */
const MEASURES = {
  /** Every balance with `status = 'paused'`. */
  balances: 'balances',
  /** Of those, how many are already past their own service period end. */
  pastServicePeriodEnd: 'past_service_period_end',
  /** Of those, how many carry no `paused_at` (age unknowable). */
  unknownPausedAt: 'unknown_paused_at',
  /** Stranded deferred revenue across every paused balance, in minor units. */
  remainingDeferredMinor: 'remaining_deferred_minor',
} as const;

/**
 * `accounting_deferred_revenue_paused{measure}` — the STOCK counterpart to
 * `accounting_recognition_pause_total` (TS-042-followup-3b2-followup-2a).
 *
 * **Why a gauge and not another counter.** The counter is a flow: it
 * records that a pause happened. It cannot say whether the pause ever
 * ended, and after a pod restart its series starts from zero while the
 * suspended balances are still suspended. "Is anything stuck right now" is
 * a question about state, and only an observed measurement of the rows
 * answers it. The admin endpoint answers *which* balances; this answers
 * *whether*, without anybody opening a page — which is the half that can
 * page someone.
 *
 * **`remaining_deferred_minor` is the alertable series.** A handful of
 * paused balances is ordinary product behaviour; a five-figure deferred
 * balance that has been suspended across a period boundary is revenue that
 * has silently left the recognition schedule, and it is the
 * TS-042-followup-3b2-followup-1 failure mode expressed in dollars.
 *
 * **Collection cost, stated rather than assumed.** The callback runs on the
 * metric reader's export interval (10s by default) and issues four indexed
 * reads against `deferred_revenue_balances` — a table holding one row per
 * subscription per service period, with
 * `deferred_revenue_balances_status_period_idx` serving the predicate. If
 * that ever becomes material the lever is the export interval, already an
 * operator setting; the queries are not made cheaper by being rarer in
 * code.
 *
 * **A failing callback observes nothing.** An exporter that throws takes
 * every other instrument in the process down with it, and a gap in a stock
 * series reads correctly as "we could not measure" — unlike a zero, which
 * reads as "nothing is stuck".
 */
@Injectable()
export class PausedBalanceGauge implements OnApplicationBootstrap {
  private readonly logger = new Logger(PausedBalanceGauge.name);
  private readonly gauge: ObservableGauge;

  constructor(private readonly deferredRevenue: AdminDeferredRevenueService) {
    this.gauge = getMeter(METER_NAME).createObservableGauge('accounting_deferred_revenue_paused', {
      description:
        'Current stock of suspended deferred-revenue balances by measure: how many are paused, how many have outlasted their own service period, how many have no recorded pause instant, and how much deferred revenue is stranded (USD minor units).',
    });
  }

  /**
   * Registered at bootstrap rather than in the constructor: the callback
   * queries Prisma, and the DI container constructs providers before the
   * connection is established.
   */
  onApplicationBootstrap(): void {
    this.gauge.addCallback(async (result) => {
      try {
        const summary = await this.deferredRevenue.summarizePaused(new Date());
        result.observe(summary.pausedCount, { measure: MEASURES.balances });
        result.observe(summary.pastServicePeriodEndCount, {
          measure: MEASURES.pastServicePeriodEnd,
        });
        result.observe(summary.unknownPausedAtCount, {
          measure: MEASURES.unknownPausedAt,
        });
        result.observe(summary.totalRemainingDeferredMinor, {
          measure: MEASURES.remainingDeferredMinor,
        });
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : 'unknown' },
          'accounting.deferred-revenue.paused.gauge-failed',
        );
      }
    });
  }
}
