import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'worker-identity-janitor:janitor';

/**
 * The janitor's domain Prometheus instruments (TS-022-followup-3a):
 *
 *   - `identity_janitor_rows_deleted_total{table}` (counter) — total rows
 *     deleted, partitioned by target table. Drives "is the janitor
 *     actually pruning?" + per-table backlog-burn-down dashboards.
 *   - `identity_janitor_sweep_errors_total{table}` (counter) — per-target
 *     prune failures during a sweep. One failing table never aborts the
 *     others (JanitorWorkerService isolates each target), so this counter
 *     is the only signal that a specific table is stuck — alert on its
 *     rate.
 *   - `identity_janitor_sweep_duration_seconds` (histogram) — wall-clock
 *     duration of one whole sweep. A persistent upward drift means the
 *     batch cap / cadence is mismatched to write volume (cross-reference
 *     the `cappedOut` log line).
 *
 * The `table` label cardinality is bounded — it is one of the fixed
 * code-constant target keys in `prune-targets.ts` (`refresh_tokens` /
 * `mfa_challenges`), never user-derived (CLAUDE.md §10 PII discipline).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests and CLI contexts without booting the SDK.
 */
@Injectable()
export class JanitorMetrics {
  private readonly rowsDeleted: Counter;
  private readonly sweepErrors: Counter;
  private readonly sweepDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.rowsDeleted = meter.createCounter('identity_janitor_rows_deleted_total', {
      description: 'Total rows deleted by the identity janitor, by target table',
    });
    this.sweepErrors = meter.createCounter('identity_janitor_sweep_errors_total', {
      description: 'Total per-target prune failures during a janitor sweep, by target table',
    });
    this.sweepDuration = meter.createHistogram('identity_janitor_sweep_duration_seconds', {
      description: 'Wall-clock duration of one identity-janitor sweep in seconds',
      unit: 's',
    });
  }

  /**
   * Record rows deleted from `table` this sweep. Recorded even when
   * `count` is 0 so the per-table series exists from the first sweep —
   * a flat-at-zero line proves the sweep ran, distinguishing it from a
   * crashed worker (no series at all).
   */
  recordRowsDeleted(table: string, count: number): void {
    this.rowsDeleted.add(count, { table });
  }

  /** Increment the per-target error counter when a target's prune throws. */
  recordSweepError(table: string): void {
    this.sweepErrors.add(1, { table });
  }

  /** Record the whole-sweep wall-clock duration in seconds. */
  recordSweepDuration(seconds: number): void {
    this.sweepDuration.record(seconds);
  }
}
