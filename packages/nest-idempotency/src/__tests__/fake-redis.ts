/**
 * Minimal ioredis-shaped fake for unit tests in this package.
 *
 * Implements only the subset the `RedisIdempotencyStore` exercises:
 *
 *   SET key value EX <seconds> [NX]
 *   GET key
 *   TTL key
 *   EVAL script numkeys key1 ... — recognises ONLY the release script
 *
 * Why hand-rolled vs. an off-the-shelf ioredis-mock. Two motivations:
 * (a) CLAUDE.md §13 keeps the approved-libraries list tight — adding a
 * single-purpose test dep would need a question to the user; and (b)
 * this fake is small enough to read in one sitting, which makes
 * test-failure diagnosis trivial.
 */

interface Entry {
  readonly value: string;
  readonly expiresAt: number;
}

export class FakeRedis {
  private readonly entries = new Map<string, Entry>();
  /** Inject controlled failures for the unavailability tests. */
  failOn: 'set' | 'get' | 'eval' | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  // Overload signatures match the slice of ioredis our store uses.
  async set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK' | null>;
  async set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  async set(
    key: string,
    value: string,
    _mode: 'EX',
    seconds: number,
    nx?: 'NX',
  ): Promise<'OK' | null> {
    if (this.failOn === 'set') throw new Error('FakeRedis: SET failure injected');
    const existing = this.readWithExpiry(key);
    if (nx === 'NX' && existing !== null) return null;
    this.entries.set(key, {
      value,
      expiresAt: this.clock() + seconds * 1000,
    });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    if (this.failOn === 'get') throw new Error('FakeRedis: GET failure injected');
    const existing = this.readWithExpiry(key);
    return existing?.value ?? null;
  }

  async ttl(key: string): Promise<number> {
    const existing = this.readWithExpiry(key);
    if (existing === null) return -2;
    const remainingMs = existing.expiresAt - this.clock();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : -2;
  }

  async eval(_script: string, numkeys: number, ...keys: string[]): Promise<number> {
    if (this.failOn === 'eval') throw new Error('FakeRedis: EVAL failure injected');
    if (numkeys !== 1 || keys.length !== 1) {
      throw new Error('FakeRedis.eval only supports the one-key release script');
    }
    const key = keys[0]!;
    const existing = this.readWithExpiry(key);
    if (existing === null) return 0;
    try {
      const decoded = JSON.parse(existing.value) as { state?: unknown };
      if (decoded.state === 'in_flight') {
        this.entries.delete(key);
        return 1;
      }
    } catch {
      // Corrupt payload — leave it for the next read.
    }
    return 0;
  }

  /** Test helper — surface the raw stored value. */
  __peek(key: string): string | null {
    return this.readWithExpiry(key)?.value ?? null;
  }

  /** Test helper — set a corrupted value to exercise the decode path. */
  __setRaw(key: string, value: string, ttlSeconds = 60): void {
    this.entries.set(key, { value, expiresAt: this.clock() + ttlSeconds * 1000 });
  }

  /** Test helper — clear the in-memory state. */
  __reset(): void {
    this.entries.clear();
    this.failOn = null;
  }

  private readWithExpiry(key: string): Entry | null {
    const existing = this.entries.get(key);
    if (existing === undefined) return null;
    if (existing.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return existing;
  }
}
