/**
 * Minimal ioredis-shaped fake for unit tests in api-gateway.
 *
 * Implements only the subset of commands the rate-limit Lua script
 * exercises (when evaluated via `redis.call` inside the script — the
 * fake's `eval` interprets the script's logic in pure JS so we don't
 * embed a Lua interpreter). Mirrors the shape of the nest-idempotency
 * fake (`packages/nest-idempotency/src/__tests__/fake-redis.ts`).
 *
 * Why hand-rolled vs. an off-the-shelf ioredis-mock. Two motivations:
 * (a) CLAUDE.md §13 keeps the approved-libraries list tight — adding a
 * single-purpose test dep would need a question to the user; and (b)
 * this fake is small enough to read in one sitting, which makes
 * test-failure diagnosis trivial.
 */

interface SortedSetEntry {
  readonly member: string;
  readonly score: number;
}

interface SortedSet {
  readonly kind: 'zset';
  readonly entries: SortedSetEntry[];
  expiresAt: number | null;
}

export class FakeRedis {
  private readonly entries = new Map<string, SortedSet>();
  /** Inject controlled failures for the unavailability tests. */
  failOn: 'eval' | 'ping' | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * Interpret the rate-limit sliding-window Lua script. ARGV order:
   *   ARGV[1] now_ms
   *   ARGV[2] window_ms
   *   ARGV[3] limit
   *   ARGV[4] nonce
   *   ARGV[5] ttl_seconds
   *
   * Returns `[allowed, remaining, retryAfter]` per the script contract.
   */
  async eval(
    _script: string,
    numkeys: number,
    ...args: string[]
  ): Promise<[number, number, number]> {
    if (this.failOn === 'eval') throw new Error('FakeRedis: EVAL failure injected');
    if (numkeys !== 1) {
      throw new Error('FakeRedis.eval only supports single-key scripts');
    }
    const key = args[0];
    const nowMs = Number.parseInt(args[1] ?? '', 10);
    const windowMs = Number.parseInt(args[2] ?? '', 10);
    const limit = Number.parseInt(args[3] ?? '', 10);
    const nonce = args[4];
    const ttlSeconds = Number.parseInt(args[5] ?? '', 10);
    if (
      key === undefined ||
      nonce === undefined ||
      !Number.isFinite(nowMs) ||
      !Number.isFinite(windowMs) ||
      !Number.isFinite(limit) ||
      !Number.isFinite(ttlSeconds)
    ) {
      throw new Error('FakeRedis.eval: malformed ARGV');
    }

    this.evictExpired(key);
    let zset = this.entries.get(key);
    if (zset === undefined) {
      zset = { kind: 'zset', entries: [], expiresAt: null };
      this.entries.set(key, zset);
    }

    // ZREMRANGEBYSCORE 0 (now - window)
    const windowStart = nowMs - windowMs;
    let pruned = 0;
    for (let i = zset.entries.length - 1; i >= 0; i--) {
      const entry = zset.entries[i];
      if (entry !== undefined && entry.score <= windowStart) {
        zset.entries.splice(i, 1);
        pruned++;
      }
    }
    void pruned;

    const count = zset.entries.length;
    if (count < limit) {
      zset.entries.push({ member: nonce, score: nowMs });
      zset.entries.sort((a, b) => a.score - b.score);
      zset.expiresAt = this.clock() + ttlSeconds * 1000;
      return [1, limit - count - 1, 0];
    }

    const oldest = zset.entries[0];
    const oldestScore = oldest?.score ?? nowMs;
    const remainingMs = oldestScore + windowMs - nowMs;
    const retryAfter = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
    return [0, 0, retryAfter];
  }

  async ping(): Promise<'PONG'> {
    if (this.failOn === 'ping') throw new Error('FakeRedis: PING failure injected');
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  /** Test helper — peek the sorted set entries for assertions. */
  __peek(key: string): SortedSetEntry[] | null {
    this.evictExpired(key);
    const zset = this.entries.get(key);
    return zset === undefined ? null : zset.entries.map((e) => ({ ...e }));
  }

  /** Test helper — clear the in-memory state. */
  __reset(): void {
    this.entries.clear();
    this.failOn = null;
  }

  private evictExpired(key: string): void {
    const zset = this.entries.get(key);
    if (zset === undefined) return;
    if (zset.expiresAt !== null && zset.expiresAt <= this.clock()) {
      this.entries.delete(key);
    }
  }
}
