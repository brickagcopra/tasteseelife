import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'worker-outbox-relay:relay';

/**
 * Bounded classification of a row's dispatch failure. NEVER the raw
 * publish-error message — that is unbounded cardinality + a PII risk
 * (CLAUDE.md §10): a Redis driver error can echo back connection
 * strings or payload fragments. The relay collapses every publish
 * failure into one of these fixed buckets via {@link classifyFailureReason}.
 *
 *   - `bus_unavailable` — the Redis Streams bus is unreachable
 *     (connection refused / reset / timeout). The dominant operational
 *     case: a Redis outage. Alert on a sustained rate here.
 *   - `publish_rejected` — the XADD round-trip reached Redis but the
 *     command itself failed (e.g. WRONGTYPE on a misused stream key,
 *     OOM eviction policy rejection). Rarer; points at a data/config
 *     defect rather than an outage.
 *   - `unknown` — anything that doesn't match the above patterns.
 */
export type RelayFailureReason = 'bus_unavailable' | 'publish_rejected' | 'unknown';

/**
 * Map a publish-error message to a bounded {@link RelayFailureReason}.
 * Pattern-matches on the message text but emits ONLY the closed-enum
 * label — the raw message stays in the (redacted) log line, never on a
 * metric label.
 */
export function classifyFailureReason(message: string): RelayFailureReason {
  const m = message.toLowerCase();
  if (
    m.includes('econnrefused') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('connection is closed') ||
    m.includes('connection closed') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('unavailable') ||
    m.includes('not connected') ||
    m.includes('enotfound')
  ) {
    return 'bus_unavailable';
  }
  if (
    m.includes('wrongtype') ||
    m.includes('oom') ||
    m.includes('readonly') ||
    m.includes("can't write") ||
    m.includes('err ')
  ) {
    return 'publish_rejected';
  }
  return 'unknown';
}

/**
 * The relay's domain Prometheus instruments (TS-142-followup-4):
 *
 *   - `outbox_relay_polls_total{source,outcome}` (counter) — one poll
 *     cycle per source, partitioned by `outcome=ok|claim_failed`. A
 *     rising `claim_failed` rate means Postgres is unreachable for that
 *     source; `ok` proves the relay is alive even when there's nothing
 *     to dispatch (distinguishes "idle" from "crashed").
 *   - `outbox_relay_rows_dispatched_total{source,event_name}` (counter)
 *     — rows successfully XADD'd onto the bus, by source + event name.
 *     The throughput signal + per-event fan-out volume.
 *   - `outbox_relay_rows_failed_total{source,event_name,reason}`
 *     (counter) — per-row publish failures, with a bounded
 *     {@link RelayFailureReason}. A failed row is retried next cycle
 *     until `attempts` hits the cap; alert on a sustained rate.
 *   - `outbox_relay_rows_dead_lettered_total{source,event_name}`
 *     (counter) — rows whose `attempts` reached `MAX_ATTEMPTS` this
 *     cycle. Every increment is an ops escalation: the event never
 *     reached the bus and won't be retried automatically.
 *   - `outbox_relay_lag_seconds{source}` (histogram) — `now − created_at`
 *     of each claimed row, in seconds. The end-to-end staleness of
 *     undispatched events: a rising p99 means the relay is falling
 *     behind producer write volume (raise BATCH_SIZE / lower
 *     POLL_INTERVAL_MS / add a replica — TS-142-followup-8).
 *   - `outbox_relay_poll_duration_seconds{source}` (histogram) —
 *     wall-clock of one whole per-source cycle (claim + publish + mark).
 *   - `outbox_relay_publish_duration_seconds{source}` (histogram) —
 *     wall-clock of the single XADD round-trip (the externally-coupled
 *     stage). Isolates Redis latency from the Postgres claim/mark stages.
 *
 * Label cardinality is bounded by construction: `source` is one of the
 * fixed `OUTBOX_SOURCES` entries (`schema.table`); `event_name` is a
 * registered event from `packages/contracts/src/events` (never
 * user-derived); `reason` + `outcome` are closed enums. No payload,
 * event_id, user_id, or raw error text ever reaches a label
 * (CLAUDE.md §10 PII discipline).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests and CLI contexts without booting the SDK.
 */
@Injectable()
export class RelayMetrics {
  private readonly polls: Counter;
  private readonly rowsDispatched: Counter;
  private readonly rowsFailed: Counter;
  private readonly rowsDeadLettered: Counter;
  private readonly lagSeconds: Histogram;
  private readonly pollDuration: Histogram;
  private readonly publishDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.polls = meter.createCounter('outbox_relay_polls_total', {
      description: 'Total relay poll cycles, by source and outcome (ok|claim_failed)',
    });
    this.rowsDispatched = meter.createCounter('outbox_relay_rows_dispatched_total', {
      description: 'Total outbox rows published onto the bus, by source and event name',
    });
    this.rowsFailed = meter.createCounter('outbox_relay_rows_failed_total', {
      description: 'Total outbox-row publish failures, by source, event name, and bounded reason',
    });
    this.rowsDeadLettered = meter.createCounter('outbox_relay_rows_dead_lettered_total', {
      description: 'Total outbox rows dead-lettered (attempts exhausted), by source and event name',
    });
    this.lagSeconds = meter.createHistogram('outbox_relay_lag_seconds', {
      description: 'Staleness (now − created_at) of each claimed outbox row in seconds',
      unit: 's',
    });
    this.pollDuration = meter.createHistogram('outbox_relay_poll_duration_seconds', {
      description: 'Wall-clock duration of one per-source relay poll cycle in seconds',
      unit: 's',
    });
    this.publishDuration = meter.createHistogram('outbox_relay_publish_duration_seconds', {
      description: 'Wall-clock duration of the single XADD publish round-trip in seconds',
      unit: 's',
    });
  }

  /** Record a completed poll cycle for `source` with its outcome. */
  recordPoll(source: string, outcome: 'ok' | 'claim_failed'): void {
    this.polls.add(1, { source, outcome });
  }

  /** Increment the dispatched counter for one successfully-published row. */
  recordDispatched(source: string, eventName: string): void {
    this.rowsDispatched.add(1, { source, event_name: eventName });
  }

  /** Increment the failure counter for one row whose publish threw. */
  recordFailed(source: string, eventName: string, reason: RelayFailureReason): void {
    this.rowsFailed.add(1, { source, event_name: eventName, reason });
  }

  /** Increment the dead-letter counter for one row whose attempts hit the cap. */
  recordDeadLettered(source: string, eventName: string): void {
    this.rowsDeadLettered.add(1, { source, event_name: eventName });
  }

  /** Record a claimed row's staleness (now − created_at) in seconds. */
  recordLagSeconds(source: string, seconds: number): void {
    this.lagSeconds.record(seconds, { source });
  }

  /** Record the whole-cycle wall-clock duration for `source` in seconds. */
  recordPollDuration(source: string, seconds: number): void {
    this.pollDuration.record(seconds, { source });
  }

  /** Record the single XADD publish round-trip duration for `source` in seconds. */
  recordPublishDuration(source: string, seconds: number): void {
    this.publishDuration.record(seconds, { source });
  }
}
