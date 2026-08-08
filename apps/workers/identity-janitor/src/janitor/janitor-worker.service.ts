import { Logger } from '@nestjs/common';
import { withSpan } from '@taste-and-see/tracing';

import { JanitorMetrics } from './janitor-metrics';
import type { PruneRepository, PruneResult } from './prune.repository';
import type { PruneTarget } from './prune-targets';

/** Per-target outcome enriched with skip/error state for the sweep summary. */
export interface SweepTargetResult extends PruneResult {
  /** True when the target's per-table enable flag was off this sweep. */
  readonly skipped: boolean;
  /** Set when the target's prune threw — the message, never the stack. */
  readonly error?: string;
}

/**
 * The janitor's sweep, separated from its scheduling so the unit suite
 * can drive it deterministically (one sweep per test) without timers.
 *
 * Per sweep, for each configured {@link PruneTarget}:
 *
 *   - disabled target → recorded as `skipped`, no DB call;
 *   - enabled target  → `repository.prune(target)`; a throw is caught,
 *     logged, and recorded as an `error` result so ONE failing table
 *     never aborts the others (mirrors the outbox-relay's per-source
 *     isolation).
 *
 * The sweep never throws — the scheduler treats it as best-effort and
 * re-arms regardless.
 *
 * Observability (TS-022-followup-3a): the whole sweep runs inside an
 * `identity_janitor.sweep` span (the per-target `identity_janitor.prune`
 * spans nest under it via the repository), and three Prometheus
 * instruments are recorded through {@link JanitorMetrics} — rows deleted
 * per table, per-target prune errors, and the whole-sweep duration.
 */
export class JanitorWorkerService {
  private readonly log = new Logger('JanitorWorkerService');

  constructor(
    private readonly repository: PruneRepository,
    private readonly targets: readonly PruneTarget[],
    /**
     * Defaulted so the existing two-arg call sites (unit + integration
     * tests) keep working; the instruments are no-ops until `initMetrics`
     * runs at boot, so a default-constructed instance is harmless.
     */
    private readonly metrics: JanitorMetrics = new JanitorMetrics(),
  ) {}

  async sweepOnce(): Promise<readonly SweepTargetResult[]> {
    return withSpan('identity_janitor.sweep', async (span) => {
      const startNs = process.hrtime.bigint();
      const results: SweepTargetResult[] = [];
      try {
        for (const target of this.targets) {
          if (!target.enabled) {
            results.push({
              key: target.key,
              deleted: 0,
              batches: 0,
              cappedOut: false,
              skipped: true,
            });
            continue;
          }
          try {
            const result = await this.repository.prune(target);
            this.metrics.recordRowsDeleted(target.key, result.deleted);
            if (result.deleted > 0) {
              this.log.log(
                `prune ${target.key}: deleted ${result.deleted} row(s) in ${result.batches} batch(es)` +
                  `${result.cappedOut ? ' (capped)' : ''}`,
              );
            }
            results.push({ ...result, skipped: false });
          } catch (err) {
            const message = extractError(err);
            this.metrics.recordSweepError(target.key);
            this.log.error(
              { target: target.key, err: message },
              'prune failed — skipping this target for the current sweep',
            );
            results.push({
              key: target.key,
              deleted: 0,
              batches: 0,
              cappedOut: false,
              skipped: false,
              error: message,
            });
          }
        }
        const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
        const erroredTargets = results.filter((r) => r.error !== undefined).length;
        span.setAttributes({
          'identity_janitor.targets': this.targets.length,
          'identity_janitor.rows_deleted': deleted,
          'identity_janitor.errored_targets': erroredTargets,
        });
        return results;
      } finally {
        const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        this.metrics.recordSweepDuration(durationSeconds);
      }
    });
  }
}

function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
