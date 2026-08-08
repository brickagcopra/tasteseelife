import type { Redis } from 'ioredis';

import type { ClaimOutcome, CompletedRecord, IdempotencyStore } from './types';

/**
 * Production `IdempotencyStore` backed by ioredis.
 *
 * Persistence model. Two record shapes share a single Redis key:
 *
 *   `in_flight` — a JSON marker written via `SET key value EX <ttl> NX`.
 *     Successful NX SET means we won the claim. Failed NX SET means a
 *     concurrent request beat us to it.
 *   `completed` — written on handler completion via `SET key value EX <ttl>`
 *     (no NX — we expect the in-flight marker to already exist; overwriting
 *     it is exactly what we want).
 *
 * Why the same key for both states (vs. two keys, one per state). Single
 * key means the "second concurrent request" path is one round-trip:
 * the failed NX SET tells us *something* is there; the follow-up GET
 * decodes which state. Splitting into two keys would require a Lua
 * script or two round-trips with a TOCTOU window between them.
 *
 * Best-effort. Per CLAUDE.md §4.3 ("Caches are best-effort: code must
 * work correctly when Redis is unavailable"), every Redis call is
 * wrapped — failures surface as `unavailable` claim outcomes (the
 * interceptor proceeds without caching) and as quiet `false` returns
 * from `complete` / `release` (the response still goes back to the
 * client).
 *
 * Hidden serialisation surface. The persisted shape is JSON with a
 * `version` field. Adding a field is backward-compatible (older
 * readers ignore unknown keys); changing or removing a field requires
 * bumping the version. Today version is `1`.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly inFlightTtlSeconds: number,
    private readonly logger?: { warn: (...args: unknown[]) => void } | undefined,
  ) {}

  async claim(key: string, bodyHash: string): Promise<ClaimOutcome> {
    const inFlightPayload = serialise({
      version: 1,
      state: 'in_flight',
      bodyHash,
    });
    try {
      const setResult = await this.redis.set(
        key,
        inFlightPayload,
        'EX',
        this.inFlightTtlSeconds,
        'NX',
      );
      if (setResult === 'OK') {
        return { kind: 'claimed' };
      }
    } catch (err) {
      this.logger?.warn('idempotency.claim failed', err);
      return { kind: 'unavailable', cause: err };
    }

    // SET NX failed — something exists. Decode it.
    let existing: string | null;
    try {
      existing = await this.redis.get(key);
    } catch (err) {
      this.logger?.warn('idempotency.claim GET failed', err);
      return { kind: 'unavailable', cause: err };
    }

    if (existing === null) {
      // The record vanished between NX-fail and GET (TTL expired). The
      // safest action is to retry the claim once. Bounded retry: just
      // one shot — a second NX-fail/GET-null cycle is vanishingly
      // unlikely and falls through as `unavailable` so the interceptor
      // proceeds without caching rather than spinning.
      try {
        const retry = await this.redis.set(
          key,
          inFlightPayload,
          'EX',
          this.inFlightTtlSeconds,
          'NX',
        );
        if (retry === 'OK') return { kind: 'claimed' };
      } catch (err) {
        this.logger?.warn('idempotency.claim retry failed', err);
        return { kind: 'unavailable', cause: err };
      }
      return { kind: 'unavailable', cause: 'race-with-expiry' };
    }

    const decoded = decode(existing);
    if (decoded === null) {
      // Corrupt payload — log + treat as unavailable. Don't try to
      // overwrite (could be another writer mid-transition).
      this.logger?.warn('idempotency.claim corrupt payload', { key });
      return { kind: 'unavailable', cause: 'corrupt-payload' };
    }

    if (decoded.state === 'in_flight') {
      let ttlSeconds = this.inFlightTtlSeconds;
      try {
        const ttl = await this.redis.ttl(key);
        if (ttl > 0) ttlSeconds = ttl;
      } catch {
        // ttl probe is best-effort.
      }
      return {
        kind: 'in_flight',
        storedBodyHash: decoded.bodyHash,
        ttlSeconds,
      };
    }

    if (decoded.bodyHash !== bodyHash) {
      return { kind: 'cached_mismatch', storedBodyHash: decoded.bodyHash };
    }

    return {
      kind: 'cached_hit',
      record: {
        state: 'completed',
        bodyHash: decoded.bodyHash,
        statusCode: decoded.statusCode,
        body: decoded.body,
        contentType: decoded.contentType,
        cachedAt: decoded.cachedAt,
      },
    };
  }

  async complete(
    key: string,
    record: Omit<CompletedRecord, 'state' | 'cachedAt'>,
  ): Promise<boolean> {
    const payload = serialise({
      version: 1,
      state: 'completed',
      bodyHash: record.bodyHash,
      statusCode: record.statusCode,
      body: record.body,
      contentType: record.contentType,
      cachedAt: new Date().toISOString(),
    });
    try {
      const result = await this.redis.set(key, payload, 'EX', this.ttlSeconds);
      return result === 'OK';
    } catch (err) {
      this.logger?.warn('idempotency.complete failed', err);
      return false;
    }
  }

  async release(key: string): Promise<void> {
    try {
      // Use a small Lua script so we delete ONLY if the value is an
      // in_flight marker — don't accidentally erase a `completed` record
      // we wrote in the interim.
      await this.redis.eval(RELEASE_SCRIPT, 1, key);
    } catch (err) {
      this.logger?.warn('idempotency.release failed', err);
    }
  }
}

const RELEASE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value == false then return 0 end
local ok, decoded = pcall(cjson.decode, value)
if not ok then return 0 end
if decoded.state == 'in_flight' then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

interface InFlightPayload {
  readonly version: 1;
  readonly state: 'in_flight';
  readonly bodyHash: string;
}

interface CompletedPayload {
  readonly version: 1;
  readonly state: 'completed';
  readonly bodyHash: string;
  readonly statusCode: number;
  readonly body: string;
  readonly contentType: string;
  readonly cachedAt: string;
}

type Payload = InFlightPayload | CompletedPayload;

function serialise(payload: Payload): string {
  return JSON.stringify(payload);
}

function decode(raw: string): Payload | null {
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    const o = obj as Record<string, unknown>;
    if (o['version'] !== 1) return null;
    if (o['state'] === 'in_flight' && typeof o['bodyHash'] === 'string') {
      return { version: 1, state: 'in_flight', bodyHash: o['bodyHash'] };
    }
    if (
      o['state'] === 'completed' &&
      typeof o['bodyHash'] === 'string' &&
      typeof o['statusCode'] === 'number' &&
      typeof o['body'] === 'string' &&
      typeof o['contentType'] === 'string' &&
      typeof o['cachedAt'] === 'string'
    ) {
      return {
        version: 1,
        state: 'completed',
        bodyHash: o['bodyHash'],
        statusCode: o['statusCode'],
        body: o['body'],
        contentType: o['contentType'],
        cachedAt: o['cachedAt'],
      };
    }
    return null;
  } catch {
    return null;
  }
}
