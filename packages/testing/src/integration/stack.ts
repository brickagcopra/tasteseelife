/**
 * `startIntegrationTestStack` — the canonical bootstrap every service's
 * `test/integration/**` file consumed verbatim before TS-009e-followup-1.
 *
 * Composes `startPostgresContainer` + `applyPrismaMigrations` +
 * `startRedisContainer` into one call. Returns the URLs + container
 * handles + a single `stop()` for teardown.
 *
 * What this harness OWNS:
 *
 *   - Container start (Postgres + Redis on pinned images).
 *   - Tmpfs-backed Postgres data dir + readiness gating.
 *   - `prisma migrate deploy` against the ephemeral DB via the
 *     service-local Prisma CLI.
 *   - Cleanup-safe teardown (stops whichever containers actually
 *     started, even if a later step in `beforeAll` failed).
 *
 * What this harness DELIBERATELY DOES NOT OWN:
 *
 *   - Env-var wiring. Each service's `app.module.ts` evaluates
 *     `const moduleEnv = loadEnv()` at the top of the file, and every
 *     required env var must be set BEFORE the AppModule import
 *     resolves. The set of required vars differs per service
 *     (service-identity requires 10+, service-subscription requires 4,
 *     service-provider requires 6), so the env block stays in the
 *     test file where the per-service shape lives.
 *   - `NestFactory.create(AppModule)` + `app.listen(...)`. The
 *     AppModule's dynamic import must run AFTER the env block above,
 *     and the per-service import path is unique. Each test file owns
 *     this step.
 *   - The harness PrismaService — each service has its own
 *     `src/prisma/prisma.service.ts` whose generated client points at
 *     the service's schema. Cross-importing one service's PrismaService
 *     would couple services through the test surface, which CLAUDE.md
 *     §2.3 forbids ("Never import another service's Prisma client").
 *   - HTTP / cookie helpers. Per-test shapes vary too much (cookie
 *     parsing for auth, idempotency-key cache asserting, no-body
 *     /healthz round-trips, …) to share without making the helpers
 *     less useful than the inline ones.
 */
import { applyPrismaMigrations } from './prisma-migrate';
import { startPostgresContainer, type StartedPostgresContainer } from './postgres';
import { startRedisContainer, type StartedRedisContainer } from './redis';

import type { StartedTestContainer } from 'testcontainers';

export interface StartIntegrationTestStackOptions {
  /**
   * Absolute path to the service root (containing `prisma/schema.prisma`
   * and `node_modules/prisma`). Pass `resolve(__dirname, '..', '..')`
   * from a test file at `test/integration/foo.integration.test.ts`.
   */
  readonly serviceRoot: string;
  /**
   * Postgres database name. Required so each service's suite picks a
   * unique-per-service name (`identity_test`, `subscription_test`,
   * `provider_test`, …).
   */
  readonly database: string;
  /** Override the Postgres image. Defaults to `postgres:16-alpine`. */
  readonly postgresImage?: string;
  /** Override the Redis image. Defaults to `redis:7-alpine`. */
  readonly redisImage?: string;
  /**
   * Override the Prisma schema path. Defaults to
   * `{serviceRoot}/prisma/schema.prisma`.
   */
  readonly prismaSchemaPath?: string;
  /**
   * Skip the `prisma migrate deploy` step. Useful only for the rare
   * test that needs the Postgres container without any schema yet
   * (e.g. asserting first-boot DDL via raw SQL). Defaults to `false`.
   */
  readonly skipMigrate?: boolean;
}

export interface IntegrationTestStack {
  /** `postgresql://...` ready to slot into `process.env.DATABASE_URL`. */
  readonly databaseUrl: string;
  /** `redis://...` ready to slot into `process.env.REDIS_URL`. */
  readonly redisUrl: string;
  /** Underlying Postgres container handle. */
  readonly postgresContainer: StartedTestContainer;
  /** Underlying Redis container handle. */
  readonly redisContainer: StartedTestContainer;
  /**
   * Tear down both containers. Safe to call from `afterAll` after a
   * partial bring-up (e.g. if `applyPrismaMigrations` threw — the
   * harness throws, but only after capturing the Postgres handle, so
   * the caller can still get a `stop()` that releases it). Idempotent
   * on a second call.
   */
  stop(): Promise<void>;
}

/**
 * Boot the canonical Postgres + Redis + migrate-deploy stack.
 *
 * Order: Postgres first → migrations → Redis. The order matters
 * because if migrations fail, we want the Postgres container handle in
 * the error path so callers can stop it via the `stop()` closure that
 * `startIntegrationTestStack` wires up. Booting Redis after the
 * migration also avoids paying ~1s of Redis startup time when the
 * migration is going to fail anyway.
 */
export async function startIntegrationTestStack(
  options: StartIntegrationTestStackOptions,
): Promise<IntegrationTestStack> {
  if (options.serviceRoot.length === 0) {
    throw new Error('startIntegrationTestStack: `serviceRoot` must be a non-empty string');
  }
  if (options.database.length === 0) {
    throw new Error('startIntegrationTestStack: `database` must be a non-empty string');
  }

  let postgres: StartedPostgresContainer | undefined;
  let redis: StartedRedisContainer | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Defensive `?` — if the Postgres start succeeded but the Redis
    // start (or the migration) failed, we still want the Postgres
    // container to be released so the runner doesn't leak Docker
    // resources. Stops run in reverse-start order.
    if (redis) {
      await redis.container.stop();
    }
    if (postgres) {
      await postgres.container.stop();
    }
  };

  try {
    const postgresOpts: { database: string; image?: string } = {
      database: options.database,
    };
    if (options.postgresImage !== undefined) {
      postgresOpts.image = options.postgresImage;
    }
    postgres = await startPostgresContainer(postgresOpts);

    if (options.skipMigrate !== true) {
      const migrateOpts: {
        serviceRoot: string;
        databaseUrl: string;
        schemaPath?: string;
      } = {
        serviceRoot: options.serviceRoot,
        databaseUrl: postgres.databaseUrl,
      };
      if (options.prismaSchemaPath !== undefined) {
        migrateOpts.schemaPath = options.prismaSchemaPath;
      }
      applyPrismaMigrations(migrateOpts);
    }

    const redisOpts: { image?: string } = {};
    if (options.redisImage !== undefined) {
      redisOpts.image = options.redisImage;
    }
    redis = await startRedisContainer(redisOpts);

    return {
      databaseUrl: postgres.databaseUrl,
      redisUrl: redis.redisUrl,
      postgresContainer: postgres.container,
      redisContainer: redis.container,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
