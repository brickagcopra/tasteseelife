/**
 * Internal store contract for the idempotency cache.
 *
 * Two-state machine per key:
 *
 *   `in_flight` — the original request is being processed. Held under a
 *     short TTL (default 60s) so a stuck handler doesn't poison the
 *     slot. Concurrent requests carrying the same key see this state and
 *     are rejected with 409 (or 409 Retry-After).
 *
 *   `completed` — the original request finished (success OR cacheable
 *     failure). Held under the long TTL (default 24h per CLAUDE.md §3.3).
 *     Replays return the cached response.
 *
 * The body hash (`bodyHash`) is checked on every replay: a same-key
 * request carrying a DIFFERENT body is a misuse and returns 409 (matches
 * Stripe's "idempotency key reused with different parameters" semantics).
 */

/**
 * A claim outcome from `IdempotencyStore.claim`. Drives the interceptor's
 * branch: proceed (`claimed`), short-circuit-replay (`cached_hit`), or
 * reject (`cached_mismatch` / `in_flight`). When Redis is unreachable
 * the outcome is `unavailable` — best-effort caching per CLAUDE.md §4.3.
 */
export type ClaimOutcome =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'cached_hit'; readonly record: CompletedRecord }
  | { readonly kind: 'cached_mismatch'; readonly storedBodyHash: string }
  | { readonly kind: 'in_flight'; readonly storedBodyHash: string; readonly ttlSeconds: number }
  | { readonly kind: 'unavailable'; readonly cause: unknown };

/**
 * The persisted shape on a completed request. Captures just enough to
 * reconstruct the HTTP response: status code, JSON body, content type,
 * plus the body hash + timestamp for the same-key-different-body check.
 *
 * Response headers other than `Content-Type` are intentionally NOT
 * captured — `traceId`, `Set-Cookie`, rate-limit headers, etc. are
 * request-specific and re-emitting a stale value would be wrong.
 */
export interface CompletedRecord {
  readonly state: 'completed';
  readonly bodyHash: string;
  readonly statusCode: number;
  readonly body: string;
  readonly contentType: string;
  readonly cachedAt: string;
}

/**
 * Internal contract for the idempotency cache. The interceptor talks to
 * this; production wires the `RedisIdempotencyStore`, tests wire the
 * `MemoryIdempotencyStore`.
 */
export interface IdempotencyStore {
  /**
   * Atomically attempt to claim the slot for this key.
   *
   * Returns `claimed` if the slot was free — the caller must run the
   * handler and then call `complete(...)` (or `release(...)`) within the
   * in-flight TTL. Returns `cached_hit` / `cached_mismatch` / `in_flight`
   * when an existing record blocks the claim. Returns `unavailable` if
   * the underlying Redis call failed — the interceptor proceeds without
   * caching.
   */
  claim(key: string, bodyHash: string): Promise<ClaimOutcome>;

  /**
   * Persist a completed response under the long TTL. Overwrites the
   * `in_flight` marker. Returns `false` if the underlying call failed —
   * the interceptor logs and proceeds (the response still gets returned
   * to the client; the next replay will simply miss the cache).
   */
  complete(key: string, record: Omit<CompletedRecord, 'state' | 'cachedAt'>): Promise<boolean>;

  /**
   * Release the in-flight marker (e.g., after a 5xx failure that we
   * deliberately don't cache). Best-effort — failure to release just
   * means the marker expires at the in-flight TTL.
   */
  release(key: string): Promise<void>;
}
