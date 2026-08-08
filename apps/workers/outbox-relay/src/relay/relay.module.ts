import { Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis as IoRedisClient } from 'ioredis';
import { Pool } from 'pg';

import { ENV_TOKEN, AppConfigModule } from '../config/config.module';
import { type Env, parseSources } from '../config/env';
import { type OutboxClaimRepository, PgOutboxClaimRepository } from './outbox-claim.repository';
import { RedisStreamPublisher, type BusPublisher } from './redis-stream-publisher';
import { RelayMetrics } from './relay-metrics';
import { RelayScheduler } from './relay-scheduler.service';
import { RelayWorkerService } from './relay-worker.service';

export const PG_POOL_TOKEN = Symbol('OUTBOX_RELAY_PG_POOL');
export const REDIS_TOKEN = Symbol('OUTBOX_RELAY_REDIS');
export const OUTBOX_REPO_TOKEN = Symbol('OUTBOX_RELAY_REPO');
export const BUS_PUBLISHER_TOKEN = Symbol('OUTBOX_RELAY_BUS_PUBLISHER');

/**
 * Disposes the Postgres pool + Redis client when the Nest container
 * shuts down. Lives in its own injectable rather than on
 * `RelayModule` itself because Nest applies `OnApplicationShutdown`
 * to providers, not modules.
 */
@Injectable()
export class RelayShutdownHook implements OnApplicationShutdown {
  private readonly log = new Logger('RelayShutdownHook');
  constructor(
    @Inject(PG_POOL_TOKEN) private readonly pool: Pool,
    @Inject(REDIS_TOKEN) private readonly redis: IoRedisClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err) {
      this.log.warn(`pg pool close failed: ${(err as Error).message ?? String(err)}`);
    }
    try {
      await this.redis.quit();
    } catch (err) {
      this.log.warn(`redis quit failed: ${(err as Error).message ?? String(err)}`);
    }
  }
}

/**
 * Wires the relay's runtime. Pulls env from `AppConfigModule`,
 * constructs a Postgres pool + ioredis client, builds the
 * `RelayWorkerService` against the per-source repository + bus
 * publisher, and arms the `RelayScheduler` poll loop.
 *
 * Lifecycle: the Pool and Redis client are explicitly closed via
 * `RelayShutdownHook` so a `SIGTERM` from Kubernetes drains
 * cleanly within the configured terminationGracePeriodSeconds.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PG_POOL_TOKEN,
      useFactory: (env: Env): Pool =>
        new Pool({
          connectionString: env.DATABASE_URL,
          // Phase 1 single-replica relay; small pool is fine.
          max: 4,
          idleTimeoutMillis: 30_000,
          // Fail-fast: if Postgres is down at startup we'd rather
          // the readiness probe return 503 than the relay hang.
          connectionTimeoutMillis: 5_000,
        }),
      inject: [ENV_TOKEN],
    },
    {
      provide: REDIS_TOKEN,
      useFactory: (env: Env): IoRedisClient => {
        const log = new Logger('RelayModule.redis');
        const client = new IoRedisClient(env.REDIS_URL, {
          // Don't queue commands forever when Redis is down — fail
          // fast and let the cycle re-claim the row on the next
          // tick. Same posture as `nest-idempotency`.
          maxRetriesPerRequest: 1,
          lazyConnect: false,
          enableOfflineQueue: false,
        });
        client.on('error', (errEvent) => log.warn(`redis client error: ${errEvent.message}`));
        return client;
      },
      inject: [ENV_TOKEN],
    },
    {
      provide: OUTBOX_REPO_TOKEN,
      useFactory: (pool: Pool): OutboxClaimRepository => new PgOutboxClaimRepository(pool),
      inject: [PG_POOL_TOKEN],
    },
    {
      provide: BUS_PUBLISHER_TOKEN,
      useFactory: (redis: IoRedisClient, env: Env): BusPublisher =>
        new RedisStreamPublisher(redis, env.STREAM_NAME_PREFIX, env.STREAM_MAXLEN),
      inject: [REDIS_TOKEN, ENV_TOKEN],
    },
    RelayMetrics,
    {
      provide: RelayWorkerService,
      useFactory: (
        repo: OutboxClaimRepository,
        publisher: BusPublisher,
        env: Env,
        metrics: RelayMetrics,
      ): RelayWorkerService =>
        new RelayWorkerService(
          repo,
          publisher,
          {
            sources: parseSources(env.OUTBOX_SOURCES),
            batchSize: env.BATCH_SIZE,
            maxAttempts: env.MAX_ATTEMPTS,
          },
          metrics,
        ),
      inject: [OUTBOX_REPO_TOKEN, BUS_PUBLISHER_TOKEN, ENV_TOKEN, RelayMetrics],
    },
    {
      provide: RelayScheduler,
      useFactory: (worker: RelayWorkerService, env: Env): RelayScheduler =>
        new RelayScheduler(worker, env.POLL_INTERVAL_MS),
      inject: [RelayWorkerService, ENV_TOKEN],
    },
    RelayShutdownHook,
  ],
  exports: [PG_POOL_TOKEN, REDIS_TOKEN, RelayWorkerService, RelayScheduler],
})
export class RelayModule {}
