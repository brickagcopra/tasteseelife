import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { ConsumerDedupState, ConsumerDedupStore, ConsumerRawExecutor } from './types';

/**
 * Postgres-backed `ConsumerDedupStore`. The consuming service ships a
 * migration creating the dedup table in its own schema; this store
 * issues raw SQL through whatever Prisma-shaped client the consumer
 * passes in (top-level client or transaction client).
 *
 * Canonical table shape — every consuming service migrates this verbatim
 * (or via a shared per-service template):
 *
 *   CREATE TABLE {schema}.outbox_consumer_dedup (
 *     consumer_group     TEXT        NOT NULL,
 *     event_id           TEXT        NOT NULL,
 *     event_name         TEXT        NOT NULL,
 *     state              TEXT        NOT NULL CHECK (state IN ('in_flight', 'processed', 'dead_lettered')),
 *     attempts           INTEGER     NOT NULL DEFAULT 1,
 *     last_error         TEXT,
 *     first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     last_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     processed_at       TIMESTAMPTZ,
 *     dead_lettered_at   TIMESTAMPTZ,
 *     PRIMARY KEY (consumer_group, event_id)
 *   );
 *
 *   CREATE INDEX outbox_consumer_dedup_dead_lettered_idx
 *     ON {schema}.outbox_consumer_dedup(consumer_group, dead_lettered_at)
 *     WHERE dead_lettered_at IS NOT NULL;
 *
 * The `schemaName` + `tableName` ctor args are validated against an
 * identifier regex at module-init time so the raw-SQL interpolation
 * here is safe by construction (Postgres has no placeholder syntax for
 * identifiers — same constraint the producer SDK navigates).
 *
 * Why raw SQL instead of Prisma model methods. The SDK doesn't take a
 * Prisma dependency; the canonical pattern across this codebase is for
 * shared packages to consume a minimal Prisma-shaped raw executor. The
 * trade-off is that the dedup table's Prisma model in the consumer's
 * schema is decorative — useful for introspection but never read/written
 * through the generated client. Same shape as the relay's claim repo.
 */
@Injectable()
export class PgConsumerDedupStore implements ConsumerDedupStore {
  private readonly log = new Logger('PgConsumerDedupStore');
  private readonly fullyQualifiedTable: string;

  constructor(
    private readonly tx: ConsumerRawExecutor,
    schemaName: string,
    tableName = 'outbox_consumer_dedup',
  ) {
    const identifierRegex = /^[a-z_][a-z0-9_]*$/;
    if (!identifierRegex.test(schemaName)) {
      throw new Error(
        `PgConsumerDedupStore: invalid schemaName '${schemaName}' — must match ${identifierRegex}`,
      );
    }
    if (!identifierRegex.test(tableName)) {
      throw new Error(
        `PgConsumerDedupStore: invalid tableName '${tableName}' — must match ${identifierRegex}`,
      );
    }
    this.fullyQualifiedTable = `"${schemaName}"."${tableName}"`;
  }

  async getState(consumerGroup: string, eventId: string): Promise<ConsumerDedupState> {
    const sql = `SELECT state, attempts FROM ${this.fullyQualifiedTable} WHERE consumer_group = $1 AND event_id = $2`;
    const rows = await this.tx.$queryRaw<Array<{ state: unknown; attempts: unknown }>>(
      buildTemplateStrings(sql),
      consumerGroup,
      eventId,
    );
    if (rows.length === 0) return { kind: 'unseen' };
    const row = rows[0];
    const parsed = RowStateSchema.safeParse(row);
    if (!parsed.success) {
      this.log.warn(`PgConsumerDedupStore.getState row failed parse: ${parsed.error.message}`);
      return { kind: 'unseen' };
    }
    switch (parsed.data.state) {
      case 'in_flight':
        return { kind: 'in_flight', attempts: parsed.data.attempts };
      case 'processed':
        return { kind: 'processed' };
      case 'dead_lettered':
        return { kind: 'dead_lettered' };
    }
  }

  async recordAttempt(consumerGroup: string, eventId: string, eventName: string): Promise<void> {
    // First-seen row OR increment attempts on a redelivery. The
    // `WHERE state = 'in_flight'` guard on the UPDATE branch keeps an
    // already-processed or dead-lettered row stable (defensive — the
    // SDK does not call recordAttempt against those states, but a
    // race with reclaim could).
    const sql = `
      INSERT INTO ${this.fullyQualifiedTable}
        (consumer_group, event_id, event_name, state, attempts, first_seen_at, last_attempt_at)
      VALUES
        ($1, $2, $3, 'in_flight', 1, now(), now())
      ON CONFLICT (consumer_group, event_id) DO UPDATE
        SET attempts = ${this.fullyQualifiedTable}.attempts + 1,
            last_attempt_at = now()
        WHERE ${this.fullyQualifiedTable}.state = 'in_flight'
    `;
    await this.tx.$executeRaw(buildTemplateStrings(sql), consumerGroup, eventId, eventName);
  }

  async recordSuccess(consumerGroup: string, eventId: string): Promise<void> {
    const sql = `
      UPDATE ${this.fullyQualifiedTable}
        SET state = 'processed',
            processed_at = now(),
            last_error = NULL
        WHERE consumer_group = $1 AND event_id = $2
    `;
    await this.tx.$executeRaw(buildTemplateStrings(sql), consumerGroup, eventId);
  }

  async recordFailure(consumerGroup: string, eventId: string, error: string): Promise<void> {
    // Truncate to 2000 chars defensively — match the relay's recordFailure.
    const truncated = error.length > 2000 ? error.slice(0, 2000) : error;
    const sql = `
      UPDATE ${this.fullyQualifiedTable}
        SET last_error = $3,
            last_attempt_at = now()
        WHERE consumer_group = $1 AND event_id = $2
    `;
    await this.tx.$executeRaw(buildTemplateStrings(sql), consumerGroup, eventId, truncated);
  }

  async recordDeadLetter(consumerGroup: string, eventId: string, error: string): Promise<void> {
    const truncated = error.length > 2000 ? error.slice(0, 2000) : error;
    const sql = `
      INSERT INTO ${this.fullyQualifiedTable}
        (consumer_group, event_id, event_name, state, attempts, last_error, first_seen_at, last_attempt_at, dead_lettered_at)
      VALUES
        ($1, $2, '<unknown>', 'dead_lettered', 1, $3, now(), now(), now())
      ON CONFLICT (consumer_group, event_id) DO UPDATE
        SET state = 'dead_lettered',
            dead_lettered_at = now(),
            last_error = $3
    `;
    await this.tx.$executeRaw(buildTemplateStrings(sql), consumerGroup, eventId, truncated);
  }
}

const RowStateSchema = z.object({
  state: z.enum(['in_flight', 'processed', 'dead_lettered']),
  attempts: z.coerce.number().int().nonnegative(),
});

/**
 * Synthesise a `TemplateStringsArray` for Prisma's tagged-template
 * `$executeRaw` entrypoint. Same shape used by the producer SDK so the
 * `$N` placeholders flow through Prisma's parameterization without an
 * unsafe cast at every call site.
 */
function buildTemplateStrings(sql: string): TemplateStringsArray {
  const segments = sql.split(/\$\d+/);
  const arr: string[] & { raw?: readonly string[] } = segments;
  arr.raw = segments;
  return arr as unknown as TemplateStringsArray;
}
