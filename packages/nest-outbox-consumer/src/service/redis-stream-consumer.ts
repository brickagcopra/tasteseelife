import type { Redis } from 'ioredis';

/**
 * Slim ioredis surface the consumer needs. Defining the shape locally
 * keeps the SDK testable with a fake (the unit tests cannot stand up a
 * real Redis without TS-009e Testcontainers) and decouples the package
 * from a specific ioredis major version.
 */
export interface ConsumerRedisClient {
  /** XGROUP CREATE; MKSTREAM. Caller swallows BUSYGROUP on existing. */
  call(...args: Array<string | number>): Promise<unknown>;
  xreadgroup(...args: Array<string | number>): Promise<unknown>;
  xack(stream: string, group: string, ...ids: string[]): Promise<number>;
  xautoclaim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number | string,
    start: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  xpending(stream: string, group: string, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Cast helper — the consumer service receives an ioredis `Redis`
 * instance via DI; the local `ConsumerRedisClient` interface narrows
 * to the subset of methods the consumer actually invokes. The cast
 * here is the boundary; downstream code stays type-clean.
 */
export function asConsumerRedisClient(redis: Redis): ConsumerRedisClient {
  return redis as unknown as ConsumerRedisClient;
}

/**
 * Ensure the consumer group exists for a stream. Idempotent: Redis
 * returns BUSYGROUP if the group already exists, which is the expected
 * happy path after the first consumer-pod start. Any other error is
 * surfaced to the caller (typically the scheduler's startup hook).
 *
 * `MKSTREAM` creates the underlying stream if it does not yet exist —
 * essential because the relay only XADDs entries that the producer
 * actually emits, so a fresh deployment of the consumer service may
 * boot before the producer side has emitted its first event. Without
 * MKSTREAM the XGROUP CREATE call would fail with ERR no such key.
 */
export async function ensureConsumerGroup(
  redis: ConsumerRedisClient,
  streamKey: string,
  consumerGroup: string,
): Promise<void> {
  try {
    await redis.call('XGROUP', 'CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
  } catch (e) {
    if (!isBusyGroupError(e)) {
      throw e;
    }
    // BUSYGROUP — the group already exists, which is the happy path
    // on every restart after the first. Swallow silently.
  }
}

function isBusyGroupError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const message = (e as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return message.includes('BUSYGROUP');
}

/**
 * Parse the raw XREADGROUP response into a flat array of
 * (streamKey, streamId, fields) tuples. ioredis surfaces the response
 * as `[[streamKey, [[streamId, [k, v, k, v, ...]], ...]], ...]` — a
 * doubly-nested shape that's awkward to consume directly.
 */
export function flattenXreadgroupResponse(raw: unknown): ReadonlyArray<{
  readonly streamKey: string;
  readonly streamId: string;
  readonly fields: readonly string[];
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    streamKey: string;
    streamId: string;
    fields: readonly string[];
  }> = [];
  for (const streamGroup of raw) {
    if (!Array.isArray(streamGroup)) continue;
    const [streamKey, entries] = streamGroup;
    if (typeof streamKey !== 'string') continue;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const [streamId, fields] = entry;
      if (typeof streamId !== 'string') continue;
      if (!Array.isArray(fields)) continue;
      // The fields array alternates [key, value, key, value, ...]
      // ioredis stringifies values; the consumer parses to its types
      // downstream.
      const stringFields: string[] = [];
      for (const f of fields) {
        if (typeof f === 'string') stringFields.push(f);
        else if (Buffer.isBuffer(f)) stringFields.push(f.toString('utf-8'));
        else stringFields.push(String(f));
      }
      out.push({
        streamKey,
        streamId,
        fields: stringFields,
      });
    }
  }
  return out;
}
