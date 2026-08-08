import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'service-identity:rbac-revoker';

/**
 * Outcome label for `rbac_revoker_sweeps_total`. `ok` — the sweep drained
 * (possibly zero rows); `error` — the sweep threw (a batch rolled back).
 * Fixed string literals — bounded cardinality, no PII (CLAUDE.md §10).
 */
export type RbacRevokerSweepOutcome = 'ok' | 'error';

/**
 * service-identity's rbac-revoker instruments (TS-293; CLAUDE.md §10 —
 * every new worker adds at least one custom metric).
 *
 *   - `rbac_assignments_expired_total` — expired assignments durably
 *     revoked by the sweep. The rate is the "access lapsing" business
 *     signal; a sudden spike usually means a bulk grant with a shared
 *     expiry just lapsed.
 *   - `rbac_revoker_sweeps_total{outcome}` — sweep executions by outcome.
 *     A rising `error` rate is the worker-health alarm (DB down, outbox
 *     append rejecting).
 *   - `rbac_revoker_sweep_duration_seconds{outcome}` — sweep latency.
 *     Steady-state (zero expired rows) is a single indexed query; growth
 *     tracks expired-row backlog.
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — safe to construct in unit
 * tests without booting the SDK. Mirrors the `KycMetrics` domain-instrument
 * shape.
 */
@Injectable()
export class RbacRevokerMetrics {
  private readonly assignmentsExpired: Counter;
  private readonly sweeps: Counter;
  private readonly sweepDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.assignmentsExpired = meter.createCounter('rbac_assignments_expired_total', {
      description: 'Total role assignments durably revoked by the expiry sweep.',
    });
    this.sweeps = meter.createCounter('rbac_revoker_sweeps_total', {
      description: 'Total expiry-sweep executions, by outcome (ok / error).',
    });
    this.sweepDuration = meter.createHistogram('rbac_revoker_sweep_duration_seconds', {
      description: 'Latency of one full expiry sweep (all batches), in seconds, by outcome.',
      unit: 's',
    });
  }

  /** Record one completed sweep (counter + latency + revoked rows). */
  recordSweep(outcome: RbacRevokerSweepOutcome, revokedCount: number, seconds: number): void {
    this.sweeps.add(1, { outcome });
    this.sweepDuration.record(seconds, { outcome });
    if (revokedCount > 0) {
      this.assignmentsExpired.add(revokedCount);
    }
  }
}
