import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'service-identity:privacy-overdue-sweep';

/**
 * Outcome label for `privacy_overdue_sweeps_total`. `ok` — the scan
 * completed (possibly finding nothing); `error` — it threw. Fixed string
 * literals: bounded cardinality, no PII (CLAUDE.md §10).
 */
export type PrivacyOverdueSweepOutcome = 'ok' | 'error';

/**
 * Instruments for the overdue data-subject-request sweep
 * (TS-309a-followup-2; CLAUDE.md §10 — every new worker adds at least one
 * custom metric).
 *
 *   - `privacy_requests_overdue` — live requests past the configured
 *     response window, recorded EVERY tick including when the answer is
 *     zero. A gauge-shaped signal deliberately: "how many are late right
 *     now" is the compliance question, and a counter of transitions could
 *     not answer it after a restart. Recorded as a histogram because the
 *     platform's meter surface exposes no asynchronous gauge; the useful
 *     read is the latest value.
 *   - `privacy_requests_due_soon` — live requests inside the lead-time
 *     window. This is the number an operator can still act on.
 *   - `privacy_overdue_sweeps_total{outcome}` — sweep executions by
 *     outcome. A rising `error` rate means nobody is watching the clock,
 *     which is itself the failure this sweep exists to prevent.
 *   - `privacy_overdue_sweep_duration_seconds{outcome}` — scan latency.
 *     Steady state is two indexed counts.
 *
 * No label carries a request id, a subject id or a user id: an
 * unbounded-cardinality label on a privacy surface is both a metrics
 * problem and a disclosure one.
 *
 * Instruments come from `getMeter`, which returns a usable no-op meter
 * when `initMetrics` was never called — safe to construct in unit tests
 * without booting the SDK. Mirrors `RbacRevokerMetrics`.
 */
@Injectable()
export class PrivacyOverdueMetrics {
  private readonly overdue: Histogram;
  private readonly dueSoon: Histogram;
  private readonly sweeps: Counter;
  private readonly sweepDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.overdue = meter.createHistogram('privacy_requests_overdue', {
      description: 'Live data-subject requests past the configured response window, at each sweep.',
    });
    this.dueSoon = meter.createHistogram('privacy_requests_due_soon', {
      description:
        'Live data-subject requests inside the configured lead-time window, at each sweep.',
    });
    this.sweeps = meter.createCounter('privacy_overdue_sweeps_total', {
      description: 'Total overdue-request sweep executions, by outcome (ok / error).',
    });
    this.sweepDuration = meter.createHistogram('privacy_overdue_sweep_duration_seconds', {
      description: 'Latency of one overdue-request sweep, in seconds, by outcome.',
      unit: 's',
    });
  }

  /**
   * Record one completed scan. `overdueCount` and `dueSoonCount` are
   * recorded even at zero — an absent series is indistinguishable from a
   * worker that stopped running, and on this surface those two mean
   * opposite things.
   */
  recordSweep(
    outcome: PrivacyOverdueSweepOutcome,
    counts: { readonly overdueCount: number; readonly dueSoonCount: number },
    seconds: number,
  ): void {
    this.sweeps.add(1, { outcome });
    this.sweepDuration.record(seconds, { outcome });
    if (outcome === 'ok') {
      this.overdue.record(counts.overdueCount);
      this.dueSoon.record(counts.dueSoonCount);
    }
  }
}
