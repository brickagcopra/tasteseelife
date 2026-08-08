/**
 * `setupSharedContainers` — vitest globalSetup entrypoint that boots
 * ONE Postgres + ONE Redis container per suite (TS-009e-followup-2).
 *
 * Pairs with `createIsolatedDatabase` for the per-file database
 * carve-out. Together they replace the per-file
 * `startIntegrationTestStack` pattern for services with ≥3 integration
 * test files (today: service-identity only).
 *
 * Suite-shared shape (single container) is materially cheaper than
 * per-file (5× containers in service-identity's case). The remaining
 * cost — `prisma migrate deploy` against a freshly-CREATEd database —
 * runs once per file regardless of which model is in use; the saving
 * is purely the container start.
 *
 * Vitest's globalSetup runs in a separate process from test workers,
 * so the shared values reach tests via `ctx.provide(...)` /
 * `inject(...)` (JSON-serialisable only). The three provided values:
 *
 *   - `postgresAdminUrl` — full admin connection URL, including
 *     user / password / host / port / `tastesee_admin` database.
 *     `createIsolatedDatabase` parses this to synthesise the per-file
 *     `databaseUrl` and to drive the `docker exec ... psql` CREATE /
 *     DROP statements.
 *   - `postgresContainerId` — docker container ID, used by
 *     `createIsolatedDatabase` for the `docker exec` invocation.
 *   - `redisUrl` — `redis://host:port`, ready to slot into
 *     `process.env.REDIS_URL`. The Redis is shared across files;
 *     each test should namespace its keys per CLAUDE.md §3.7 so two
 *     files' keys never collide.
 *
 * The function returns a teardown closure that stops Redis first,
 * then Postgres (reverse-start order), so the shared resources are
 * released at suite end. Failures inside teardown are swallowed —
 * the runner is about to exit and one stuck container shouldn't fail
 * the whole suite.
 *
 * Usage from a service's `vitest.integration.config.ts`:
 *
 *   import { defineConfig } from 'vitest/config';
 *   export default defineConfig({
 *     test: {
 *       globalSetup: ['./test/integration/global-setup.ts'],
 *       ...
 *     },
 *   });
 *
 * The service-local `global-setup.ts` file is a one-line wrapper:
 *
 *   import { setupSharedContainers } from '@taste-and-see/testing';
 *   export default setupSharedContainers;
 *
 * (Or `(ctx) => setupSharedContainers(ctx, { adminDatabase: '...' })`
 * if the service needs to override the defaults.)
 */
// Force the `'vitest'` module into tsc's resolver scope so the
// `declare module 'vitest'` augmentation at the bottom of this file
// resolves during declaration emission. Without an explicit import
// from `'vitest'` (not `'vitest/node'`), tsc emits TS2664 "Invalid
// module name in augmentation" during the build because the base
// tsconfig pins `types: ['node']` — vitest's types are not ambient.
import type {} from 'vitest';
import type { GlobalSetupContext } from 'vitest/node';

import { startPostgresContainer } from './postgres';
import { startRedisContainer } from './redis';

/**
 * Default admin database name. Stable across runs so test files can
 * parse the admin URL deterministically. Tests should NOT write user
 * data to this database — each file's `createIsolatedDatabase` call
 * carves out its own database for that.
 */
const DEFAULT_ADMIN_DATABASE = 'tastesee_admin';

export interface SetupSharedContainersOptions {
  /** Override the admin database name. Defaults to `tastesee_admin`. */
  readonly adminDatabase?: string;
  /** Override the Postgres image tag. Defaults to `postgres:16-alpine`. */
  readonly postgresImage?: string;
  /** Override the Redis image tag. Defaults to `redis:7-alpine`. */
  readonly redisImage?: string;
}

/**
 * Boot the shared Postgres + Redis pair and `ctx.provide(...)` their
 * connection info to test workers. Returns a teardown closure suitable
 * as the vitest globalSetup default export.
 *
 * Order: Postgres first → Redis. If Redis fails to start, the Postgres
 * container is torn down before re-raising so the runner doesn't leak
 * a half-booted stack.
 */
export async function setupSharedContainers(
  ctx: GlobalSetupContext,
  options: SetupSharedContainersOptions = {},
): Promise<() => Promise<void>> {
  const postgresOpts: { database: string; image?: string } = {
    database: options.adminDatabase ?? DEFAULT_ADMIN_DATABASE,
  };
  if (options.postgresImage !== undefined) {
    postgresOpts.image = options.postgresImage;
  }
  const postgres = await startPostgresContainer(postgresOpts);

  const redisOpts: { image?: string } = {};
  if (options.redisImage !== undefined) {
    redisOpts.image = options.redisImage;
  }

  let redis;
  try {
    redis = await startRedisContainer(redisOpts);
  } catch (err) {
    await postgres.container.stop().catch(() => {
      // Swallow — already in an error path, the original `err` is
      // the one the caller cares about.
    });
    throw err;
  }

  ctx.provide('postgresAdminUrl', postgres.databaseUrl);
  ctx.provide('postgresContainerId', postgres.container.getId());
  ctx.provide('redisUrl', redis.redisUrl);

  return async (): Promise<void> => {
    await redis.container.stop().catch(() => {
      // Swallow — runner is exiting; a hung container shouldn't fail
      // the suite at this point.
    });
    await postgres.container.stop().catch(() => {
      // Same as above.
    });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    /**
     * Postgres admin connection URL — `postgresql://user:password@host:port/tastesee_admin`.
     * Provided by `setupSharedContainers`; consumed by
     * `createIsolatedDatabase` to drive the per-file `CREATE DATABASE`
     * + to synthesise the per-file `databaseUrl`.
     */
    postgresAdminUrl: string;
    /**
     * Docker container ID of the shared Postgres. Consumed by
     * `createIsolatedDatabase` for the `docker exec <id> psql ...`
     * invocation.
     */
    postgresContainerId: string;
    /**
     * Shared Redis URL — `redis://host:port`. The container is shared
     * across every test file in the suite; each test should namespace
     * its keys per CLAUDE.md §3.7 so two files don't collide.
     */
    redisUrl: string;
  }
}
