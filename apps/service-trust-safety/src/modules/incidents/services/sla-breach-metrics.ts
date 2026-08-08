import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'service-trust-safety:sla-breach-sweep';

/**
 * Outcome label for `trust_safety_sla_sweeps_total`. `ok` — the scan
 * completed (possibly finding nothing); `error` — it threw. Fixed string
 * literals: bounded cardinality, no PII (CLAUDE.md §10).
 */
export type SlaBreachSweepOutcome = 'ok' | 'error';

/**
 * Instruments for the SLA-breach sweep (TS-306-followup-1c, closing the gap
 * TS-306-followup-1a documented rather than papered over).
 *
 *   - `trust_safety_incidents_sla_breached` — unresolved incidents past
 *     `sla_due_at`, recorded EVERY tick including when the answer is zero.
 *     A gauge-shaped signal deliberately: "how many are late right now" is
 *     the question ops asks, and a counter of transitions could not answer
 *     it after a restart. Recorded as a histogram because the platform's
 *     meter surface exposes no asynchronous gauge; the useful read is the
 *     latest value. Same shape as the DSAR sweep's (TS-309a-followup-2).
 *   - `trust_safety_incidents_sla_due_soon` — unresolved incidents inside
 *     the derived lead-time window. The ones still actionable; a breach
 *     count you only see after the deadline is a post-mortem, not an alarm.
 *   - `trust_safety_sla_sweeps_total{outcome}` — sweep executions by
 *     outcome. A rising `error` rate means nobody is watching the clock,
 *     which is the failure this sweep exists to prevent.
 *   - `trust_safety_sla_sweep_duration_seconds{outcome}` — scan latency.
 *     Steady state is two indexed counts and a capped enumeration.
 *
 * **The breach count recorded here is the UNCAPPED one.** The sweep runs
 * count and enumeration as separate queries precisely so a truncated log
 * cannot make this series under-report; recording `rows.length` would undo
 * that on the surface ops actually alerts on.
 *
 * No label carries an incident id, a severity or a category. Severity is
 * tempting — "which budget is being missed" is a real question — but this
 * series is what an alert fires on, and an alert that names the severity of
 * a live welfare concern in its notification body puts the shape of a
 * report into a channel that routes to phones. The per-incident WARN lines
 * carry severity and its budget for the operator who opens the log; the
 * console carries the rest behind `trust_safety:write`.
 *
 * Instruments come from `getMeter`, which returns a usable no-op meter when
 * `initMetrics` was never called — safe to construct in unit tests without
 * booting the SDK.
 */
@Injectable()
export class SlaBreachMetrics {
  private readonly breached: Histogram;
  private readonly dueSoon: Histogram;
  private readonly sweeps: Counter;
  private readonly sweepDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.breached = meter.createHistogram('trust_safety_incidents_sla_breached', {
      description: 'Unresolved trust & safety incidents past their SLA deadline, at each sweep.',
    });
    this.dueSoon = meter.createHistogram('trust_safety_incidents_sla_due_soon', {
      description:
        'Unresolved trust & safety incidents inside the derived due-soon window, at each sweep.',
    });
    this.sweeps = meter.createCounter('trust_safety_sla_sweeps_total', {
      description: 'Total SLA-breach sweep executions, by outcome (ok / error).',
    });
    this.sweepDuration = meter.createHistogram('trust_safety_sla_sweep_duration_seconds', {
      description: 'Latency of one SLA-breach sweep, in seconds, by outcome.',
      unit: 's',
    });
  }

  /**
   * Record one completed scan. `breachedCount` and `dueSoonCount` are
   * recorded even at zero — an absent series is indistinguishable from a
   * worker that stopped running, and on this surface those two mean
   * opposite things: "nothing is late" versus "nobody is checking".
   */
  recordSweep(
    outcome: SlaBreachSweepOutcome,
    counts: { readonly breachedCount: number; readonly dueSoonCount: number },
    seconds: number,
  ): void {
    this.sweeps.add(1, { outcome });
    this.sweepDuration.record(seconds, { outcome });
    if (outcome === 'ok') {
      this.breached.record(counts.breachedCount);
      this.dueSoon.record(counts.dueSoonCount);
    }
  }
}
