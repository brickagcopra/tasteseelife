import { describe, expect, it } from 'vitest';

import { MemoryIdempotencyStore } from './memory-store';

describe('MemoryIdempotencyStore', () => {
  describe('claim', () => {
    it("returns 'claimed' for a fresh key", async () => {
      const store = new MemoryIdempotencyStore();
      const result = await store.claim('k1', 'hash1');
      expect(result.kind).toBe('claimed');
    });

    it("returns 'in_flight' on a second claim with the same key", async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'hash1');
      const second = await store.claim('k1', 'hash1');
      expect(second.kind).toBe('in_flight');
      if (second.kind !== 'in_flight') throw new Error('unreachable');
      expect(second.storedBodyHash).toBe('hash1');
      expect(second.ttlSeconds).toBeGreaterThan(0);
    });

    it("returns 'in_flight' even when bodyHash differs (in-flight is opaque)", async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'hash_first');
      const second = await store.claim('k1', 'hash_different');
      expect(second.kind).toBe('in_flight');
      // In-flight slots surface the originally claimed body-hash so the
      // interceptor can decide between "race-against-same-body" (retry)
      // and "race-against-different-body" (409 mismatch).
      if (second.kind !== 'in_flight') throw new Error('unreachable');
      expect(second.storedBodyHash).toBe('hash_first');
    });

    it("returns 'cached_hit' after complete() with the same bodyHash", async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'hash1');
      await store.complete('k1', {
        bodyHash: 'hash1',
        statusCode: 201,
        body: '{"ok":true}',
        contentType: 'application/json',
      });
      const replay = await store.claim('k1', 'hash1');
      expect(replay.kind).toBe('cached_hit');
      if (replay.kind !== 'cached_hit') throw new Error('unreachable');
      expect(replay.record.statusCode).toBe(201);
      expect(replay.record.body).toBe('{"ok":true}');
      expect(replay.record.contentType).toBe('application/json');
      expect(replay.record.bodyHash).toBe('hash1');
      expect(replay.record.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("returns 'cached_mismatch' after complete() when bodyHash differs (same-key-different-body)", async () => {
      const store = new MemoryIdempotencyStore();
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

    it('expires in-flight markers and allows a fresh claim after the TTL', async () => {
      let now = 0;
      const store = new MemoryIdempotencyStore(() => now);
      now = 1_000;
      await store.claim('k1', 'hash1');
      // jump past the 60s in-flight TTL
      now = 1_000 + 60_001;
      const result = await store.claim('k1', 'hash1');
      expect(result.kind).toBe('claimed');
    });

    it('expires completed records and falls back to a fresh claim after the TTL', async () => {
      let now = 0;
      const store = new MemoryIdempotencyStore(() => now);
      now = 1_000;
      await store.claim('k1', 'hash1');
      await store.complete('k1', {
        bodyHash: 'hash1',
        statusCode: 200,
        body: '{}',
        contentType: 'application/json',
      });
      // jump past the 24h completed TTL
      now = 1_000 + 24 * 60 * 60 * 1000 + 1;
      const result = await store.claim('k1', 'hash1');
      expect(result.kind).toBe('claimed');
    });

    it('does not collide across distinct keys', async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'hash1');
      const otherKey = await store.claim('k2', 'hash1');
      expect(otherKey.kind).toBe('claimed');
    });
  });

  describe('release', () => {
    it('removes an in_flight marker, allowing a fresh claim', async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'hash1');
      await store.release('k1');
      const fresh = await store.claim('k1', 'hash1');
      expect(fresh.kind).toBe('claimed');
    });

    it('does NOT remove a completed record (release is in-flight-only)', async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'hash1');
      await store.complete('k1', {
        bodyHash: 'hash1',
        statusCode: 201,
        body: '{}',
        contentType: 'application/json',
      });
      await store.release('k1'); // no-op for completed records
      const replay = await store.claim('k1', 'hash1');
      expect(replay.kind).toBe('cached_hit');
    });

    it('is a no-op when the key is absent', async () => {
      const store = new MemoryIdempotencyStore();
      await store.release('never-existed');
      // still a fresh claim works
      const result = await store.claim('never-existed', 'h');
      expect(result.kind).toBe('claimed');
    });
  });

  describe('complete', () => {
    it('returns true and overwrites the in_flight marker', async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'hash1');
      const ok = await store.complete('k1', {
        bodyHash: 'hash1',
        statusCode: 200,
        body: '{}',
        contentType: 'application/json',
      });
      expect(ok).toBe(true);
      const replay = await store.claim('k1', 'hash1');
      expect(replay.kind).toBe('cached_hit');
    });
  });

  describe('test helpers', () => {
    it('exposes __peek and __reset for assertions in higher-level tests', async () => {
      const store = new MemoryIdempotencyStore();
      await store.claim('k1', 'h');
      expect(store.__peek('k1')?.state).toBe('in_flight');
      store.__reset();
      expect(store.__peek('k1')).toBeUndefined();
    });
  });
});
