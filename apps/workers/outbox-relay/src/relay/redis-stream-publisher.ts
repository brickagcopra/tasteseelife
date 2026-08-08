import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import type { OutboxRow } from './types';

/**
 * Abstracts the wire-protocol step: take an outbox row and put it on
 * the bus. Phase 1 = Redis Streams; Phase 3 = Kafka (per PDD §29.1).
 * Different concrete publishers can be plugged in without touching
 * the relay's polling logic.
 */
export interface BusPublisher {
  publish(row: OutboxRow): Promise<void>;
}

/**
 * Redis Streams concrete implementation. Each event-name gets its own
 * stream — `events:subscription.activated`, `events:booking.completed`,
 * etc. Consumers read with `XREADGROUP` against a per-consumer
 * group; the relay never reads back the stream.
 *
 * Wire fields per stream entry (the standard XADD key-value list):
 *   event_id          — the dedup key consumers idempotency-check on
 *   event_name        — for fan-out / routing without parsing payload
 *   payload           — JSON-stringified domain payload
 *   occurred_at       — producer-wall-clock ISO8601
 *   producer_service  — for tracing / debugging
 *   schema            — origin source (subscription / booking / ...)
 *
 * `XADD MAXLEN ~ <bound>` keeps each stream from growing unbounded.
 * The `~` form lets Redis trim efficiently — consumers must not
 * rely on stream retention beyond the configured bound (the durable
 * persistence layer is the producer's outbox table, not the stream).
 */
export class RedisStreamPublisher implements BusPublisher {
  private readonly log = new Logger('RedisStreamPublisher');

  constructor(
    private readonly redis: Redis,
    private readonly streamNamePrefix: string,
    private readonly streamMaxLen: number,
  ) {}

  async publish(row: OutboxRow): Promise<void> {
    const streamKey = `${this.streamNamePrefix}:${row.eventName}`;
    const payloadJson = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);

    // ioredis surfaces XADD via a typed wrapper. The MAXLEN ~ N
    // arguments come BEFORE the `*` auto-id token and the key/value
    // pairs — see Redis docs for XADD.
    //
    // Using xadd(...) with a positional argument list because ioredis
    // 5.x's typed signature can't express the MAXLEN form
    // exhaustively. The `xadd` method accepts a rest-args of strings
    // / numbers / Buffers — typed as `RedisCommander.xadd`.
    await this.redis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      String(this.streamMaxLen),
      '*',
      'event_id',
      row.eventId,
      'event_name',
      row.eventName,
      'payload',
      payloadJson,
      'occurred_at',
      row.occurredAt.toISOString(),
      'producer_service',
      row.producerService,
      'schema',
      row.schema,
    );

    this.log.debug(`xadd stream=${streamKey} eventId=${row.eventId} eventName=${row.eventName}`);
  }
}
