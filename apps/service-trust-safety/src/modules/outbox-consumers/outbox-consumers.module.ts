import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import {
  BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL,
  BOOKING_ANOMALY_MASS_CANCELLATION,
  PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING,
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
import { IncidentsModule } from '../incidents/incidents.module';

import { BackgroundCheckAdverseFindingHandler } from './handlers/background-check-adverse-finding.handler';
import { ImpossibleTravelHandler } from './handlers/impossible-travel.handler';
import { MassCancellationHandler } from './handlers/mass-cancellation.handler';

/**
 * Outbox consumers module for service-trust-safety (TS-302a; PDD §7.3,
 * §16.1; CLAUDE.md §5.3).
 *
 * Through TS-301b this service was producer-only — it appends
 * `trust_safety.incident.created` and listens to nothing. The welfare
 * escalation track needs it to react to a booking-side signal, so this
 * module owns the handlers for the per-event side effects and registers
 * each of them against the `@taste-and-see/nest-outbox-consumer` SDK
 * (registered globally by `OutboxConsumerModule.forRoot` in the
 * composition root).
 *
 * **Where the SDK's two dependencies live (ADR-0005 / TS-506).** This
 * module used to *provide* `OUTBOX_CONSUMER_REDIS_TOKEN` and
 * `OUTBOX_CONSUMER_DEDUP_STORE_TOKEN`, as the SDK's doc-block then
 * instructed. Nest could never see them: `OutboxConsumerService` is
 * declared inside the SDK's own `@Global()` module, and a provider
 * resolves against the module that declares it — so the service failed
 * to construct and the process died in the injector on every boot. The
 * two factories are now handed to `forRoot`, which declares them
 * alongside the service. Their bodies stay at the bottom of this file,
 * beside the handlers they serve:
 *
 *   1. {@link outboxConsumerRedisFactory} — the same ioredis instance
 *      that backs the Idempotency-Key cache, so a pod keeps one
 *      connection rather than two.
 *   2. {@link outboxConsumerDedupStoreFactory} — the
 *      `PgConsumerDedupStore`, scoped to the `trust_safety` schema's
 *      `outbox_consumer_dedup` table.
 *
 * **Tenant-scoping — read this before adding a handler.** The SDK invokes
 * handlers from its background poll loop, not from an HTTP request, so
 * there is no `request.requestContext` for the `TenantContextInterceptor`
 * to seed a scoped frame from. This service runs
 * `enforcement: 'enforce'` with `unscopedModels: []`, so an unwrapped
 * handler dies with `MissingRequestContextError` on its first Prisma
 * call. Every `registerHandler` must therefore wrap its dispatch:
 *
 * ```ts
 * const handle = this.welfareFlagged.handle.bind(this.welfareFlagged);
 * this.consumer.registerHandler(WELFARE_FLAGGED, async (args) =>
 *   runWithoutTenantContext(
 *     this.tenantStore,
 *     'outbox-consumer-welfare-flagged',
 *     async () => handle(args),
 *   ),
 * );
 * ```
 *
 * with `runWithoutTenantContext` + `TENANT_CONTEXT_STORE_TOKEN` +
 * `TenantContextStore` from `@taste-and-see/nest-prisma-tenant-scope`,
 * and a distinct reason string per event. (`PgConsumerDedupStore`'s own
 * `$queryRaw` / `$executeRaw` writes bypass the gate independently via
 * the SDK's `DEFAULT_UNSCOPED_OPERATIONS` allow-list, which is why this
 * module needs no wrap of its own — but a handler doing model-accessor
 * work absolutely does.)
 *
 * See `apps/service-accounting/src/modules/outbox-consumers/` for the
 * canonical worked example with two live handlers.
 */
@Module({
  imports: [IncidentsModule],
  providers: [
    BackgroundCheckAdverseFindingHandler,
    ImpossibleTravelHandler,
    MassCancellationHandler,
  ],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly adverseFinding: BackgroundCheckAdverseFindingHandler,
    private readonly impossibleTravel: ImpossibleTravelHandler,
    private readonly massCancellation: MassCancellationHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  onModuleInit(): void {
    // TS-307a — the service's FIRST registered handler. The wrap is not
    // optional: the SDK calls handlers from its poll loop, so there is no
    // request context, and the first Prisma model call inside
    // `createIncident` would die with MissingRequestContextError under the
    // enforce-mode posture wired in AppModule.
    const handle = this.adverseFinding.handle.bind(this.adverseFinding);
    this.consumer.registerHandler(PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-provider-background-check-adverse-finding',
        async () => handle(args),
      ),
    );
    this.logger.log(
      { event: PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING },
      'outbox-consumers.handler-registered',
    );

    // TS-308a — the service's SECOND handler, and the second
    // `source: 'system'` incident path. Same `runWithoutTenantContext`
    // wrap for the same reason.
    const handleTravel = this.impossibleTravel.handle.bind(this.impossibleTravel);
    this.consumer.registerHandler(BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-booking-anomaly-impossible-travel',
        async () => handleTravel(args),
      ),
    );
    this.logger.log(
      { event: BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL },
      'outbox-consumers.handler-registered',
    );

    // TS-308c — the THIRD handler, and the second booking-side anomaly.
    // Same `runWithoutTenantContext` wrap for the same reason.
    const handleMassCancellation = this.massCancellation.handle.bind(this.massCancellation);
    this.consumer.registerHandler(BOOKING_ANOMALY_MASS_CANCELLATION, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-booking-anomaly-mass-cancellation',
        async () => handleMassCancellation(args),
      ),
    );
    this.logger.log(
      { event: BOOKING_ANOMALY_MASS_CANCELLATION },
      'outbox-consumers.handler-registered',
    );
  }
}

/**
 * The Redis client the consumer SDK uses for `XREADGROUP` / `XAUTOCLAIM`
 * / `XACK`. One connection per pod, shared with the idempotency cache
 * (same `REDIS_URL`).
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
 * The Postgres-backed dedup store, scoped to the `trust_safety` schema.
 * The SDK's secondary line of defence against redelivery; the primary is
 * a domain-level UNIQUE on the side effect (TS-302d adds
 * `incidents.source_event_id`), so a truncated dedup table still cannot
 * double-open a welfare incident — which here would mean a duplicate SLA
 * timer and a duplicate page to on-call.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (prisma: PrismaService): PgConsumerDedupStore =>
      // `PrismaService` extends `PrismaClient` and exposes `$executeRaw` /
      // `$queryRaw` with the canonical Prisma signature; the SDK's
      // `ConsumerRawExecutor` is a narrower structural contract. The cast
      // goes through `unknown` because Prisma's tagged-template surface
      // uses generic overloads the SDK cannot pin without taking a hard
      // dependency on a specific @prisma/client version (CLAUDE.md §13).
      new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'trust_safety'),
    inject: [PrismaService],
  };

/** Re-exported so tests can inspect the tokens without importing the SDK. */
export {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '@taste-and-see/nest-outbox-consumer';
