import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { BOOKING_CREATED, SEARCH_PERFORMED, SEARCH_RESULT_CLICKED } from '@taste-and-see/contracts';
import {
  OutboxConsumerService,
  PgConsumerDedupStore,
  asConsumerRedisClient,
  type ConsumerDedupStore,
  type ConsumerRawExecutor,
  type ConsumerRedisClient,
  type OutboxConsumerDependencyFactory,
} from '@taste-and-see/nest-outbox-consumer';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { RawEventsModule } from '../raw-events/raw-events.module';
import { BookingCreatedHandler } from './handlers/booking-created.handler';
import { SearchPerformedHandler } from './handlers/search-performed.handler';
import { SearchResultClickedHandler } from './handlers/search-result-clicked.handler';

/**
 * Outbox consumers module (TS-217-prep-3a; PDD §7.3, §23.1; CLAUDE.md §5.3).
 *
 * Wires the consumer-side bridge between the
 * `@taste-and-see/nest-outbox-consumer` SDK and the raw-event landing handlers.
 * The SDK itself is registered globally by `OutboxConsumerModule.forRoot` in
 * the service's composition root; this module:
 *
 *   - **Registers per-event handlers** from `OnModuleInit` —
 *      `SearchPerformedHandler` for `search.performed` (TS-217-prep-1) and
 *      `BookingCreatedHandler` for `booking.created`. New handlers slot in here
 *      as service-analytics consumes more events (e.g. `booking.completed` for
 *      the conversion-with-GMV overlay in a later prep step).
 *
 * **Idempotency lineage.** Each handler maps the relay-side `envelope.eventId`
 * 1:1 into its raw landing table's `event_id` PK. The dedup invariant is pinned
 * at two layers (consumer-side `outbox_consumer_dedup` PK; the raw table's
 * `event_id` PK) — a redelivery short-circuits at whichever layer fires first.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The consumer SDK
 * invokes the registered handler from its background poll loop
 * (`OutboxConsumerService.pollOnce`), not from an HTTP request. There is no
 * `request.requestContext` for the `TenantContextInterceptor` to seed a scoped
 * frame from, so each handler dispatch is wrapped here at registration in
 * `runWithoutTenantContext(..., 'outbox-consumer-<event>', ...)` so every
 * Prisma operation the handler performs (and every collateral
 * `PgConsumerDedupStore` write) sees an explicit `exempt` frame rather than
 * failing with `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`. The `SearchEvent` / `BookingCreatedEvent`
 * models are ALSO listed in `unscopedModels` (platform-wide read-side, no
 * tenant axis), so the gate would pass them through regardless — the wrap is
 * belt-and-braces for the `PgConsumerDedupStore`'s raw-SQL bookkeeping and any
 * future SDK move to typed model accessors. Mirrors service-accounting's
 * `OutboxConsumersModule` shape one-for-one.
 *
 * **Where the SDK's two dependencies live (ADR-0005 / TS-506).** This
 * module used to *provide* `OUTBOX_CONSUMER_REDIS_TOKEN` and
 * `OUTBOX_CONSUMER_DEDUP_STORE_TOKEN`, as the SDK's doc-block then
 * instructed. Nest could never see them: `OutboxConsumerService` is
 * declared inside the SDK's own `@Global()` module, and a provider
 * resolves against the module that declares it — so the service failed
 * to construct and the process died in the injector on every boot. Both
 * factories are now handed to `forRoot`, which declares them alongside
 * the service; their bodies stay at the bottom of this file.
 *
 */
@Module({
  imports: [RawEventsModule],
  providers: [SearchPerformedHandler, SearchResultClickedHandler, BookingCreatedHandler],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly searchPerformed: SearchPerformedHandler,
    private readonly searchResultClicked: SearchResultClickedHandler,
    private readonly bookingCreated: BookingCreatedHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  onModuleInit(): void {
    const searchPerformed = this.searchPerformed.handle.bind(this.searchPerformed);
    this.consumer.registerHandler(SEARCH_PERFORMED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-search-performed', async () =>
        searchPerformed(args),
      ),
    );
    this.logger.log({ event: SEARCH_PERFORMED }, 'outbox-consumers.handler-registered');

    const searchResultClicked = this.searchResultClicked.handle.bind(this.searchResultClicked);
    this.consumer.registerHandler(SEARCH_RESULT_CLICKED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-search-result-clicked', async () =>
        searchResultClicked(args),
      ),
    );
    this.logger.log({ event: SEARCH_RESULT_CLICKED }, 'outbox-consumers.handler-registered');

    const bookingCreated = this.bookingCreated.handle.bind(this.bookingCreated);
    this.consumer.registerHandler(BOOKING_CREATED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-booking-created', async () =>
        bookingCreated(args),
      ),
    );
    this.logger.log({ event: BOOKING_CREATED }, 'outbox-consumers.handler-registered');
  }
}

/**
 * Provider for the Redis client the consumer SDK uses for its `XREADGROUP` /
 * `XAUTOCLAIM` / `XACK` calls. Single connection per pod. Mirrors
 * service-accounting's `redisProvider` verbatim (lazy connect for tests,
 * auto-pipelining off so blocking `XREADGROUP BLOCK` doesn't hold adjacent
 * commands, bounded retries).
 *
 * Passed to `OutboxConsumerModule.forRoot` in `AppModule` rather than
 * registered here: `OutboxConsumerService` is declared inside the SDK's
 * own module, so a provider declared in *this* module is not in scope at
 * its injection site (ADR-0005 / TS-506). The factory body stays here,
 * beside the handlers it serves.
 */
export const outboxConsumerRedisFactory: OutboxConsumerDependencyFactory<ConsumerRedisClient> = {
  // `asConsumerRedisClient` narrows ioredis's heavily-overloaded stream
  // command signatures to the SDK's structural contract. Previously the
  // token was untyped, so the raw `Redis` flowed through unchecked; now
  // the factory's return type is the SDK's own interface and the
  // conversion is explicit.
  useFactory: (env: Env): ConsumerRedisClient =>
    asConsumerRedisClient(
      new Redis(env.REDIS_URL, {
        lazyConnect: true,
        enableAutoPipelining: false,
        maxRetriesPerRequest: 3,
      }),
    ),
  inject: [ENV_TOKEN],
};

/**
 * Provider for the Postgres-backed dedup store, scoped to the `analytics`
 * schema's `outbox_consumer_dedup` table. The SDK uses this store as its
 * secondary line of defence against redelivery; each raw landing table's
 * `event_id` PK is the primary one.
 *
 * Passed to `OutboxConsumerModule.forRoot` in `AppModule` rather than
 * registered here: `OutboxConsumerService` is declared inside the SDK's
 * own module, so a provider declared in *this* module is not in scope at
 * its injection site (ADR-0005 / TS-506). The factory body stays here,
 * beside the handlers it serves.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (prisma: PrismaService): PgConsumerDedupStore =>
      // PrismaService extends PrismaClient and exposes `$executeRaw` /
      // `$queryRaw` with the canonical Prisma signature. The SDK's
      // `ConsumerRawExecutor` is a narrower structural contract; we cast
      // through `unknown` because Prisma's tagged-template surface uses
      // generic overloads the SDK can't pin without binding to a specific
      // Prisma version (CLAUDE.md §13 — workspace packages don't take hard
      // deps on @prisma/client). Mirrors service-accounting's cast.
      new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'analytics'),
    inject: [PrismaService],
  };

/**
 * Re-export for tests that need to inspect the injection tokens without
 * re-importing the SDK.
 */
export {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '@taste-and-see/nest-outbox-consumer';
