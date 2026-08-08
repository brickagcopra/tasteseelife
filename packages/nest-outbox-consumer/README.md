# @taste-and-see/nest-outbox-consumer

Consumer-side outbox SDK for the Taste & See platform (TS-142-followup-2).

The companion to [`@taste-and-see/nest-outbox`](../nest-outbox/README.md)
(producer side) and the outbox relay
[`apps/workers/outbox-relay`](../../apps/workers/outbox-relay/README.md).

Implements the consumer half of the outbox pattern from **PDD §7.3** /
**CLAUDE.md §5.3**:

1. Producer services append event rows to their `outbox_events` table
   atomically with state changes.
2. The relay polls the table and forwards undispatched rows to Redis
   Streams (per-event-name streams: `events:subscription.activated`,
   `events:booking.completed`, …).
3. **This SDK** subscribes consumer services to those streams via
   `XREADGROUP`, dispatches each entry to a typed handler, and tracks
   dedup + retry + dead-letter state.

## Delivery semantics

- **At-least-once.** Handlers MUST be idempotent on `envelope.eventId`.
  The SDK's dedup table is the secondary line of defence; the handler's
  own internal unique-key invariants (e.g. accounting's
  `journals.source_event_id` UNIQUE constraint) is the primary one.
- **Per-consumer-group delivery position.** Each consuming service
  creates a Redis consumer group named after the service. Two services
  subscribing to the same stream each receive every event independently.
- **Retry on transient failure.** When a handler throws, the SDK
  records the failure in the dedup table but does NOT XACK; Redis
  Streams' PEL holds the entry until reclaim → redelivery.
- **Dead-letter on persistent failure.** After `maxAttempts` retries
  (default 10), the SDK records a `dead_lettered` row + XACKs to clear
  the PEL. Ops triage dead-lettered rows out-of-band via the per-state
  index on the dedup table.

## Usage

### 1. Wire the module

```ts
// app.module.ts
import {
  OutboxConsumerModule,
  OUTBOX_CONSUMER_REDIS_TOKEN,
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  PgConsumerDedupStore,
} from '@taste-and-see/nest-outbox-consumer';
import { Redis } from 'ioredis';

@Module({
  imports: [
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-accounting',
      consumerName: process.env.HOSTNAME ?? 'default',
      // Defaults: maxAttempts=10, pollBlockMs=5000, reclaimIdleMs=60000,
      // pollIntervalMs=1000, streamPrefix='events'
    }),
  ],
  providers: [
    {
      provide: OUTBOX_CONSUMER_REDIS_TOKEN,
      useFactory: (env) => new Redis(env.REDIS_URL),
      inject: [ENV_TOKEN],
    },
    {
      provide: OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
      useFactory: (prisma) => new PgConsumerDedupStore(prisma, 'accounting'),
      inject: [PrismaService],
    },
  ],
})
export class AppModule {}
```

### 2. Register handlers

In a feature module's `OnModuleInit`:

```ts
import { OutboxConsumerService } from '@taste-and-see/nest-outbox-consumer';
import { SUBSCRIPTION_ACTIVATED } from '@taste-and-see/contracts';

@Injectable()
export class AccountingHandlersBootstrap implements OnModuleInit {
  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly recognizer: SubscriptionRevenueRecognizerService,
  ) {}

  onModuleInit(): void {
    this.consumer.registerHandler(SUBSCRIPTION_ACTIVATED, async (args) => {
      // args.payload is typed via the registry — TS knows the field shape.
      await this.recognizer.recognizeActivation({
        subscriptionId: args.payload.subscriptionId,
        sourceEventId: args.envelope.eventId,
        // ...
      });
    });
  }
}
```

The `OutboxConsumerScheduler` (auto-wired) bootstraps the consumer
groups after every module has initialised, then drives `pollOnce()` on
the configured interval. Handlers don't manage the polling loop.

### 3. Migrate the dedup table

Each consuming service ships a Prisma migration creating the dedup
table in its own schema. Canonical shape:

```sql
CREATE TABLE accounting.outbox_consumer_dedup (
  consumer_group     TEXT        NOT NULL,
  event_id           TEXT        NOT NULL,
  event_name         TEXT        NOT NULL,
  state              TEXT        NOT NULL CHECK (state IN ('in_flight', 'processed', 'dead_lettered')),
  attempts           INTEGER     NOT NULL DEFAULT 1,
  last_error         TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  dead_lettered_at   TIMESTAMPTZ,
  PRIMARY KEY (consumer_group, event_id)
);

CREATE INDEX outbox_consumer_dedup_dead_lettered_idx
  ON accounting.outbox_consumer_dedup(consumer_group, dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;
```

## Architecture

```
   Redis Streams                         Consumer service
   (per event name)                      (one per consuming service)
   ────────────────                      ──────────────────────────

   events:subscription.activated  ◀───  OutboxConsumerScheduler
                                            │ setTimeout re-arm loop
                                            │
                                            ▼
                                        OutboxConsumerService
                                            ├─ XAUTOCLAIM (reclaim idle PEL)
                                            ├─ XREADGROUP (read fresh)
                                            ├─ parseStreamEntry (validate)
                                            ├─ ConsumerDedupStore (state)
                                            ├─ handler(envelope, payload)
                                            └─ XACK on success
```

## Failure model

| Failure                                 | Behaviour                                                      |
| --------------------------------------- | -------------------------------------------------------------- |
| Stream entry malformed (bad JSON, etc.) | Dead-letter immediately; XACK so it doesn't loop.              |
| Handler throws (transient)              | recordFailure; no XACK; redelivered via XAUTOCLAIM next cycle. |
| Handler throws ≥ maxAttempts times      | recordDeadLetter + XACK. Ops triage from the dedup table.      |
| Redis call fails                        | Log + continue cycle. Next poll retries.                       |
| No handler registered for an event      | XACK + log warning (drops the entry).                          |
| Dedup store call fails                  | Log; cycle continues. Side effects already happened or not.    |

## Wire format

Each Redis stream entry's key-value pair list must contain:

- `event_id` — the dedup key
- `event_name` — past-tense dotted name (validated against
  [`eventRegistry`](../contracts/src/events/registry.ts))
- `payload` — JSON-stringified domain payload (validated against the
  matching registry Zod schema)
- `occurred_at` — producer-wall-clock ISO8601
- `producer_service` — for tracing
- `schema` — origin Postgres schema

This format matches the relay's `RedisStreamPublisher` verbatim; any
future relay-side addition is consumed as an optional field here.

## Test harness

The package ships `MemoryConsumerDedupStore` for unit tests — it
implements `ConsumerDedupStore` against an in-memory `Map`, supports
`reset()` between tests, and exposes a `snapshot()` for assertions.

Tests of consumer services can inject the memory store via
`useMemoryDedupStore: true` on `OutboxConsumerModule.forRoot` rather
than supplying their own `OUTBOX_CONSUMER_DEDUP_STORE_TOKEN` provider.

## Related

- Producer side: `@taste-and-see/nest-outbox` (`packages/nest-outbox`)
- Relay: `@taste-and-see/worker-outbox-relay` (`apps/workers/outbox-relay`)
- Event registry: `@taste-and-see/contracts` (`packages/contracts/src/events`)
- Pattern reference: PDD §7.3, CLAUDE.md §5.3, §17.5
