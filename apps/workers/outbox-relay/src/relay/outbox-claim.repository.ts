import { Logger } from '@nestjs/common';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { OutboxSource } from '../config/env';
import type { OutboxRow } from './types';

/**
 * Postgres side of the relay. One repository instance per Pool; each
 * pollSource call quotes the schema/table from the OutboxSource into
 * raw SQL. Schema + table came from env validation (strict
 * identifier regex) so the interpolation is safe by construction.
 *
 * Access pattern: every poll cycle the relay reads up to `batchSize`
 * undispatched rows ordered by `created_at` (the partial index on
 * `(created_at) WHERE dispatched_at IS NULL` makes this scan
 * negligible-cost — Postgres reads exactly the head of the queue
 * regardless of how many dispatched rows the table contains).
 *
 * The relay does NOT use SELECT … FOR UPDATE SKIP LOCKED here.
 * Phase 1 has exactly one relay process; multi-replica deployments
 * (Phase 2+) would add the lock clause. Until then a single replica
 * + at-least-once delivery is acceptable per PDD §7.3.
 */
export interface OutboxClaimRepository {
  /**
   * Read up to `limit` undispatched rows from the source. Filters
   * out rows whose attempts have already reached the max
   * (dead-lettered — the relay stops trying so ops can intervene).
   *
   * Rows include `attempts` so the relay knows whether a dispatch
   * succeeded last cycle (if it didn't, attempts > 0 and the
   * `last_error` column holds the reason — surfaced via metrics).
   */
  claimBatch(
    source: OutboxSource,
    limit: number,
    maxAttempts: number,
  ): Promise<readonly OutboxRow[]>;

  /**
   * Stamp `dispatched_at = now()` on a row that was successfully
   * forwarded onto the bus. Updates only when `dispatched_at IS NULL`
   * so a concurrent second relay (Phase 2+) racing on the same row
   * can't double-stamp.
   */
  markDispatched(source: OutboxSource, eventId: string): Promise<void>;

  /**
   * Record a failed dispatch attempt: increment `attempts`, stamp
   * `last_attempt_at = now()`, write `last_error`. Does NOT set
   * `dispatched_at` — the row remains eligible for the next poll
   * cycle if `attempts < max_attempts`.
   */
  recordFailure(source: OutboxSource, eventId: string, errorMessage: string): Promise<void>;
}

/**
 * Concrete `pg`-backed implementation. Uses parameterized values for
 * every user-supplied bit (eventId, errorMessage); the only literal
 * interpolation is the validated schema/table identifier pair.
 */
export class PgOutboxClaimRepository implements OutboxClaimRepository {
  private readonly log = new Logger('OutboxClaimRepository');

  constructor(private readonly pool: Pool) {}

  async claimBatch(
    source: OutboxSource,
    limit: number,
    maxAttempts: number,
  ): Promise<readonly OutboxRow[]> {
    const sql = `
      SELECT
        event_id,
        event_name,
        payload,
        occurred_at,
        producer_service,
        attempts,
        created_at
      FROM ${qualify(source)}
      WHERE dispatched_at IS NULL
        AND attempts < $1
      ORDER BY created_at ASC
      LIMIT $2
    `;
    const result = await this.query<RawOutboxRow>(sql, [maxAttempts, limit]);
    return result.rows.map((row) => mapRow(source, row));
  }

  async markDispatched(source: OutboxSource, eventId: string): Promise<void> {
    const sql = `
      UPDATE ${qualify(source)}
      SET dispatched_at = now()
      WHERE event_id = $1
        AND dispatched_at IS NULL
    `;
    const result = await this.query(sql, [eventId]);
    if (result.rowCount === 0) {
      this.log.warn(
        `markDispatched: no row updated source=${source.schema}.${source.table} eventId=${eventId} (already dispatched or vanished)`,
      );
    }
  }

  async recordFailure(source: OutboxSource, eventId: string, errorMessage: string): Promise<void> {
    const sql = `
      UPDATE ${qualify(source)}
      SET attempts = attempts + 1,
          last_attempt_at = now(),
          last_error = $2
      WHERE event_id = $1
    `;
    // Cap the error message so a runaway driver message can't blow
    // up the column or the log line.
    const safeMessage = truncate(errorMessage, 2000);
    await this.query(sql, [eventId, safeMessage]);
  }

  private async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[],
  ): Promise<QueryResult<R>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      return await client.query<R>(sql, values as unknown[]);
    } finally {
      client?.release();
    }
  }
}

interface RawOutboxRow extends QueryResultRow {
  readonly event_id: string;
  readonly event_name: string;
  readonly payload: unknown;
  readonly occurred_at: Date;
  readonly producer_service: string;
  readonly attempts: number;
  readonly created_at: Date;
}

function mapRow(source: OutboxSource, row: RawOutboxRow): OutboxRow {
  return {
    schema: source.schema,
    table: source.table,
    eventId: row.event_id,
    eventName: row.event_name,
    payload: row.payload,
    occurredAt: row.occurred_at,
    producerService: row.producer_service,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

function qualify(source: OutboxSource): string {
  // Schema + table validated by env regex — `[a-z_][a-z0-9_]*` — so
  // the literal interpolation here is safe. Postgres has no
  // placeholder syntax for identifiers.
  return `"${source.schema}"."${source.table}"`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
