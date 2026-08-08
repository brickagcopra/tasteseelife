import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import {
  BOOKING_COMPLETED,
  SUBSCRIPTION_ACTIVATED,
  SUBSCRIPTION_PAUSED,
  SUBSCRIPTION_RESUMED,
} from '@taste-and-see/contracts';
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
import { BookingCommissionModule } from '../booking-commission/booking-commission.module';
import { RevenueRecognitionModule } from '../revenue-recognition/revenue-recognition.module';
import { BookingCompletedHandler } from './handlers/booking-completed.handler';
import { SubscriptionActivatedHandler } from './handlers/subscription-activated.handler';
import { SubscriptionPausedHandler } from './handlers/subscription-paused.handler';
import { SubscriptionResumedHandler } from './handlers/subscription-resumed.handler';

/**
 * Outbox consumers module (TS-142-followup-2-followup-2, PDD §7.3,
 * CLAUDE.md §5.3, §6).
 *
 * Wires the consumer-side bridge between the
 * `@taste-and-see/nest-outbox-consumer` SDK and the recognizer
 * services that own the per-event side effects. The SDK itself is
 * registered globally by `OutboxConsumerModule.forRoot` in the
 * service's composition root; this module:
 *
 *   - **Registers per-event handlers** from `OnModuleInit` —
 *      `SubscriptionActivatedHandler` for `subscription.activated`
 *      (TS-142-followup-2-followup-2), `BookingCompletedHandler` for
 *      `booking.completed` (TS-083-followup-3 / TS-142-followup-3), and
 *      `SubscriptionPausedHandler` / `SubscriptionResumedHandler` for
 *      `subscription.paused` / `subscription.resumed`
 *      (TS-042-followup-3b2). New handlers slot in here as this service
 *      picks up more events (e.g. `subscription.refunded` /
 *      `booking.refunded` move off their synchronous HTTP scaffolds
 *      under TS-084-followup).
 *
 * **`subscription.dunning_exhausted` is deliberately NOT consumed.**
 * When the grace window expires a subscription moves `past_due` →
 * `unpaid`, and the TS-042-followup-3b3 decision is that revenue KEEPS
 * ACCRUING: the platform has already invoiced and may still collect,
 * and halting recognition on a receivable it still expects to realise
 * is a different accounting position from halting it on service not
 * delivered. If the debt ultimately goes bad it becomes a write-off
 * (TS-084), not a retroactive un-recognition. Whether ENTITLEMENTS are
 * suspended is a separate product question, answered elsewhere. The
 * absence of a handler is that decision — `outbox-consumers.module.test.ts`
 * asserts it so a future reader cannot mistake the gap for an oversight.
 *
 * **Why a dedicated module over inline AppModule wiring.** Keeps the
 * handler registration ergonomics tight + makes the test surface
 * obvious (the module's `onModuleInit` is the integration seam).
 * Each new event is one handler class + one
 * `consumer.registerHandler(...)` line — `BookingCompletedHandler`
 * (added under TS-083-followup-3) is the second instance of the shape.
 *
 * **Idempotency lineage.** The handler maps the relay-side
 * `envelope.eventId` 1:1 into the recognizer's `sourceEventId`. This
 * pins the dedup invariant at three layers (consumer-side
 * `outbox_consumer_dedup` PK; recognizer-side
 * `deferred_revenue_balances.source_event_id` UNIQUE;
 * `journals.source_event_id` UNIQUE) — a redelivery short-circuits at
 * whichever layer fires first.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The consumer
 * SDK invokes the registered handler from its background poll loop
 * (`OutboxConsumerService.pollOnce`), not from an HTTP request. There
 * is no `request.requestContext` for the `TenantContextInterceptor` to
 * seed a scoped frame from, so the handler dispatch is wrapped here at
 * registration in `runWithoutTenantContext(...,
 * 'outbox-consumer-subscription-activated', ...)` so every Prisma
 * operation the recognizer performs (and every collateral
 * `PgConsumerDedupStore` write) sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The
 * `PgConsumerDedupStore`'s `$queryRaw` / `$executeRaw` calls bypass the
 * gate independently via the `DEFAULT_UNSCOPED_OPERATIONS` allow-list,
 * but the wrap belt-and-braces the frame so a future SDK move to typed
 * model accessors would still resolve cleanly. Every registered handler
 * gets its own wrap with a per-event reason string
 * (`outbox-consumer-subscription-activated`,
 * `outbox-consumer-booking-completed`).
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
  imports: [RevenueRecognitionModule, BookingCommissionModule],
  providers: [
    SubscriptionActivatedHandler,
    BookingCompletedHandler,
    SubscriptionPausedHandler,
    SubscriptionResumedHandler,
  ],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly subscriptionActivated: SubscriptionActivatedHandler,
    private readonly bookingCompleted: BookingCompletedHandler,
    private readonly subscriptionPaused: SubscriptionPausedHandler,
    private readonly subscriptionResumed: SubscriptionResumedHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  onModuleInit(): void {
    const subscriptionActivated = this.subscriptionActivated.handle.bind(
      this.subscriptionActivated,
    );
    this.consumer.registerHandler(SUBSCRIPTION_ACTIVATED, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-subscription-activated',
        async () => subscriptionActivated(args),
      ),
    );
    this.logger.log({ event: SUBSCRIPTION_ACTIVATED }, 'outbox-consumers.handler-registered');

    const bookingCompleted = this.bookingCompleted.handle.bind(this.bookingCompleted);
    this.consumer.registerHandler(BOOKING_COMPLETED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-booking-completed', async () =>
        bookingCompleted(args),
      ),
    );
    this.logger.log({ event: BOOKING_COMPLETED }, 'outbox-consumers.handler-registered');

    const subscriptionPaused = this.subscriptionPaused.handle.bind(this.subscriptionPaused);
    this.consumer.registerHandler(SUBSCRIPTION_PAUSED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-subscription-paused', async () =>
        subscriptionPaused(args),
      ),
    );
    this.logger.log({ event: SUBSCRIPTION_PAUSED }, 'outbox-consumers.handler-registered');

    const subscriptionResumed = this.subscriptionResumed.handle.bind(this.subscriptionResumed);
    this.consumer.registerHandler(SUBSCRIPTION_RESUMED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-subscription-resumed', async () =>
        subscriptionResumed(args),
      ),
    );
    this.logger.log({ event: SUBSCRIPTION_RESUMED }, 'outbox-consumers.handler-registered');
  }
}

/**
 * Provider for the Redis client the consumer SDK uses for its
 * `XREADGROUP` / `XAUTOCLAIM` / `XACK` calls. Single connection per
 * pod (shared with the Idempotency-Key cache module — same `REDIS_URL`
 * env var).
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
  useFactory: (env: Env): ConsumerRedisClient => {
    const redis = new Redis(env.REDIS_URL, {
      // Lazy connect so the test environment can mock the client
      // without a real connection attempt on module instantiation.
      // Production wires the connection eagerly via the first
      // `XREADGROUP` call.
      lazyConnect: true,
      // Disable per-command auto-pipelining: the SDK issues blocking
      // `XREADGROUP BLOCK <ms>` calls; auto-pipelining can hold
      // adjacent commands behind the long-poll round-trip.
      enableAutoPipelining: false,
      // Keep retries bounded; the SDK's scheduler retries the cycle
      // on its own cadence (`OUTBOX_CONSUMER_POLL_INTERVAL_MS`).
      maxRetriesPerRequest: 3,
    });
    return asConsumerRedisClient(redis);
  },
  inject: [ENV_TOKEN],
};

/**
 * Provider for the Postgres-backed dedup store. Scoped to the
 * `accounting` schema's `outbox_consumer_dedup` table. The SDK uses
 * this store as its secondary line of defence against redelivery;
 * the recognizer's own `source_event_id` UNIQUE constraint is the
 * primary one.
 *
 * Passed to `OutboxConsumerModule.forRoot` in `AppModule` rather than
 * registered here: `OutboxConsumerService` is declared inside the SDK's
 * own module, so a provider declared in *this* module is not in scope at
 * its injection site (ADR-0005 / TS-506). The factory body stays here,
 * beside the handlers it serves.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (prisma: PrismaService): PgConsumerDedupStore => {
      // PrismaService extends PrismaClient and exposes
      // `$executeRaw` / `$queryRaw` with the canonical Prisma signature.
      // The SDK's `ConsumerRawExecutor` is a narrower structural
      // contract; we cast through `unknown` because Prisma's tagged-
      // template surface uses generic overloads the SDK can't pin
      // without binding to a specific Prisma version (CLAUDE.md §13
      // — workspace packages don't take hard deps on @prisma/client).
      return new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'accounting');
    },
    inject: [PrismaService],
  };

/**
 * Re-export for tests that need to inspect the injection tokens
 * without re-importing the SDK.
 */
export {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '@taste-and-see/nest-outbox-consumer';
