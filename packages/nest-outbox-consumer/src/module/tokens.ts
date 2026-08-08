/**
 * Symbol-based injection tokens. Symbols (not strings) so a typo at a
 * consumer's `@Inject(...)` site is a TypeScript error rather than a
 * runtime "no provider found" surprise.
 */
export const OUTBOX_CONSUMER_OPTIONS_TOKEN = Symbol('OUTBOX_CONSUMER_OPTIONS_TOKEN');

/**
 * Injects the ioredis client the consumer uses for XREADGROUP /
 * XPENDING / XACK / XAUTOCLAIM. Provided by the consumer's module
 * (the SDK does not own Redis client lifecycle so consumers can
 * share a single client across services / workers).
 */
export const OUTBOX_CONSUMER_REDIS_TOKEN = Symbol('OUTBOX_CONSUMER_REDIS_TOKEN');

/**
 * Injects the `ConsumerDedupStore` implementation. Phase 1 ships a
 * memory store (for tests) + a Postgres store (for production). Both
 * implement the same interface. Consumers provide the chosen
 * implementation at module-registration time.
 */
export const OUTBOX_CONSUMER_DEDUP_STORE_TOKEN = Symbol('OUTBOX_CONSUMER_DEDUP_STORE_TOKEN');
