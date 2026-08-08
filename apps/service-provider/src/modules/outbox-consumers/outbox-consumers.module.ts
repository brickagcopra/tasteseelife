import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import {
  BOOKING_CANCELED,
  BOOKING_COMPLETED,
  BOOKING_CONFIRMED,
  BOOKING_CREATED,
  BOOKING_DECLINED,
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
import { MetricsModule } from '../metrics/metrics.module';

import { BookingLifecycleHandler } from './handlers/booking-lifecycle.handler';

/**
 * Outbox consumers module for service-provider (TS-305d; PDD §7.3;
 * CLAUDE.md §5.3).
 *
 * **service-provider's first consumer surface.** It has been an outbox
 * PRODUCER since TS-050 — it appends `provider.certification_granted`,
 * `provider.tier_changed` and the rest — and has listened to nothing.
 * The `provider_metrics` read model PDD §8.2 has named since then is
 * refreshed off another context's domain events by definition, so
 * building it makes this service a consumer for the first time. That is
 * why the `outbox_consumer_dedup` table arrives in the same migration.
 *
 * The consumer group is `service-provider`, so it reads
 * `booking.outbox_events` independently of accounting's and
 * trust-safety's groups over the same stream. No relay change was
 * needed: `booking.outbox_events` has been in `OUTBOX_SOURCES` since
 * the accounting recognizer.
 *
 * **Where the SDK's two dependencies live (ADR-0005 / TS-506).** They
 * are handed to `OutboxConsumerModule.forRoot` in the composition root,
 * NOT provided here: `OutboxConsumerService` is declared inside the
 * SDK's own `@Global()` module, and a provider resolves against the
 * module that declares it, so a provider declared here is invisible at
 * the injection site and the process dies in the injector at boot. The
 * factory bodies stay at the bottom of this file, beside the handler
 * they serve.
 *
 * **Tenant-scoping — read this before adding a handler.** The SDK
 * invokes handlers from its background poll loop, not from an HTTP
 * request, so there is no `request.requestContext` for the
 * `TenantContextInterceptor` to seed a scoped frame from, and this
 * service's Prisma gate would reject the first model call with
 * `MissingRequestContextError`. Every `registerHandler` therefore wraps
 * its dispatch in `runWithoutTenantContext` with a distinct reason
 * string — the same rule the rbac-revoker sweep learned the hard way
 * (TS-309a-followup-2, where every tick would have failed and nobody
 * would have seen it).
 *
 * **Why five registrations and one handler class.** All five events
 * feed one projection and differ only in which columns they contribute;
 * that difference is a pure function per event
 * (`booking-fact-projection.ts`), not a class. The registrations stay
 * separate because the SDK's payload types are inferred per event name,
 * so a change to any one event's shape is a type error at its own
 * registration site rather than inside a widened union.
 */
@Module({
  imports: [MetricsModule],
  providers: [BookingLifecycleHandler],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  /**
   * Every dependency carries an explicit `@Inject`, including the two whose
   * class is its own token.
   *
   * Not style. `emitDecoratorMetadata` is a `tsc` feature and vitest compiles
   * through esbuild, which emits no `design:paramtypes` — so a bare param type
   * resolves to `undefined` under the test runner while working perfectly in
   * production. Here that made `this.bookingLifecycle` undefined and
   * `onModuleInit` threw `Cannot read properties of undefined (reading
   * 'handleCreated')`, taking the whole integration suite down at
   * `NestApplication.init` before a single assertion ran (found 2026-08-06 —
   * it had been failing silently, because the integration lane is not part of
   * `turbo run test`).
   *
   * The limitation is documented across this repo (TS-304, TS-307a,
   * TS-306-followup-1a) and the usual workaround is to construct the class
   * directly in the unit test. That is not available to a suite whose whole
   * point is booting the real `AppModule`, so the module is made resolvable
   * instead. `@Inject(SomeClass)` is exactly what `tsc` would have emitted.
   */
  constructor(
    @Inject(OutboxConsumerService)
    private readonly consumer: OutboxConsumerService,
    @Inject(BookingLifecycleHandler)
    private readonly bookingLifecycle: BookingLifecycleHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  onModuleInit(): void {
    const handleCreated = this.bookingLifecycle.handleCreated.bind(this.bookingLifecycle);
    this.consumer.registerHandler(BOOKING_CREATED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-booking-created', async () =>
        handleCreated(args),
      ),
    );

    const handleConfirmed = this.bookingLifecycle.handleConfirmed.bind(this.bookingLifecycle);
    this.consumer.registerHandler(BOOKING_CONFIRMED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-booking-confirmed', async () =>
        handleConfirmed(args),
      ),
    );

    const handleDeclined = this.bookingLifecycle.handleDeclined.bind(this.bookingLifecycle);
    this.consumer.registerHandler(BOOKING_DECLINED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-booking-declined', async () =>
        handleDeclined(args),
      ),
    );

    const handleCompleted = this.bookingLifecycle.handleCompleted.bind(this.bookingLifecycle);
    this.consumer.registerHandler(BOOKING_COMPLETED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-booking-completed', async () =>
        handleCompleted(args),
      ),
    );

    const handleCanceled = this.bookingLifecycle.handleCanceled.bind(this.bookingLifecycle);
    this.consumer.registerHandler(BOOKING_CANCELED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-booking-canceled', async () =>
        handleCanceled(args),
      ),
    );

    this.logger.log(
      {
        events: [
          BOOKING_CREATED,
          BOOKING_CONFIRMED,
          BOOKING_DECLINED,
          BOOKING_COMPLETED,
          BOOKING_CANCELED,
        ],
      },
      'outbox-consumers.handlers-registered',
    );
  }
}

/**
 * The Redis client the consumer SDK uses for `XREADGROUP` / `XAUTOCLAIM`
 * / `XACK`. One connection per pod, shared with the Idempotency-Key
 * cache (same `REDIS_URL`).
 *
 * Passed to `OutboxConsumerModule.forRoot` in `AppModule` rather than
 * registered here — see the module doc-block (ADR-0005 / TS-506).
 */
export const outboxConsumerRedisFactory: OutboxConsumerDependencyFactory<ConsumerRedisClient> = {
  useFactory: (env: Env): ConsumerRedisClient =>
    asConsumerRedisClient(
      new Redis(env.REDIS_URL, {
        // Lazy so tests can substitute a mock without a real connection
        // attempt at module instantiation; production connects on the
        // first XREADGROUP.
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
 * The Postgres-backed dedup store, scoped to the `provider` schema.
 *
 * The SDK's SECONDARY defence against redelivery. Unlike the incident
 * consumers, the primary defence here is not a UNIQUE constraint but
 * the shape of the write: the projector's `COALESCE` upsert makes a
 * replay a no-op, so a truncated dedup table costs a re-scan, not a
 * double count.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (prisma: PrismaService): PgConsumerDedupStore =>
      // The cast goes through `unknown` because Prisma's tagged-template
      // surface uses generic overloads the SDK cannot pin without taking
      // a hard dependency on a specific @prisma/client version.
      new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'provider'),
    inject: [PrismaService],
  };

/** Re-exported so tests can inspect the tokens without importing the SDK. */
export {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '@taste-and-see/nest-outbox-consumer';
