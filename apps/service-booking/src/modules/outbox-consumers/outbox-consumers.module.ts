import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import {
  TRUST_SAFETY_BOOKING_HOLD_RELEASED,
  TRUST_SAFETY_BOOKING_HOLD_REQUESTED,
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
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { SubjectHoldsModule } from '../subject-holds/subject-holds.module';
import { BookingHoldReleasedHandler } from './handlers/booking-hold-released.handler';
import { BookingHoldRequestedHandler } from './handlers/booking-hold-requested.handler';

/**
 * Outbox consumers module for service-booking (TS-304; PDD §7.3, §16.1;
 * CLAUDE.md §5.3, §12).
 *
 * **service-booking's first consumer surface.** Through TS-303 it was
 * producer-only: it appends `booking.*` events and listened to nothing at
 * all. TS-304 needs it to react to a trust & safety signal, which is why the
 * bridge lands here rather than as an authenticated internal call — an
 * incident must not fail to open because this service is down, and the hold
 * must survive a redelivery (CLAUDE.md §5.3).
 *
 * This module owns the two DI dependencies the
 * `@taste-and-see/nest-outbox-consumer` SDK needs (the SDK itself is
 * registered globally by `OutboxConsumerModule.forRoot` in `AppModule`) and
 * registers the handlers:
 *
 *   1. **The Redis client** — {@link outboxConsumerRedisFactory}, built on the
 *      same `REDIS_URL` that backs the Idempotency-Key cache, so a pod keeps
 *      one connection rather than two.
 *   2. **The `PgConsumerDedupStore`** — {@link outboxConsumerDedupStoreFactory},
 *      scoped to the `booking` schema's `outbox_consumer_dedup` table.
 *   3. **`trust_safety.booking_hold.requested`** →
 *      `BookingHoldRequestedHandler` (suspend the named subjects' visits).
 *   4. **`trust_safety.booking_hold.released`** →
 *      `BookingHoldReleasedHandler` (lift it, re-evaluating against other
 *      open holds first).
 *
 * **Tenant-scoping — required for every handler here.** The SDK invokes
 * handlers from its background poll loop, not from an HTTP request, so there
 * is no `request.requestContext` for `TenantContextInterceptor` to seed a
 * scoped frame from. `AppModule` runs `enforcement: 'enforce'`, so an
 * unwrapped handler dies with `MissingRequestContextError` on its first
 * Prisma call. Each registration therefore wraps its dispatch in
 * `runWithoutTenantContext` with a distinct, grep-able reason string.
 *
 * A hold is inherently cross-tenant, which is worth stating plainly rather
 * than leaving as a consequence of the wrap: a provider hold suspends
 * bookings across every household that provider serves. That is the point —
 * a provider under a critical concern must not keep visiting other
 * families — and it is exactly why the mutation is confined to this
 * service's own two hold operations rather than exposed as a general
 * unscoped surface.
 *
 * See `apps/service-accounting/src/modules/outbox-consumers/` for the
 * canonical worked example this mirrors.
 *
 * **Where those two factories are registered (ADR-0005 / TS-506).** This
 * module used to *provide* both tokens itself, as the SDK's doc-block then
 * instructed. Nest could never see them: `OutboxConsumerService` is declared
 * inside the SDK's own `@Global()` module, and a provider resolves against
 * the module that declares it — so the service failed to construct and the
 * process died in the injector on every boot. Both factories are now handed
 * to `forRoot`, which declares them alongside the service; their bodies stay
 * at the bottom of this file, beside the handlers they serve.
 */
@Module({
  imports: [SubjectHoldsModule],
  providers: [BookingHoldRequestedHandler, BookingHoldReleasedHandler],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly holdRequested: BookingHoldRequestedHandler,
    private readonly holdReleased: BookingHoldReleasedHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  onModuleInit(): void {
    const requested = this.holdRequested.handle.bind(this.holdRequested);
    this.consumer.registerHandler(TRUST_SAFETY_BOOKING_HOLD_REQUESTED, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-trust-safety-booking-hold-requested',
        async () => requested(args),
      ),
    );
    this.logger.log(
      { event: TRUST_SAFETY_BOOKING_HOLD_REQUESTED },
      'outbox-consumers.handler-registered',
    );

    const released = this.holdReleased.handle.bind(this.holdReleased);
    this.consumer.registerHandler(TRUST_SAFETY_BOOKING_HOLD_RELEASED, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-trust-safety-booking-hold-released',
        async () => released(args),
      ),
    );
    this.logger.log(
      { event: TRUST_SAFETY_BOOKING_HOLD_RELEASED },
      'outbox-consumers.handler-registered',
    );
  }
}

/**
 * The Redis client the consumer SDK uses for `XREADGROUP` / `XAUTOCLAIM` /
 * `XACK`. One connection per pod, shared with the idempotency cache (same
 * `REDIS_URL`).
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
        // Lazy so tests can substitute a mock without a real connection
        // attempt at module instantiation; production connects on the first
        // XREADGROUP.
        lazyConnect: true,
        // The SDK issues blocking `XREADGROUP BLOCK <ms>` calls, and
        // auto-pipelining would hold adjacent commands behind that
        // long-poll round trip.
        enableAutoPipelining: false,
        // Bounded — the SDK's scheduler retries on its own cadence
        // (`OUTBOX_CONSUMER_POLL_INTERVAL_MS`).
        maxRetriesPerRequest: 3,
      }),
    ),
  inject: [ENV_TOKEN],
};

/**
 * The Postgres-backed dedup store, scoped to the `booking` schema. The SDK's
 * SECONDARY line of defence against redelivery; the primary is the
 * domain-level `booking_subject_holds.(source_event_id, subject_kind)` UNIQUE,
 * so a truncated dedup table still cannot double-apply a hold.
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
      // `PrismaService` extends `PrismaClient` and exposes `$executeRaw` /
      // `$queryRaw` with the canonical Prisma signature; the SDK's
      // `ConsumerRawExecutor` is a narrower structural contract. The cast
      // goes through `unknown` because Prisma's tagged-template surface uses
      // generic overloads the SDK cannot pin without taking a hard dependency
      // on a specific @prisma/client version (CLAUDE.md §13).
      new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'booking'),
    inject: [PrismaService],
  };

/** Re-exported so tests can inspect the tokens without importing the SDK. */
export {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '@taste-and-see/nest-outbox-consumer';
