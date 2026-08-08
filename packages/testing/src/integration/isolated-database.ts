/**
 * `createIsolatedDatabase` — per-file Postgres database carved out of a
 * shared container booted by `setupSharedContainers` (TS-009e-followup-2).
 *
 * The shared-stack model boots ONE Postgres + Redis pair per vitest
 * suite (via `globalSetup`) and each test file CREATEs its own
 * database for isolation. This helper owns the per-file step: issue
 * `CREATE DATABASE "<name>"` against the admin connection, apply
 * Prisma migrations, and hand back a drop closure for `afterAll`.
 *
 * The CREATE / DROP statements run via `docker exec <id> psql ...`
 * rather than a Postgres client library. Three reasons:
 *
 *   1. No new npm dep — `pg` is not on CLAUDE.md §13's approved list,
 *      and adding it just for two SQL statements per test file would
 *      need an ADR. The docker CLI is already in `$PATH` everywhere
 *      Testcontainers works.
 *   2. The Postgres container's `psql` binary speaks the wire protocol
 *      via the unix socket inside the container — no TCP, no
 *      authentication round-trip, no pg_hba.conf surprises across
 *      runners.
 *   3. Matches the harness's existing precedent: `applyPrismaMigrations`
 *      shells out to the Prisma CLI via `execFileSync` rather than
 *      invoking Prisma's internal migration engine in-process.
 *
 * Cleanup posture:
 *
 *   - `drop()` is idempotent on a second call and uses `IF EXISTS WITH
 *     (FORCE)` so a dangling connection from a crashed test doesn't
 *     block the drop.
 *   - If `applyPrismaMigrations` throws, the helper attempts a
 *     best-effort drop of the just-created database before re-raising
 *     so the runner doesn't leak it for the rest of the test run.
 *   - The shared Postgres container itself is teardown'd by the
 *     `globalSetup` teardown closure, so even if every file's `drop()`
 *     somehow failed, the container disappears at suite end and the
 *     databases die with it.
 */
import { execFileSync } from 'node:child_process';

import { applyPrismaMigrations } from './prisma-migrate';

export interface CreateIsolatedDatabaseOptions {
  /**
   * Postgres admin connection URL (typically the value provided as
   * `postgresAdminUrl` by `setupSharedContainers`). Used as the
   * connection point for the `CREATE DATABASE` + `DROP DATABASE`
   * statements AND parsed to extract the user / password / host / port
   * for the returned `databaseUrl`. Path segment must name an existing
   * database we can connect to issue the CREATE.
   */
  readonly postgresAdminUrl: string;
  /**
   * Docker container ID of the running Postgres (typically the value
   * provided as `postgresContainerId` by `setupSharedContainers`).
   * The helper invokes `docker exec <id> psql ...` against this ID;
   * passing a stale or unknown ID surfaces a `docker exec` error from
   * the CLI verbatim.
   */
  readonly postgresContainerId: string;
  /**
   * Database name to create. Each test file inside a service should
   * pick a unique name (`identity_test_auth`, `identity_test_mfa`, …)
   * so two files inside the same suite don't share state.
   *
   * Constrained to `[A-Za-z_][A-Za-z0-9_]{0,62}` to dodge any SQL
   * injection / quoting risk in the CREATE / DROP statements that
   * pass the name through `docker exec` verbatim.
   */
  readonly databaseName: string;
  /**
   * Absolute path to the service root (the directory containing
   * `prisma/schema.prisma` and `node_modules/prisma`). Forwarded to
   * `applyPrismaMigrations` so the per-file database is migrated with
   * the service's full Prisma schema.
   */
  readonly serviceRoot: string;
  /**
   * Override the Prisma schema path. Defaults to
   * `{serviceRoot}/prisma/schema.prisma`. Same shape as
   * `applyPrismaMigrations`.
   */
  readonly schemaPath?: string;
  /**
   * Override the Prisma CLI binary path. Defaults to
   * `{serviceRoot}/node_modules/prisma/build/index.js`.
   */
  readonly prismaCliPath?: string;
  /**
   * Override the docker binary name / path. Defaults to `docker` (the
   * standard PATH lookup). Useful only for narrow scenarios where the
   * docker CLI lives under a non-standard name (e.g. `nerdctl`).
   */
  readonly dockerBinary?: string;
}

export interface IsolatedDatabaseHandle {
  /**
   * `postgresql://...` ready to slot into `process.env.DATABASE_URL`
   * or a `new PrismaClient({ datasourceUrl })`. Points at the
   * per-file database (NOT the admin database).
   */
  readonly databaseUrl: string;
  /**
   * Drop the per-file database via `docker exec <id> psql ... DROP
   * DATABASE IF EXISTS "<name>" WITH (FORCE)`. Idempotent on a second
   * call. Safe to call from `afterAll` after a partial bring-up.
   */
  drop(): Promise<void>;
}

interface ParsedPostgresUrl {
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: number;
  readonly adminDatabase: string;
}

function parsePostgresAdminUrl(url: string, fnName: string): ParsedPostgresUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${fnName}: \`postgresAdminUrl\` must be a valid URL`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `${fnName}: \`postgresAdminUrl\` must use postgresql:// or postgres:// (got ${parsed.protocol})`,
    );
  }
  if (parsed.username.length === 0) {
    throw new Error(`${fnName}: \`postgresAdminUrl\` must include a user`);
  }
  const adminDatabase = parsed.pathname.replace(/^\//, '');
  if (adminDatabase.length === 0) {
    throw new Error(`${fnName}: \`postgresAdminUrl\` must include an admin database in the path`);
  }
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 5432;
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port,
    adminDatabase,
  };
}

const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function validateDatabaseName(name: string, fnName: string): void {
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      `${fnName}: \`databaseName\` must match /^[A-Za-z_][A-Za-z0-9_]{0,62}$/ (got ${JSON.stringify(name)})`,
    );
  }
}

function buildPsqlArgs(
  containerId: string,
  user: string,
  adminDatabase: string,
  sqlStatement: string,
): string[] {
  return [
    'exec',
    containerId,
    'psql',
    '-U',
    user,
    '-d',
    adminDatabase,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sqlStatement,
  ];
}

/**
 * Create an isolated per-file database against the shared Postgres
 * container, apply Prisma migrations to it, and return a handle whose
 * `drop()` closure tears it back down.
 *
 * Synchronous CREATE / DROP semantics under the hood (the docker exec
 * call is synchronous via `execFileSync`); the async signature
 * accommodates a future shift to a non-blocking pg client without a
 * caller-side change.
 */
export async function createIsolatedDatabase(
  options: CreateIsolatedDatabaseOptions,
): Promise<IsolatedDatabaseHandle> {
  if (options.postgresAdminUrl.length === 0) {
    throw new Error('createIsolatedDatabase: `postgresAdminUrl` must be a non-empty string');
  }
  if (options.postgresContainerId.length === 0) {
    throw new Error('createIsolatedDatabase: `postgresContainerId` must be a non-empty string');
  }
  if (options.databaseName.length === 0) {
    throw new Error('createIsolatedDatabase: `databaseName` must be a non-empty string');
  }
  if (options.serviceRoot.length === 0) {
    throw new Error('createIsolatedDatabase: `serviceRoot` must be a non-empty string');
  }
  validateDatabaseName(options.databaseName, 'createIsolatedDatabase');

  const admin = parsePostgresAdminUrl(options.postgresAdminUrl, 'createIsolatedDatabase');
  const dockerBinary = options.dockerBinary ?? 'docker';

  execFileSync(
    dockerBinary,
    buildPsqlArgs(
      options.postgresContainerId,
      admin.user,
      admin.adminDatabase,
      `CREATE DATABASE "${options.databaseName}"`,
    ),
    { stdio: 'inherit' },
  );

  const databaseUrl =
    `postgresql://${encodeURIComponent(admin.user)}:${encodeURIComponent(admin.password)}` +
    `@${admin.host}:${admin.port}` +
    `/${options.databaseName}`;

  try {
    const migrateOpts: {
      serviceRoot: string;
      databaseUrl: string;
      schemaPath?: string;
      prismaCliPath?: string;
    } = {
      serviceRoot: options.serviceRoot,
      databaseUrl,
    };
    if (options.schemaPath !== undefined) {
      migrateOpts.schemaPath = options.schemaPath;
    }
    if (options.prismaCliPath !== undefined) {
      migrateOpts.prismaCliPath = options.prismaCliPath;
    }
    applyPrismaMigrations(migrateOpts);
  } catch (err) {
    try {
      execFileSync(
        dockerBinary,
        buildPsqlArgs(
          options.postgresContainerId,
          admin.user,
          admin.adminDatabase,
          `DROP DATABASE IF EXISTS "${options.databaseName}" WITH (FORCE)`,
        ),
        { stdio: 'inherit' },
      );
    } catch {
      // Best-effort cleanup; the shared container will be torn down at
      // globalTeardown anyway. Don't mask the original error.
    }
    throw err;
  }

  let dropped = false;
  const drop = async (): Promise<void> => {
    if (dropped) return;
    dropped = true;
    try {
      execFileSync(
        dockerBinary,
        buildPsqlArgs(
          options.postgresContainerId,
          admin.user,
          admin.adminDatabase,
          `DROP DATABASE IF EXISTS "${options.databaseName}" WITH (FORCE)`,
        ),
        { stdio: 'inherit' },
      );
    } catch {
      // The shared container is torn down at globalTeardown anyway.
      // Swallow the error so a noisy DROP doesn't fail the test run.
    }
  };

  return { databaseUrl, drop };
}
