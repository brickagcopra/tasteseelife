import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EventName } from '@taste-and-see/contracts';

import type { ValidatedConsumerOptions } from '../config';
import {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_OPTIONS_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '../module/tokens';
import {
  asConsumerRedisClient,
  ensureConsumerGroup,
  flattenXreadgroupResponse,
  type ConsumerRedisClient,
} from './redis-stream-consumer';
import { parseStreamEntry } from './stream-entry-parser';
import type {
  ConsumerDedupStore,
  ConsumerHandler,
  HandlerRegistration,
  ParsedStreamEntry,
} from './types';

/**
 * Summary returned by `pollOnce` — purely diagnostic so callers (the
 * scheduler, integration tests) can assert progress is being made.
 */
export interface PollSummary {
  readonly entriesRead: number;
  readonly handlersInvoked: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly skippedAlreadyProcessed: number;
}

/**
 * Aggregate consumer orchestrator.
 *
 * Lifecycle:
 *   1. `registerHandler(eventName, handler)` — called from feature
 *      modules' `OnModuleInit`. Tracks the set of subscribed streams.
 *   2. `bootstrap()` — called by the scheduler (or tests) AFTER every
 *      handler is registered. Creates the per-event Redis consumer
 *      group with MKSTREAM (idempotent on BUSYGROUP).
 *   3. `pollOnce()` — single read+dispatch cycle. The scheduler invokes
 *      this on a timer; tests invoke it directly.
 *
 * Why bootstrap is split from registration: registration happens across
 * potentially many feature modules' `OnModuleInit` hooks (Nest doesn't
 * guarantee a global init order across @Global modules). The scheduler
 * runs after every module has initialised; `bootstrap()` is the single
 * gate where the SDK knows the full set of subscribed streams. Once
 * `bootstrap()` has run, `registerHandler` becomes a no-op + logs a
 * warning so a late-registered handler can be diagnosed in dev.
 */
@Injectable()
export class OutboxConsumerService {
  private readonly log = new Logger('OutboxConsumerService');
  private readonly handlers = new Map<EventName, ConsumerHandler<EventName>>();
  private readonly redis: ConsumerRedisClient;
  private bootstrapped = false;

  constructor(
    @Inject(OUTBOX_CONSUMER_OPTIONS_TOKEN)
    private readonly options: ValidatedConsumerOptions,
    @Inject(OUTBOX_CONSUMER_REDIS_TOKEN)
    redis: ConsumerRedisClient,
    @Inject(OUTBOX_CONSUMER_DEDUP_STORE_TOKEN)
    private readonly dedup: ConsumerDedupStore,
  ) {
    this.redis = redis;
  }

  /** Register a typed handler. Call from `OnModuleInit` of a feature module. */
  registerHandler<N extends EventName>(eventName: N, handler: ConsumerHandler<N>): void {
    if (this.bootstrapped) {
      this.log.warn(
        `registerHandler called after bootstrap for '${eventName}' — the stream will not be subscribed until the next service restart.`,
      );
    }
    if (this.handlers.has(eventName)) {
      this.log.warn(`registerHandler called twice for '${eventName}' — last registration wins.`);
    }
    // Cast widens the generic to the storage shape; the typed envelope
    // is preserved at the call site via the `HandleArgs<N>` signature.
    this.handlers.set(eventName, handler as ConsumerHandler<EventName>);
  }

  /** Register multiple handlers in one shot. */
  registerHandlers(registrations: ReadonlyArray<HandlerRegistration>): void {
    for (const r of registrations) {
      this.registerHandler(r.eventName, r.handler);
    }
  }

  /** Test-friendly snapshot of which event names have registered handlers. */
  registeredEventNames(): readonly EventName[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Create the per-event consumer group on Redis. Idempotent on
   * BUSYGROUP (the happy path after every restart). Must be called
   * before the first `pollOnce()` — the scheduler enforces this.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    for (const eventName of this.handlers.keys()) {
      const streamKey = this.streamKey(eventName);
      await ensureConsumerGroup(this.redis, streamKey, this.options.consumerGroup);
      this.log.log(`consumer group '${this.options.consumerGroup}' ready on stream '${streamKey}'`);
    }
    this.bootstrapped = true;
  }

  /**
   * Run one read+dispatch cycle. Returns a summary so the scheduler
   * (and tests) can observe progress. Failures inside a handler are
   * caught + recorded; the cycle stays alive so a single misbehaving
   * handler doesn't starve the others.
   */
  async pollOnce(): Promise<PollSummary> {
    if (!this.bootstrapped) {
      throw new Error(
        'OutboxConsumerService.pollOnce called before bootstrap — call bootstrap() first or use the RelayScheduler.',
      );
    }
    const eventNames = Array.from(this.handlers.keys());
    if (eventNames.length === 0) {
      return emptySummary();
    }
    const summary: Mutable<PollSummary> = emptyMutableSummary();

    // 1. Reclaim idle pending entries first — entries left dangling by
    //    a crashed pod. XAUTOCLAIM scans the PEL for entries idle past
    //    `reclaimIdleMs` and re-delivers them to THIS consumer.
    //    Returns a list of reclaimed entries in the same shape as
    //    XREADGROUP, so we can fold them into the same dispatch loop.
    const reclaimed = await this.reclaimIdleEntries(eventNames);

    // 2. Read fresh entries for every subscribed stream via
    //    XREADGROUP. The `>` ID means "everything not yet delivered
    //    to me"; BLOCK waits for new entries up to `pollBlockMs`.
    const fresh = await this.readFresh(eventNames);

    const all = [...reclaimed, ...fresh];
    summary.entriesRead = all.length;

    for (const item of all) {
      await this.handleEntry(item, summary);
    }
    return summary;
  }

  /**
   * Read newly-undelivered entries from every subscribed stream.
   * Returns the flat list of (streamKey, streamId, fields) tuples for
   * the orchestrator to dispatch.
   */
  private async readFresh(eventNames: readonly EventName[]): Promise<
    ReadonlyArray<{
      readonly streamKey: string;
      readonly streamId: string;
      readonly fields: readonly string[];
    }>
  > {
    const streams: string[] = eventNames.map((n) => this.streamKey(n));
    // XREADGROUP arg structure:
    //   GROUP <name> <consumer>
    //   COUNT <n>
    //   BLOCK <ms>
    //   STREAMS <k1> <k2> ... <id1> <id2> ...
    // Where ids are all `>` to read undelivered entries.
    const args: Array<string | number> = [
      'GROUP',
      this.options.consumerGroup,
      this.options.consumerName,
      'COUNT',
      32,
      'BLOCK',
      this.options.pollBlockMs,
      'STREAMS',
      ...streams,
      ...streams.map(() => '>'),
    ];
    try {
      const raw = await this.redis.xreadgroup(...args);
      return flattenXreadgroupResponse(raw);
    } catch (e) {
      this.log.warn(`xreadgroup failed; cycle continues: ${messageOf(e)}`);
      return [];
    }
  }

  /**
   * Reclaim idle pending entries via XAUTOCLAIM. Each call returns up
   * to 32 entries idle past `reclaimIdleMs` from any consumer in the
   * group; the SDK iterates per-stream. Entries claimed move into THIS
   * consumer's PEL so they will be redelivered + dispatched by the
   * same `handleEntry` path.
   */
  private async reclaimIdleEntries(eventNames: readonly EventName[]): Promise<
    ReadonlyArray<{
      readonly streamKey: string;
      readonly streamId: string;
      readonly fields: readonly string[];
    }>
  > {
    const out: Array<{
      streamKey: string;
      streamId: string;
      fields: readonly string[];
    }> = [];
    for (const eventName of eventNames) {
      const streamKey = this.streamKey(eventName);
      try {
        const raw = await this.redis.xautoclaim(
          streamKey,
          this.options.consumerGroup,
          this.options.consumerName,
          this.options.reclaimIdleMs,
          '0-0', // start from the beginning of the PEL
          'COUNT',
          32,
        );
        const reclaimed = parseXautoclaimResponse(raw);
        for (const entry of reclaimed) {
          out.push({
            streamKey,
            streamId: entry.streamId,
            fields: entry.fields,
          });
        }
      } catch (e) {
        this.log.warn(
          `xautoclaim failed for stream '${streamKey}'; cycle continues: ${messageOf(e)}`,
        );
      }
    }
    return out;
  }

  /**
   * Dispatch a single parsed stream entry to its handler. Updates the
   * summary counters for the cycle.
   */
  private async handleEntry(
    item: {
      readonly streamKey: string;
      readonly streamId: string;
      readonly fields: readonly string[];
    },
    summary: Mutable<PollSummary>,
  ): Promise<void> {
    const parsed = parseStreamEntry(item.streamId, item.fields);
    if (parsed.kind === 'invalid') {
      // Permanent malformed entry. Skip the handler entirely; record
      // as dead-letter so the dedup table carries the trail; XACK so
      // the entry leaves the PEL and doesn't loop.
      this.log.error(
        `stream entry invalid — dead-lettering: streamId=${parsed.streamId} eventName=${parsed.eventName ?? '<unknown>'} reason=${parsed.reason}`,
      );
      if (parsed.eventId !== null) {
        try {
          await this.dedup.recordDeadLetter(
            this.options.consumerGroup,
            parsed.eventId,
            parsed.reason,
          );
        } catch (e) {
          this.log.warn(
            `dedup.recordDeadLetter failed for invalid entry ${parsed.eventId}: ${messageOf(e)}`,
          );
        }
      }
      summary.deadLettered += 1;
      await this.xackSafely(item.streamKey, item.streamId);
      return;
    }

    const entry = parsed.entry;
    const handler = this.handlers.get(entry.eventName);
    if (handler === undefined) {
      // No handler — typically a stream subscribed under a different
      // event that flowed through our consumer group. Defensive: XACK
      // so the entry doesn't loop, log so ops notice.
      this.log.warn(
        `no handler registered for '${entry.eventName}'; XACKing to drop entry ${entry.eventId}`,
      );
      await this.xackSafely(item.streamKey, item.streamId);
      return;
    }

    // Dedup short-circuit: if the event has already been processed,
    // skip handler invocation + XACK so the entry leaves the PEL.
    const state = await this.dedup.getState(this.options.consumerGroup, entry.eventId);
    if (state.kind === 'processed' || state.kind === 'dead_lettered') {
      summary.skippedAlreadyProcessed += 1;
      await this.xackSafely(item.streamKey, item.streamId);
      return;
    }

    // Check whether the next attempt would breach the cap. If yes,
    // dead-letter without invoking the handler — guards against an
    // infinite reclaim loop on a perpetually failing handler.
    const nextAttempts = state.kind === 'in_flight' ? state.attempts + 1 : 1;
    if (nextAttempts > this.options.maxAttempts) {
      this.log.error(
        `event ${entry.eventId} (${entry.eventName}) exhausted ${this.options.maxAttempts} attempts; dead-lettering`,
      );
      try {
        await this.dedup.recordDeadLetter(
          this.options.consumerGroup,
          entry.eventId,
          `exceeded maxAttempts=${this.options.maxAttempts}`,
        );
      } catch (e) {
        this.log.warn(`dedup.recordDeadLetter failed for ${entry.eventId}: ${messageOf(e)}`);
      }
      summary.deadLettered += 1;
      await this.xackSafely(item.streamKey, item.streamId);
      return;
    }

    // Record the attempt + invoke the handler.
    try {
      await this.dedup.recordAttempt(this.options.consumerGroup, entry.eventId, entry.eventName);
    } catch (e) {
      this.log.warn(
        `dedup.recordAttempt failed for ${entry.eventId}: ${messageOf(e)}; continuing to handler invocation`,
      );
    }

    summary.handlersInvoked += 1;

    try {
      await handler({
        envelope: {
          eventId: entry.eventId,
          eventName: entry.eventName,
          occurredAt: entry.occurredAt,
          producerService: entry.producerService,
          producerSchema: entry.producerSchema,
        },
        payload: entry.payload as never,
      });
    } catch (e) {
      const error = messageOf(e);
      this.log.warn(`handler '${entry.eventName}' threw for event ${entry.eventId}: ${error}`);
      try {
        await this.dedup.recordFailure(this.options.consumerGroup, entry.eventId, error);
      } catch (eDedup) {
        this.log.warn(`dedup.recordFailure failed for ${entry.eventId}: ${messageOf(eDedup)}`);
      }
      summary.failed += 1;
      // DO NOT XACK — leave the entry in the PEL so XAUTOCLAIM picks
      // it up on the next cycle. After maxAttempts cycles the
      // attempt-cap branch above dead-letters.
      return;
    }

    // Handler success — mark processed + XACK.
    try {
      await this.dedup.recordSuccess(this.options.consumerGroup, entry.eventId);
    } catch (e) {
      this.log.warn(
        `dedup.recordSuccess failed for ${entry.eventId}: ${messageOf(e)}; XACK proceeds — handler ran exactly once at the side-effect layer`,
      );
    }
    summary.succeeded += 1;
    await this.xackSafely(item.streamKey, item.streamId);
  }

  private streamKey(eventName: EventName): string {
    return `${this.options.streamPrefix}:${eventName}`;
  }

  private async xackSafely(streamKey: string, streamId: string): Promise<void> {
    try {
      await this.redis.xack(streamKey, this.options.consumerGroup, streamId);
    } catch (e) {
      this.log.warn(
        `xack failed for ${streamKey}/${streamId}: ${messageOf(e)}; next reclaim may redeliver`,
      );
    }
  }
}

function emptySummary(): PollSummary {
  return emptyMutableSummary();
}

function emptyMutableSummary(): Mutable<PollSummary> {
  return {
    entriesRead: 0,
    handlersInvoked: 0,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
    skippedAlreadyProcessed: 0,
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(e);
}

/**
 * Parse the XAUTOCLAIM response into the same flat shape XREADGROUP
 * uses downstream. ioredis surfaces `[nextCursor, [[id, fields], ...]
 * [, deletedIds]]`. We discard the cursor (the SDK always starts from
 * `0-0` since reclaim is best-effort and the next cycle re-scans).
 */
function parseXautoclaimResponse(raw: unknown): ReadonlyArray<{
  streamId: string;
  fields: readonly string[];
}> {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const entries = raw[1];
  if (!Array.isArray(entries)) return [];
  const out: Array<{ streamId: string; fields: readonly string[] }> = [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [streamId, fields] = entry;
    if (typeof streamId !== 'string') continue;
    if (!Array.isArray(fields)) continue;
    const stringFields: string[] = [];
    for (const f of fields) {
      if (typeof f === 'string') stringFields.push(f);
      else if (Buffer.isBuffer(f)) stringFields.push(f.toString('utf-8'));
      else stringFields.push(String(f));
    }
    out.push({ streamId, fields: stringFields });
  }
  return out;
}

// Re-export helpers for tests / advanced callers.
export { asConsumerRedisClient, type ParsedStreamEntry };
