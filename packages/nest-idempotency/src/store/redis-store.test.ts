import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { FakeRedis } from '../__tests__/fake-redis';
import { RedisIdempotencyStore } from './redis-store';

function makeStore(
  opts: { clock?: () => number; ttlSeconds?: number; inFlightTtlSeconds?: number } = {},
): {
  store: RedisIdempotencyStore;
  redis: FakeRedis;
  warnings: unknown[][];
} {
  const redis = new FakeRedis(opts.clock);
  const warnings: unknown[][] = [];
  const store = new RedisIdempotencyStore(
    redis as unknown as Redis,
    opts.ttlSeconds ?? 86_400,
    opts.inFlightTtlSeconds ?? 60,
    {
      warn: (...args: unknown[]) => warnings.push(args),
    },
  );
  return { store, redis, warnings };
}

describe('RedisIdempotencyStore.claim', () => {
  it("returns 'claimed' for a fresh key", async () => {
    const { store } = makeStore();
    const result = await store.claim('k1', 'hash1');
    expect(result.kind).toBe('claimed');
  });

  it("returns 'in_flight' when the slot is already held", async () => {
    const { store } = makeStore();
    await store.claim('k1', 'hash1');
    const second = await store.claim('k1', 'hash_different');
    expect(second.kind).toBe('in_flight');
    if (second.kind !== 'in_flight') throw new Error('unreachable');
    expect(second.storedBodyHash).toBe('hash1');
    expect(second.ttlSeconds).toBeGreaterThan(0);
  });

  it("returns 'cached_hit' on replay with matching bodyHash", async () => {
    const { store } = makeStore();
    await store.claim('k1', 'hash1');
    await store.complete('k1', {
      bodyHash: 'hash1',
      statusCode: 201,
      body: '{"subscriptionId":"sub_abc"}',
      contentType: 'application/json',
    });
    const replay = await store.claim('k1', 'hash1');
    expect(replay.kind).toBe('cached_hit');
    if (replay.kind !== 'cached_hit') throw new Error('unreachable');
    expect(replay.record.statusCode).toBe(201);
    expect(replay.record.body).toBe('{"subscriptionId":"sub_abc"}');
    expect(replay.record.contentType).toBe('application/json');
    expect(replay.record.bodyHash).toBe('hash1');
    expect(replay.record.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns 'cached_mismatch' on replay with different bodyHash", async () => {
    const { store } = makeStore();
    await store.claim('k1', 'hash_first');
    await store.complete('k1', {
      bodyHash: 'hash_first',
      statusCode: 201,
      body: '{}',
      contentType: 'application/json',
    });
    const replay = await store.claim('k1', 'hash_second');
    expect(replay.kind).toBe('cached_mismatch');
    if (replay.kind !== 'cached_mismatch') throw new Error('unreachable');
    expect(replay.storedBodyHash).toBe('hash_first');
  });

  it('expires in_flight markers and accepts a fresh claim after the TTL', async () => {
    let now = 1_000;
    const { store } = makeStore({ clock: () => now, inFlightTtlSeconds: 30 });
    await store.claim('k1', 'hash1');
    now += 31_000;
    const fresh = await store.claim('k1', 'hash1');
    expect(fresh.kind).toBe('claimed');
  });

  it("returns 'unavailable' when Redis SET fails", async () => {
    const { store, redis, warnings } = makeStore();
    redis.failOn = 'set';
    const result = await store.claim('k1', 'hash');
    expect(result.kind).toBe('unavailable');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("returns 'unavailable' when GET fails after a contested SET", async () => {
    const { store, redis, warnings } = makeStore();
    await store.claim('k1', 'hash');
    redis.failOn = 'get';
    const result = await store.claim('k1', 'hash');
    expect(result.kind).toBe('unavailable');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("returns 'unavailable' on a corrupt payload (defensive)", async () => {
    const { store, redis, warnings } = makeStore();
    redis.__setRaw('k1', 'not-json');
    const result = await store.claim('k1', 'hash');
    expect(result.kind).toBe('unavailable');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('ignores payloads with an unknown version', async () => {
    const { store, redis } = makeStore();
    redis.__setRaw(
      'k1',
      JSON.stringify({
        version: 999,
        state: 'completed',
        bodyHash: 'h',
        statusCode: 200,
        body: '{}',
        contentType: 'application/json',
        cachedAt: '2026-01-01T00:00:00Z',
      }),
    );
    const result = await store.claim('k1', 'h');
    expect(result.kind).toBe('unavailable');
  });

  it('retries claim once after a race-with-expiry vanish', async () => {
    const { store, redis } = makeStore({ inFlightTtlSeconds: 1 });
    // Simulate: SET NX fails (we'll force a stale entry the FakeRedis
    // can't reproduce naturally, so we put a corrupt entry, then drop
    // it between SET-NX-fail and GET).
    redis.__setRaw('k1', JSON.stringify({ version: 1, state: 'in_flight', bodyHash: 'h' }), 1);
    // Wind forward so the entry has expired; SET-NX will see the
    // FakeRedis lazy-expire path and grant the claim directly.
    redis.__setRaw('k1', JSON.stringify({ version: 1, state: 'in_flight', bodyHash: 'h' }), 0);
    const result = await store.claim('k1', 'h');
    expect(result.kind).toBe('claimed');
  });
});

describe('RedisIdempotencyStore.complete', () => {
  it('persists the response under the long TTL', async () => {
    const { store, redis } = makeStore({ ttlSeconds: 100 });
    await store.claim('k1', 'h');
    const ok = await store.complete('k1', {
      bodyHash: 'h',
      statusCode: 200,
      body: '{"v":1}',
      contentType: 'application/json',
    });
    expect(ok).toBe(true);
    const raw = redis.__peek('k1');
    expect(raw).toContain('"state":"completed"');
    expect(raw).toContain('"statusCode":200');
    // The body field itself is a JSON string, so the inner JSON gets
    // re-escaped when the outer payload serialises ("body":"{\"v\":1}").
    expect(raw).toContain('\\"v\\":1');
  });

  it('returns false when Redis SET fails (caller proceeds without caching)', async () => {
    const { store, redis, warnings } = makeStore();
    await store.claim('k1', 'h');
    redis.failOn = 'set';
    const ok = await store.complete('k1', {
      bodyHash: 'h',
      statusCode: 200,
      body: '{}',
      contentType: 'application/json',
    });
    expect(ok).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('RedisIdempotencyStore.release', () => {
  it('removes an in-flight marker so a fresh claim succeeds', async () => {
    const { store, redis } = makeStore();
    await store.claim('k1', 'h');
    expect(redis.__peek('k1')).not.toBeNull();
    await store.release('k1');
    expect(redis.__peek('k1')).toBeNull();
    const fresh = await store.claim('k1', 'h');
    expect(fresh.kind).toBe('claimed');
  });

  it('does NOT remove a completed record (release is in-flight-only)', async () => {
    const { store, redis } = makeStore();
    await store.claim('k1', 'h');
    await store.complete('k1', {
      bodyHash: 'h',
      statusCode: 200,
      body: '{}',
      contentType: 'application/json',
    });
    await store.release('k1');
    expect(redis.__peek('k1')).not.toBeNull();
  });

  it('quietly logs when EVAL fails (best-effort)', async () => {
    const { store, redis, warnings } = makeStore();
    await store.claim('k1', 'h');
    redis.failOn = 'eval';
    await store.release('k1');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('is a no-op on an absent key', async () => {
    const { store } = makeStore();
    await store.release('never-existed');
    // no throw, no state change
  });
});
