import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import {
  PROVIDER_AVAILABILITY_UPDATED,
  PROVIDER_CERTIFICATION_GRANTED,
  PROVIDER_CERTIFICATION_REVOKED,
  PROVIDER_PROFILE_UPDATED,
  PROVIDER_METRICS_UPDATED,
  PROVIDER_SERVICE_AREAS_UPDATED,
  PROVIDER_TIER_CHANGED,
} from '@taste-and-see/contracts';
import {
  MemoryConsumerDedupStore,
  OutboxConsumerService,
  asConsumerRedisClient,
  type ConsumerDedupStore,
  type ConsumerRedisClient,
  type OutboxConsumerDependencyFactory,
} from '@taste-and-see/nest-outbox-consumer';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { ProviderAvailabilityUpdatedHandler } from './handlers/provider-availability-updated.handler';
import { ProviderCertificationGrantedHandler } from './handlers/provider-certification-granted.handler';
import { ProviderCertificationRevokedHandler } from './handlers/provider-certification-revoked.handler';
import { ProviderProfileUpdatedHandler } from './handlers/provider-profile-updated.handler';
import { ProviderMetricsUpdatedHandler } from './handlers/provider-metrics-updated.handler';
import { ProviderServiceAreasUpdatedHandler } from './handlers/provider-service-areas-updated.handler';
import { ProviderTierChangedHandler } from './handlers/provider-tier-changed.handler';
import { ProjectionOrchestratorService } from './services/projection-orchestrator.service';
import { ProviderSnapshotClient } from './services/provider-snapshot.client';
import { SearchIndexClient } from './services/search-index.client';

/**
 * Indexer bounded module — owns the consumer-side wiring + the
 * provider-event handlers (TS-053 / TS-053-followup-3 / -5 / -5a).
 *
 * Composition:
 *
 *   - Seven handler classes (`ProviderTierChangedHandler` /
 *     `ProviderCertificationGrantedHandler` /
 *     `ProviderCertificationRevokedHandler` /
 *     `ProviderServiceAreasUpdatedHandler` /
 *     `ProviderProfileUpdatedHandler` /
 *     `ProviderAvailabilityUpdatedHandler` /
 *     `ProviderMetricsUpdatedHandler`). Each is a thin shell
 *     that delegates to the orchestrator. Every provider-event that
 *     touches a field the discovery doc surfaces re-projects the doc;
 *     the handler only reads `providerId` and the orchestrator
 *     re-fetches the source-of-truth snapshot.
 *
 *     The seventh is the odd one and worth knowing: the first six are
 *     provider EDITS, and `provider.metrics_updated` (TS-053-followup-4a)
 *     is not — it fires when a visit COMPLETES. Without it the discovery
 *     doc's `completedBookingCount` went stale until the provider next
 *     edited something, which is worst for the busy providers the field
 *     exists to reward.
 *
 *   - `ProjectionOrchestratorService` — the core projection driver.
 *     Fetches the snapshot from service-provider; PUTs / DELETEs
 *     against service-search.
 *
 *   - `ProviderSnapshotClient` + `SearchIndexClient` — fetch-based
 *     HTTP clients with shared-secret headers, bounded timeouts, and
 *     response-schema validation on the snapshot leg.
 *
 *   - DI providers for the consumer SDK's Redis client +
 *     `MemoryConsumerDedupStore`. The in-memory dedup store is the
 *     Phase-1 choice because the worker has no Postgres of its own;
 *     idempotency at service-search (the
 *     `(providerId, sourceUpdatedAt)` dedup) is the primary line of
 *     defence, and the Redis Streams PEL keeps redelivery state
 *     across restarts.
 *
 * `onModuleInit` registers the six handlers with the consumer SDK
 * before the SDK's `OutboxConsumerScheduler` calls `bootstrap` (Nest
 * guarantees each module's `OnModuleInit` runs before
 * `OnApplicationBootstrap`). The consumer SDK derives each stream key
 * from the registered event name (`XGROUP CREATE … MKSTREAM`), so
 * `registerHandler` alone subscribes — there is no separate allow-list
 * to keep in sync.
 */
@Module({
  providers: [
    ProjectionOrchestratorService,
    ProviderSnapshotClient,
    SearchIndexClient,
    ProviderTierChangedHandler,
    ProviderCertificationGrantedHandler,
    ProviderCertificationRevokedHandler,
    ProviderServiceAreasUpdatedHandler,
    ProviderMetricsUpdatedHandler,
    ProviderProfileUpdatedHandler,
    ProviderAvailabilityUpdatedHandler,
  ],
  exports: [ProjectionOrchestratorService],
})
export class IndexerModule implements OnModuleInit {
  private readonly logger = new Logger(IndexerModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly tierChanged: ProviderTierChangedHandler,
    private readonly certGranted: ProviderCertificationGrantedHandler,
    private readonly certRevoked: ProviderCertificationRevokedHandler,
    private readonly serviceAreasUpdated: ProviderServiceAreasUpdatedHandler,
    private readonly metricsUpdated: ProviderMetricsUpdatedHandler,
    private readonly profileUpdated: ProviderProfileUpdatedHandler,
    private readonly availabilityUpdated: ProviderAvailabilityUpdatedHandler,
  ) {}

  onModuleInit(): void {
    this.consumer.registerHandler(
      PROVIDER_TIER_CHANGED,
      this.tierChanged.handle.bind(this.tierChanged),
    );
    this.consumer.registerHandler(
      PROVIDER_CERTIFICATION_GRANTED,
      this.certGranted.handle.bind(this.certGranted),
    );
    this.consumer.registerHandler(
      PROVIDER_CERTIFICATION_REVOKED,
      this.certRevoked.handle.bind(this.certRevoked),
    );
    this.consumer.registerHandler(
      PROVIDER_SERVICE_AREAS_UPDATED,
      this.serviceAreasUpdated.handle.bind(this.serviceAreasUpdated),
    );
    this.consumer.registerHandler(
      PROVIDER_PROFILE_UPDATED,
      this.profileUpdated.handle.bind(this.profileUpdated),
    );
    this.consumer.registerHandler(
      PROVIDER_AVAILABILITY_UPDATED,
      this.availabilityUpdated.handle.bind(this.availabilityUpdated),
    );
    this.consumer.registerHandler(
      PROVIDER_METRICS_UPDATED,
      this.metricsUpdated.handle.bind(this.metricsUpdated),
    );
    this.logger.log(
      {
        registered: [
          PROVIDER_TIER_CHANGED,
          PROVIDER_CERTIFICATION_GRANTED,
          PROVIDER_CERTIFICATION_REVOKED,
          PROVIDER_SERVICE_AREAS_UPDATED,
          PROVIDER_PROFILE_UPDATED,
          PROVIDER_AVAILABILITY_UPDATED,
          PROVIDER_METRICS_UPDATED,
        ],
      },
      'indexer.handlers-registered',
    );
  }
}

/**
 * The Redis client the consumer SDK uses for its `XREADGROUP` /
 * `XAUTOCLAIM` / `XACK` calls.
 *
 * Passed to `OutboxConsumerModule.forRoot` in `AppModule` rather than
 * registered here: `OutboxConsumerService` is declared inside the SDK's
 * own module, so a provider declared in *this* module is not in scope at
 * its injection site (ADR-0005 / TS-506). Registering it on the SDK's
 * `@Global()` module also puts the token in scope for `HealthController`,
 * which injects the same client for its readiness probe and could not
 * see it here either.
 */
export const outboxConsumerRedisFactory: OutboxConsumerDependencyFactory<ConsumerRedisClient> = {
  useFactory: (env: Env): ConsumerRedisClient => {
    return asConsumerRedisClient(
      new Redis(env.REDIS_URL, {
        // Lazy connect so test environments can mock the client.
        lazyConnect: true,
        // The SDK issues blocking `XREADGROUP BLOCK <ms>` calls;
        // auto-pipelining would hold adjacent commands behind the
        // long-poll round-trip.
        enableAutoPipelining: false,
        maxRetriesPerRequest: 3,
      }),
    );
  },
  inject: [ENV_TOKEN],
};

/**
 * Provider for the in-memory dedup store. Phase-1 choice — the worker
 * has no Postgres of its own. Idempotency is held by:
 *
 *   1. service-search's `upsert` dedup on
 *      `(providerId, sourceUpdatedAt)`.
 *   2. The Redis Streams PEL (persists across restarts).
 *   3. This in-memory store (only effective inside one pod's
 *      lifetime).
 *
 * A future follow-up can add a Postgres-backed dedup store if
 * cross-restart dedup becomes operationally meaningful; today the
 * upstream sourceUpdatedAt-based dedup covers the failure modes.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (): ConsumerDedupStore => new MemoryConsumerDedupStore(),
  };
