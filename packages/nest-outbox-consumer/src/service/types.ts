import type { EventName, EventPayloadFor } from '@taste-and-see/contracts';

/**
 * Envelope fields the relay's `RedisStreamPublisher` writes on every
 * stream entry. Mirrors the producer-side wire format (see
 * `apps/workers/outbox-relay/src/relay/redis-stream-publisher.ts`).
 *
 * The consumer parses + validates these against the matching event's
 * Zod schema (looked up via the contracts `eventRegistry`) before
 * invoking the handler — a malformed entry never reaches application
 * code.
 */
export interface ConsumerEventEnvelope {
  /** Dedup key. Consumer-side dedup tables PK on `(consumerGroup, eventId)`. */
  readonly eventId: string;
  /** Past-tense dotted-name (e.g. `subscription.activated`). */
  readonly eventName: EventName;
  /** Producer-wall-clock timestamp at publish time. */
  readonly occurredAt: Date;
  /** Producer service name (e.g. `service-subscription`) for tracing. */
  readonly producerService: string;
  /** Producer schema (e.g. `subscription`) for the relay's lineage trail. */
  readonly producerSchema: string;
}

/**
 * Arguments handed to a consumer handler. The payload type is inferred
 * from the event name via `EventPayloadFor<N>` so a typo or a field
 * shape drift is a TS error at the registration site.
 */
export interface HandleArgs<N extends EventName> {
  readonly envelope: ConsumerEventEnvelope;
  readonly payload: EventPayloadFor<N>;
}

/**
 * A typed handler for a single event name. Handlers are async, return
 * `void` on success, and throw on failure (the SDK catches every
 * exception and routes it through the retry / dead-letter machinery).
 *
 * Handlers MUST be idempotent on `envelope.eventId`. The SDK's dedup
 * store is the secondary line of defence; the handler's own internal
 * unique-key invariants (e.g. accounting's `journals.source_event_id`
 * UNIQUE constraint) is the primary one. CLAUDE.md §5.3.
 */
export type ConsumerHandler<N extends EventName> = (args: HandleArgs<N>) => Promise<void>;

/**
 * A handler registration entry. The Phase-1 SDK uses a `registerHandler`
 * method (called from a Nest `OnModuleInit`) rather than the more
 * Nest-idiomatic `@OutboxHandler` decorator + reflection-based discovery
 * — config-time registration is more explicit, easier to test, and
 * doesn't depend on the `@nestjs/core` `DiscoveryService`. The decorator
 * pattern can be added later without breaking the registration shape.
 */
export interface HandlerRegistration<N extends EventName = EventName> {
  readonly eventName: N;
  readonly handler: ConsumerHandler<N>;
}

/**
 * Phase-1 dedup-store contract. The SDK calls these methods around
 * every handler invocation. Phase 1 ships an in-memory implementation
 * (for tests) AND a Postgres-backed one that uses raw SQL through the
 * same `RawExecutor` shape as the producer SDK.
 *
 * The contract:
 *
 *   1. `getState(group, eventId)` — current state. Used to short-circuit
 *      a redelivery of an already-processed event (XACK + skip).
 *
 *   2. `recordAttempt(group, eventId, eventName)` — called BEFORE
 *      handler invocation. Stamps `last_attempt_at`, increments
 *      `attempts`, marks state `in_flight` if previously unseen.
 *
 *   3. `recordSuccess(group, eventId)` — called AFTER handler returns.
 *      Flips state to `processed`; the SDK then XACKs.
 *
 *   4. `recordFailure(group, eventId, error)` — called when the
 *      handler throws. Stamps `last_error` + leaves state `in_flight`
 *      so the next redelivery retries. The SDK does NOT XACK on
 *      failure — Redis Streams' PEL holds the entry until the
 *      delivery count crosses `maxAttempts`, at which point
 *      `recordDeadLetter` fires + XACK clears the entry.
 *
 *   5. `recordDeadLetter(group, eventId, error)` — terminal state.
 *      The SDK XACKs after this returns so the entry leaves the PEL;
 *      ops triage the dead-lettered row out-of-band via the dedup
 *      table's per-state index.
 */
export interface ConsumerDedupStore {
  getState(consumerGroup: string, eventId: string): Promise<ConsumerDedupState>;

  recordAttempt(consumerGroup: string, eventId: string, eventName: string): Promise<void>;

  recordSuccess(consumerGroup: string, eventId: string): Promise<void>;

  recordFailure(consumerGroup: string, eventId: string, error: string): Promise<void>;

  recordDeadLetter(consumerGroup: string, eventId: string, error: string): Promise<void>;
}

/**
 * Current state of a row in the dedup store.
 */
export type ConsumerDedupState =
  | { readonly kind: 'unseen' }
  | { readonly kind: 'in_flight'; readonly attempts: number }
  | { readonly kind: 'processed' }
  | { readonly kind: 'dead_lettered' };

/**
 * Minimal raw-SQL executor the Postgres dedup store consumes. Mirrors
 * the producer SDK's `OutboxRawExecutor` shape — defined locally so the
 * package doesn't take a hard dependency on a specific `@prisma/client`
 * version. Consumers can pass either the top-level Prisma client or a
 * transaction client.
 */
export interface ConsumerRawExecutor {
  $executeRaw(sqlTemplate: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T>(sqlTemplate: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Wire-format shape a stream entry's key-value list deserialises into.
 * The relay publishes exactly these fields (see
 * `apps/workers/outbox-relay/src/relay/redis-stream-publisher.ts` —
 * the contract is the field set). Any future relay-side addition shows
 * up here as an additional optional field.
 *
 * `eventName` is `EventName` (the registry-narrowed union) because the
 * parser validates the wire value against the registry before
 * constructing this shape — only well-formed entries reach handlers.
 */
export interface ParsedStreamEntry {
  readonly streamId: string; // Redis stream ID like "1715900000000-0"
  readonly eventId: string;
  readonly eventName: EventName;
  readonly payload: unknown; // JSON-parsed; validated against registry schema
  readonly occurredAt: Date;
  readonly producerService: string;
  readonly producerSchema: string;
}
