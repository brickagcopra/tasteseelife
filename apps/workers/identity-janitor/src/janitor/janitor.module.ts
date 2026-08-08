import { Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import { AppConfigModule, ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { JanitorMetrics } from './janitor-metrics';
import { JanitorScheduler } from './janitor-scheduler.service';
import { JanitorWorkerService } from './janitor-worker.service';
import { PgPruneExecutor, PruneRepository, type PruneExecutor } from './prune.repository';
import { buildPruneTargets } from './prune-targets';

export const PG_POOL_TOKEN = Symbol('IDENTITY_JANITOR_PG_POOL');
export const PRUNE_EXECUTOR_TOKEN = Symbol('IDENTITY_JANITOR_PRUNE_EXECUTOR');

/**
 * Disposes the Postgres pool when the Nest container shuts down. Lives
 * in its own injectable rather than on `JanitorModule` itself because
 * Nest applies `OnApplicationShutdown` to providers, not modules.
 */
@Injectable()
export class JanitorShutdownHook implements OnApplicationShutdown {
  private readonly log = new Logger('JanitorShutdownHook');
  constructor(@Inject(PG_POOL_TOKEN) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err) {
      this.log.warn(`pg pool close failed: ${(err as Error).message ?? String(err)}`);
    }
  }
}

/**
 * Wires the janitor's runtime. Pulls env from `AppConfigModule`,
 * constructs a Postgres pool against the identity database, builds the
 * `PruneRepository` + per-table targets, and arms the `JanitorScheduler`
 * sweep loop.
 *
 * The worker connects to the identity DB with raw `pg` (it never
 * imports service-identity's Prisma client — CLAUDE.md §2.3) and only
 * ever touches the fixed code-constant target tables in
 * `prune-targets.ts`. This mirrors the outbox-relay's posture: a
 * platform retention/maintenance process scoped to a known schema, not
 * cross-service business logic.
 *
 * Lifecycle: the Pool is explicitly closed via `JanitorShutdownHook` so
 * a SIGTERM from Kubernetes drains cleanly within the configured
 * terminationGracePeriodSeconds.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PG_POOL_TOKEN,
      useFactory: (env: Env): Pool =>
        new Pool({
          connectionString: env.DATABASE_URL,
          // Phase 1 single-replica janitor; a tiny pool is plenty
          // (one connection per in-flight batch, sweeps are serial).
          max: 2,
          idleTimeoutMillis: 30_000,
          // Fail-fast: if Postgres is down at startup the readiness
          // probe returns 503 rather than the worker hanging.
          connectionTimeoutMillis: 5_000,
        }),
      inject: [ENV_TOKEN],
    },
    {
      provide: PRUNE_EXECUTOR_TOKEN,
      useFactory: (pool: Pool): PruneExecutor => new PgPruneExecutor(pool),
      inject: [PG_POOL_TOKEN],
    },
    {
      provide: PruneRepository,
      useFactory: (executor: PruneExecutor, env: Env): PruneRepository =>
        new PruneRepository(executor, env.JANITOR_BATCH_SIZE, env.JANITOR_MAX_BATCHES_PER_SWEEP),
      inject: [PRUNE_EXECUTOR_TOKEN, ENV_TOKEN],
    },
    JanitorMetrics,
    {
      provide: JanitorWorkerService,
      useFactory: (
        repository: PruneRepository,
        env: Env,
        metrics: JanitorMetrics,
      ): JanitorWorkerService =>
        new JanitorWorkerService(repository, buildPruneTargets(env), metrics),
      inject: [PruneRepository, ENV_TOKEN, JanitorMetrics],
    },
    JanitorScheduler,
    JanitorShutdownHook,
  ],
  exports: [PG_POOL_TOKEN, JanitorWorkerService, JanitorScheduler],
})
export class JanitorModule {}
