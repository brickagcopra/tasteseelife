import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import {
  IndexerModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './indexer/indexer.module';

/**
 * Composition root for the search-indexer worker (TS-053).
 *
 * - `AppConfigModule` validates `process.env` at bootstrap and
 *   exposes the resulting `Env` via DI.
 * - `OutboxConsumerModule.forRoot(...)` wires the global consumer
 *   SDK (Redis stream consumer + dedup store + scheduler) with the
 *   tuning vars from env. The Redis client + dedup store providers
 *   are supplied by `IndexerModule`.
 * - `IndexerModule` defines the three event handlers + the
 *   orchestrator + the snapshot/index HTTP clients.
 * - `HealthModule` provides the `/healthz` + `/readyz` HTTP probes.
 *
 * Env wiring. `OutboxConsumerModule.forRoot` needs synchronously-
 * resolved tuning values at module-definition time, so we call
 * `loadEnv()` once here — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in the
 * other worker (`apps/workers/outbox-relay/src/app.module.ts`) +
 * service-accounting.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    AppConfigModule,
    OutboxConsumerModule.forRoot({
      consumerGroup: moduleEnv.OUTBOX_CONSUMER_GROUP,
      consumerName: moduleEnv.OUTBOX_CONSUMER_NAME,
      streamPrefix: moduleEnv.OUTBOX_STREAM_PREFIX,
      maxAttempts: moduleEnv.OUTBOX_MAX_ATTEMPTS,
      pollBlockMs: moduleEnv.OUTBOX_POLL_BLOCK_MS,
      reclaimIdleMs: moduleEnv.OUTBOX_RECLAIM_IDLE_MS,
      pollIntervalMs: moduleEnv.OUTBOX_POLL_INTERVAL_MS,
      // TS-506 / ADR-0005 — the SDK module declares the two providers
      // `OutboxConsumerService` injects. They used to be registered by
      // `IndexerModule`, where Nest could never see them: a provider
      // resolves against the module that *declares* it, and the service is
      // declared inside the SDK's own `@Global()` module.
      imports: [AppConfigModule],
      redis: outboxConsumerRedisFactory,
      dedupStore: outboxConsumerDedupStoreFactory,
    }),
    IndexerModule,
    HealthModule,
    // `httpMetrics: false` — only HTTP surface is health + scrape.
    ObservabilityModule.forRoot({ serviceName: 'worker-search-indexer', httpMetrics: false }),
  ],
})
export class AppModule {}
