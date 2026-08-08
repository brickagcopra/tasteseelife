import type { EventName, EventPayloadFor } from '@taste-and-see/contracts';

/**
 * Minimal Prisma `$executeRaw` surface the SDK consumes. Defining the
 * shape locally means the SDK doesn't take a hard dependency on a
 * specific `@prisma/client` version — each service brings its own
 * Prisma client and passes either the top-level client or a
 * transaction client into `append`. Both shapes expose
 * `$executeRaw(sql, ...values)` so the same call site works in either
 * context.
 *
 * The tagged-template form is used: callers do NOT pass a string. The
 * shape mirrors Prisma's literal type — `(strings, ...values) => Promise<number>`.
 */
export interface OutboxRawExecutor {
  $executeRaw(sqlTemplate: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * Arguments accepted by `OutboxService.append`.
 *
 * `eventName` is a string-literal-typed key from `eventRegistry`
 * (CLAUDE.md §5.3, packages/contracts/src/events). The payload type is
 * inferred from the name via `EventPayloadFor<N>` so a typo or a
 * field-shape drift is a TS error at the call site.
 *
 * `eventId` is optional — the SDK generates a UUID when omitted. Pass
 * an explicit id when the producer already has one (e.g. a Stripe
 * webhook `event.id` becoming the outbox `event_id` to preserve
 * exactly-once-effective semantics across the dispatch boundary).
 *
 * `occurredAt` is optional — defaults to the configured clock. Pass an
 * explicit timestamp when the event semantically happened earlier than
 * the row write (e.g. backfilling a historical event during data
 * migration).
 */
export interface AppendArgs<N extends EventName> {
  readonly eventName: N;
  readonly payload: EventPayloadFor<N>;
  readonly eventId?: string;
  readonly occurredAt?: Date;
}

/**
 * Result returned by `OutboxService.append`. Mirrors the
 * `Result<T, E>` discriminated-union pattern used by services
 * elsewhere in the codebase (CLAUDE.md §2.1).
 *
 * `appended` means the row was written. `validation_failed` means the
 * payload did not match the event's Zod schema (the SDK rejects
 * malformed payloads at the producer boundary so the relay never sees
 * unparseable events).
 */
export type AppendResult =
  | {
      readonly kind: 'appended';
      readonly eventId: string;
      readonly eventName: string;
      readonly occurredAt: Date;
    }
  | {
      readonly kind: 'validation_failed';
      readonly eventName: string;
      readonly issues: ReadonlyArray<{
        readonly path: ReadonlyArray<string | number>;
        readonly message: string;
      }>;
    };
