# @taste-and-see/nest-outbox

Producer-side outbox SDK for the Taste & See platform (TS-142).

Implements the outbox pattern from **PDD §7.3** + **CLAUDE.md §5.3**:
services write event rows in the same Prisma transaction as the state
change, guaranteeing the event is durable _iff_ the business write
commits. The companion relay process (`apps/workers/outbox-relay`)
polls the `outbox_events` table and forwards rows to Redis Streams.

## Why an outbox?

The naive alternative — "publish to the bus directly from the HTTP
handler" — has a fatal failure mode:

1. Service writes row to DB.
2. Service publishes to bus.
3. Service returns 200 to caller.

If step 2 fails (Redis down), the business state already committed
but the event was never published. If steps 1+2 are inverted, an
abandoned transaction publishes an event for state that never
existed. Either way, downstream consumers drift out of sync with the
producer's reality.

The outbox pattern collapses to one durable write: the event row
lands in the same transaction as the state change. The relay's job
is to _eventually_ forward it. Consumers tolerate at-least-once
delivery by deduping on `event_id`.

## Usage

```ts
// app.module.ts
import { OutboxModule } from '@taste-and-see/nest-outbox';

@Module({
  imports: [
    OutboxModule.forRoot({
      serviceName: 'service-subscription',
      schemaName: 'subscription',
    }),
  ],
})
export class AppModule {}
```

```ts
// my.service.ts
import { OutboxService } from '@taste-and-see/nest-outbox';

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async activate(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.update({
        where: { id },
        data: { status: 'active' },
      });

      const result = await this.outbox.append(tx, {
        eventName: 'subscription.activated',
        payload: {
          eventId: '', // unused — envelope is filled in by the bus
          occurredAt: new Date().toISOString(),
          subscriptionId: sub.id,
          customerId: sub.customerId,
          customerGroup: sub.customerGroup,
          planId: sub.planId,
          planCode: sub.planCode,
          periodStart: sub.periodStart.toISOString(),
          periodEnd: sub.periodEnd.toISOString(),
        },
      });

      if (result.kind === 'validation_failed') {
        throw new Error(
          `outbox payload invalid: ${result.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
      }

      return sub;
    });
  }
}
```

## Per-service migration

Each producer service ships a migration that creates its own
`{schema}.outbox_events` table. The shape is identical across
services — the SDK is schema-agnostic and writes raw SQL
parameterised by the validated schema/table identifier pair from
module config.

The canonical SQL:

```sql
CREATE TABLE "{schema}"."outbox_events" (
    "event_id"         TEXT NOT NULL PRIMARY KEY,
    "event_name"       TEXT NOT NULL,
    "payload"          JSONB NOT NULL,
    "occurred_at"      TIMESTAMPTZ(6) NOT NULL,
    "producer_service" TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at"    TIMESTAMPTZ(6),
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at"  TIMESTAMPTZ(6),
    "last_error"       TEXT
);

CREATE INDEX "outbox_events_event_name_idx"
    ON "{schema}"."outbox_events" ("event_name");

CREATE INDEX "outbox_events_undispatched_idx"
    ON "{schema}"."outbox_events" ("created_at")
    WHERE "dispatched_at" IS NULL;
```

The partial index on `dispatched_at IS NULL` is the relay's primary
read path. At steady state most rows have a non-null `dispatched_at`,
so the partial filter is highly selective and keeps the index
footprint bounded against an ever-growing table (CLAUDE.md §7.3).

## Event schema

Event names + payloads are defined in
`packages/contracts/src/events`. `OutboxService.append` validates
the payload against the registered Zod schema before inserting —
malformed payloads are rejected at the producer boundary so the
relay never sees unparseable events.

Adding a new event:

1. Define the schema + name constant in
   `packages/contracts/src/events/{domain}.ts`.
2. Register it in `packages/contracts/src/events/registry.ts`.
3. Producers call `outbox.append(tx, { eventName, payload })` — the
   `EventPayloadFor<N>` type derives from the registry, so the
   payload shape is enforced at compile time.

## Delivery guarantees

- **Durability**: events are persisted to the producer's database
  in the same transaction as the state change. Lost only if the
  database is lost (and at that point the state change is lost
  too — the invariant holds).
- **Delivery**: at-least-once. Consumers MUST dedupe on `event_id`.
- **Ordering**: per-producer-service, FIFO by `created_at`. No
  cross-service ordering guarantee.
- **Backpressure**: if Redis is down, undispatched rows accumulate
  in the outbox table until the relay can drain them. The table
  has no row cap; ops monitor the `dispatched_at IS NULL` count.

## Related

- Relay worker: `apps/workers/outbox-relay/`
- Event registry: `packages/contracts/src/events/`
- Architectural reference: PDD §7.3, CLAUDE.md §5.3
- TS-142: `Completed_tasks.md`
