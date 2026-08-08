import { Logger } from '@nestjs/common';
import { withSpan } from '@taste-and-see/tracing';

import type { OutboxSource } from '../config/env';
import type { BusPublisher } from './redis-stream-publisher';
import { classifyFailureReason, RelayMetrics } from './relay-metrics';
import type { OutboxClaimRepository } from './outbox-claim.repository';
import type { OutboxRow, RelayPollResult } from './types';

/**
 * The relay's poll loop, separated from its scheduling so the unit
 * suite can drive it deterministically (one cycle per test) without
 * timers.
 *
 * Per cycle, for each configured `OutboxSource`:
 *
 *   1. `claimBatch(source, batchSize, maxAttempts)` returns up to N
 *      undispatched rows whose attempts have not exhausted.
 *   2. For each row, `publish(row)` (Redis Streams XADD) → on
 *      success, `markDispatched`. On failure, `recordFailure` (which
 *      increments `attempts` + records `last_error`); the row stays
 *      in the queue for the next cycle until attempts reach the cap.
 *   3. Rows whose attempts are at the cap on read are dead-lettered
 *      (the `claimBatch` query filters them out — they show up as a
 *      delta only when ops surfaces them via a separate query).
 *
 * Why not transactional. The XADD-then-UPDATE pair is deliberately
 * outside a single transaction. If the relay crashes between
 * `publish` and `markDispatched`, the row is republished next
 * cycle — consumers are idempotent on `event_id` (CLAUDE.md §5.3),
 * so duplicate delivery is acceptable. The alternative (atomic
 * publish+update) would require a Redis MULTI + Postgres SAVEPOINT
 * dance for marginal benefit.
 *
 * Why per-row dispatch rather than batched XADD. The `XADD MAXLEN ~`
 * call is one round-trip per row anyway (pipelining could reduce
 * the network cost, but per-row failure handling is the priority —
 * one row's XADD failing must not prevent the others from advancing).
 *
 * Observability (TS-142-followup-4). Each `pollOnce` runs inside an
 * `outbox_relay.poll` span; each source under an `outbox_relay.poll_source`
 * span (source attribute); each row's publish under an
 * `outbox_relay.dispatch_row` span — so a trace shows the full
 * claim → publish → mark fan-out. Seven Prometheus instruments are
 * recorded through {@link RelayMetrics} (poll outcome, rows dispatched,
 * rows failed by bounded reason, rows dead-lettered, per-row lag, and
 * per-cycle + per-publish duration histograms). PII discipline:
 * `event_name` + `source` + bounded `reason`/`outcome` are the only
 * labels — never the payload, event_id, or raw error text (CLAUDE.md §10).
 */
export class RelayWorkerService {
  private readonly log = new Logger('RelayWorkerService');

  constructor(
    private readonly repository: OutboxClaimRepository,
    private readonly publisher: BusPublisher,
    private readonly options: RelayWorkerOptions,
    /**
     * Defaulted so the existing three-arg call sites (unit tests) keep
     * working; the instruments are no-ops until `initMetrics` runs at
     * boot, so a default-constructed instance is harmless.
     */
    private readonly metrics: RelayMetrics = new RelayMetrics(),
  ) {}

  /**
   * Run one poll cycle across every configured source. Returns a
   * per-source summary. The caller schedules this via `setInterval`
   * or invokes directly from tests.
   */
  async pollOnce(): Promise<readonly RelayPollResult[]> {
    return withSpan('outbox_relay.poll', async (span) => {
      const results: RelayPollResult[] = [];
      for (const source of this.options.sources) {
        const result = await this.pollSource(source);
        results.push(result);
      }
      span.setAttributes({
        'outbox_relay.sources': this.options.sources.length,
        'outbox_relay.dispatched': results.reduce((s, r) => s + r.dispatched, 0),
        'outbox_relay.failed': results.reduce((s, r) => s + r.failed, 0),
        'outbox_relay.dead_lettered': results.reduce((s, r) => s + r.deadLettered, 0),
      });
      return results;
    });
  }

  private async pollSource(source: OutboxSource): Promise<RelayPollResult> {
    const sourceName = `${source.schema}.${source.table}`;
    return withSpan('outbox_relay.poll_source', async (span) => {
      span.setAttribute('outbox_relay.source', sourceName);
      const startNs = process.hrtime.bigint();
      let claimed = 0;
      let dispatched = 0;
      let failed = 0;
      let deadLettered = 0;

      try {
        let rows: readonly OutboxRow[] = [];
        try {
          rows = await this.repository.claimBatch(
            source,
            this.options.batchSize,
            this.options.maxAttempts,
          );
          claimed = rows.length;
        } catch (err) {
          this.log.error(
            { source: sourceName, err: extractError(err) },
            'relay.claimBatch failed — skipping this source for the current cycle',
          );
          this.metrics.recordPoll(sourceName, 'claim_failed');
          return { source: sourceName, claimed, dispatched, failed: 0, deadLettered: 0 };
        }

        if (claimed === 0) {
          this.metrics.recordPoll(sourceName, 'ok');
          return { source: sourceName, claimed: 0, dispatched: 0, failed: 0, deadLettered: 0 };
        }

        for (const row of rows) {
          this.metrics.recordLagSeconds(sourceName, lagSeconds(row.createdAt));
          const outcome = await this.dispatchRow(source, sourceName, row);
          dispatched += outcome.dispatched;
          failed += outcome.failed;
          deadLettered += outcome.deadLettered;
        }

        this.metrics.recordPoll(sourceName, 'ok');
        span.setAttributes({
          'outbox_relay.claimed': claimed,
          'outbox_relay.dispatched': dispatched,
          'outbox_relay.failed': failed,
          'outbox_relay.dead_lettered': deadLettered,
        });
        return { source: sourceName, claimed, dispatched, failed, deadLettered };
      } finally {
        this.metrics.recordPollDuration(sourceName, durationSeconds(startNs));
      }
    });
  }

  /**
   * Publish one row + stamp it dispatched. Returns the per-row deltas
   * the caller folds into the source summary. Never throws — every
   * failure path is caught, logged, and reflected in the returned
   * counts + the metrics.
   */
  private async dispatchRow(
    source: OutboxSource,
    sourceName: string,
    row: OutboxRow,
  ): Promise<{ dispatched: number; failed: number; deadLettered: number }> {
    return withSpan('outbox_relay.dispatch_row', async (span) => {
      span.setAttributes({
        'outbox_relay.source': sourceName,
        'outbox_relay.event_name': row.eventName,
        'messaging.message.id': row.eventId,
      });

      const publishStartNs = process.hrtime.bigint();
      try {
        await this.publisher.publish(row);
      } catch (err) {
        this.metrics.recordPublishDuration(sourceName, durationSeconds(publishStartNs));
        const message = extractError(err).message;
        const reason = classifyFailureReason(message);
        this.log.warn(
          {
            source: sourceName,
            eventId: row.eventId,
            attempts: row.attempts,
            reason,
            err: message,
          },
          'relay.publish failed — recording failure',
        );
        this.metrics.recordFailed(sourceName, row.eventName, reason);
        let deadLettered = 0;
        try {
          await this.repository.recordFailure(source, row.eventId, message);
          if (row.attempts + 1 >= this.options.maxAttempts) {
            deadLettered = 1;
            this.metrics.recordDeadLettered(sourceName, row.eventName);
            this.log.error(
              { source: sourceName, eventId: row.eventId, attempts: row.attempts + 1 },
              'relay.row dead-lettered — attempts exhausted, ops attention required',
            );
          }
        } catch (recordErr) {
          this.log.error(
            { source: sourceName, eventId: row.eventId, err: extractError(recordErr) },
            'relay.recordFailure failed — row will be retried next cycle without attempt increment',
          );
        }
        return { dispatched: 0, failed: 1, deadLettered };
      }
      this.metrics.recordPublishDuration(sourceName, durationSeconds(publishStartNs));

      try {
        await this.repository.markDispatched(source, row.eventId);
        this.metrics.recordDispatched(sourceName, row.eventName);
        return { dispatched: 1, failed: 0, deadLettered: 0 };
      } catch (markErr) {
        // We published but couldn't stamp. The next cycle will
        // re-claim and re-publish — consumer dedups on event_id.
        this.log.warn(
          { source: sourceName, eventId: row.eventId, err: extractError(markErr) },
          'relay.markDispatched failed after successful publish — row will be re-dispatched next cycle',
        );
        return { dispatched: 0, failed: 0, deadLettered: 0 };
      }
    });
  }
}

export interface RelayWorkerOptions {
  readonly sources: readonly OutboxSource[];
  readonly batchSize: number;
  readonly maxAttempts: number;
}

function extractError(err: unknown): { message: string } {
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

/** Seconds elapsed since a `process.hrtime.bigint()` mark. */
function durationSeconds(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e9;
}

/**
 * Wall-clock staleness of a row in seconds (`now − created_at`),
 * clamped at 0 so clock skew between the producer and the relay host
 * can never record a negative lag.
 */
function lagSeconds(createdAt: Date): number {
  return Math.max(0, (Date.now() - createdAt.getTime()) / 1000);
}
