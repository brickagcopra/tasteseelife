import type { ClaimOutcome, CompletedRecord, IdempotencyStore } from './types';

/**
 * In-memory `IdempotencyStore` implementation.
 *
 * Used by:
 *   - tests (both this package's tests and the consuming service's tests
 *     override `IDEMPOTENCY_STORE_TOKEN` with this implementation so the
 *     interceptor's behaviour is exercised end-to-end without standing
 *     up a real Redis)
 *   - the IdempotencyModule's `useMemoryStore: true` knob, which is
 *     convenient for local development when Redis isn't running
 *
 * Not safe across processes (no shared state) and not safe across
 * pod restarts — both correct: this is a test/dev fixture, not a
 * production store.
 *
 * Concurrency model. Node is single-threaded for JavaScript execution;
 * within a single process, the `claim` / `complete` / `release` methods
 * are atomic at the JS-execution level (no `await` between read + write).
 * The artificial TTL is enforced lazily on read — entries past their
 * expiry are dropped on the next access.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, InternalEntry>();

  constructor(private readonly clock: () => number = Date.now) {}

  async claim(key: string, bodyHash: string): Promise<ClaimOutcome> {
    const now = this.clock();
    const existing = this.readWithExpiry(key, now);
    if (existing === null) {
      this.entries.set(key, {
        state: 'in_flight',
        bodyHash,
        expiresAt: now + DEFAULT_IN_FLIGHT_TTL_MS,
      });
      return { kind: 'claimed' };
    }
    if (existing.state === 'in_flight') {
      return {
        kind: 'in_flight',
        storedBodyHash: existing.bodyHash,
        ttlSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
      };
    }
    if (existing.bodyHash !== bodyHash) {
      return { kind: 'cached_mismatch', storedBodyHash: existing.bodyHash };
    }
    return {
      kind: 'cached_hit',
      record: {
        state: 'completed',
        bodyHash: existing.bodyHash,
        statusCode: existing.statusCode,
        body: existing.body,
        contentType: existing.contentType,
        cachedAt: existing.cachedAt,
      },
    };
  }

  async complete(
    key: string,
    record: Omit<CompletedRecord, 'state' | 'cachedAt'>,
  ): Promise<boolean> {
    const now = this.clock();
    this.entries.set(key, {
      state: 'completed',
      bodyHash: record.bodyHash,
      statusCode: record.statusCode,
      body: record.body,
      contentType: record.contentType,
      cachedAt: new Date(now).toISOString(),
      expiresAt: now + DEFAULT_COMPLETED_TTL_MS,
    });
    return true;
  }

  async release(key: string): Promise<void> {
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.state === 'in_flight') {
      this.entries.delete(key);
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  private readWithExpiry(key: string, now: number): InternalEntry | null {
    const existing = this.entries.get(key);
    if (existing === undefined) return null;
    if (existing.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return existing;
  }

  /** Test helper — surface the raw entry for assertions. */
  __peek(key: string): InternalEntry | undefined {
    return this.entries.get(key);
  }

  /** Test helper — clear all state. */
  __reset(): void {
    this.entries.clear();
  }
}

type InternalEntry =
  | {
      readonly state: 'in_flight';
      readonly bodyHash: string;
      readonly expiresAt: number;
    }
  | {
      readonly state: 'completed';
      readonly bodyHash: string;
      readonly statusCode: number;
      readonly body: string;
      readonly contentType: string;
      readonly cachedAt: string;
      readonly expiresAt: number;
    };

const DEFAULT_IN_FLIGHT_TTL_MS = 60 * 1000;
const DEFAULT_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
