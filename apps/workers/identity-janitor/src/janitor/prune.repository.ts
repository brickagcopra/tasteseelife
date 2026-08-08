import { Logger } from '@nestjs/common';
import { withSpan } from '@taste-and-see/tracing';
import type { Pool, PoolClient } from 'pg';

import type { PruneTarget } from './prune-targets';

/** Per-target outcome of one `prune` call. */
export interface PruneResult {
  readonly key: string;
  /** Total rows deleted across every batch this sweep. */
  readonly deleted: number;
  /** Number of `DELETE` statements issued. */
  readonly batches: number;
  /**
   * True when the per-sweep batch cap was hit before the backlog was
   * drained — the remainder clears on the next sweep. A persistently
   * capped sweep is an ops signal (retention window too short, or
   * batch size / cadence mismatched to write volume).
   */
  readonly cappedOut: boolean;
}

/**
 * Validated identifier regex — lowercase letter/underscore start, then
 * letters/digits/underscore. The prune targets are code constants so
 * this never rejects in practice; it is a defence-in-depth guard so a
 * future careless edit to `prune-targets.ts` can't smuggle an unsafe
 * identifier into the interpolated SQL.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Minimal query surface the repository needs. Abstracted from `pg.Pool`
 * so the batch loop is unit-testable against a fake without a live
 * Postgres (the integration test, deferred, exercises the real driver).
 */
export interface PruneExecutor {
  /** Run a parameterized DELETE; return the number of rows deleted. */
  deleteBatch(sql: string, params: readonly unknown[]): Promise<number>;
}

/** Concrete `pg`-backed executor. One connection checked out per batch. */
export class PgPruneExecutor implements PruneExecutor {
  constructor(private readonly pool: Pool) {}

  async deleteBatch(sql: string, params: readonly unknown[]): Promise<number> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const result = await client.query(sql, params as unknown[]);
      return result.rowCount ?? 0;
    } finally {
      client?.release();
    }
  }
}

/**
 * Deletes retention-aged rows from a {@link PruneTarget} in bounded
 * batches.
 *
 * Why batched. A single unbounded `DELETE FROM … WHERE expires_at < …`
 * would take a lock + write WAL proportional to the backlog — on a
 * neglected table that is a replication-lag spike and a window where
 * concurrent auth writes block. Deleting `batchSize` rows at a time
 * (selected by primary key off the `expires_at` index) keeps each
 * statement's footprint flat. The loop stops when a batch deletes
 * fewer than `batchSize` rows (backlog drained) or the per-sweep batch
 * cap is reached (remainder deferred to the next sweep).
 *
 * Why `DELETE … WHERE id IN (SELECT id … LIMIT n)`. Postgres has no
 * `DELETE … LIMIT`; the PK subselect is the standard idiom. The inner
 * `SELECT` rides the `expires_at` index (ordered) so it reads only the
 * head of the expired range, not the whole table.
 *
 * Idempotent + crash-safe: the threshold is absolute wall-clock
 * (`now() - interval`), so re-running after a crash simply re-evaluates
 * eligibility — no row is double-counted, nothing is lost.
 */
export class PruneRepository {
  private readonly log = new Logger('PruneRepository');

  constructor(
    private readonly executor: PruneExecutor,
    private readonly batchSize: number,
    private readonly maxBatchesPerSweep: number,
  ) {}

  async prune(target: PruneTarget): Promise<PruneResult> {
    // Per-target span (TS-022-followup-3a) — nests under the
    // `identity_janitor.sweep` span the worker opens. A throw from the
    // executor propagates out (the worker catches + isolates it); withSpan
    // records the exception + ERROR status before re-throwing.
    return withSpan('identity_janitor.prune', async (span) => {
      span.setAttribute('identity_janitor.table', target.key);
      const sql = buildDeleteSql(target);
      let deleted = 0;
      let batches = 0;
      let cappedOut = false;

      for (;;) {
        if (batches >= this.maxBatchesPerSweep) {
          cappedOut = true;
          this.log.warn(
            `prune ${target.key}: hit per-sweep batch cap (${this.maxBatchesPerSweep}) — ` +
              `${deleted} rows deleted this sweep, remainder deferred to next sweep`,
          );
          break;
        }
        const rows = await this.executor.deleteBatch(sql, [target.retentionDays, this.batchSize]);
        batches += 1;
        deleted += rows;
        if (rows < this.batchSize) break;
      }

      span.setAttributes({
        'identity_janitor.rows_deleted': deleted,
        'identity_janitor.batches': batches,
        'identity_janitor.capped_out': cappedOut,
      });
      return { key: target.key, deleted, batches, cappedOut };
    });
  }
}

/**
 * Build the parameterized DELETE for a target. `$1` is the retention
 * window in whole days (fed to `make_interval`); `$2` is the batch
 * size. The schema/table/column identifiers are interpolated literally
 * — validated against {@link IDENTIFIER} first so a bad constant fails
 * loudly at build time rather than producing malformed or unsafe SQL.
 */
export function buildDeleteSql(target: PruneTarget): string {
  const schema = assertIdentifier(target.schema, 'schema');
  const table = assertIdentifier(target.table, 'table');
  const column = assertIdentifier(target.expiresAtColumn, 'expiresAtColumn');
  const qualified = `"${schema}"."${table}"`;
  return `
    DELETE FROM ${qualified}
    WHERE id IN (
      SELECT id
      FROM ${qualified}
      WHERE "${column}" < now() - make_interval(days => $1::int)
      ORDER BY "${column}" ASC
      LIMIT $2
    )
  `;
}

function assertIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`prune target ${label} '${value}' is not a safe SQL identifier`);
  }
  return value;
}
