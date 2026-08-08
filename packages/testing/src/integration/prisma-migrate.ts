/**
 * `prisma migrate deploy` runner for integration suites.
 *
 * Applies a service's full migration set against an ephemeral database
 * via the same execution path production deployment uses (the locally-
 * installed Prisma CLI, invoked through `node` to dodge `pnpm exec` /
 * `npx` shell-resolution differences across Windows / macOS / Linux
 * CI runners).
 *
 * The environment is narrowed to `{ ...process.env, DATABASE_URL }` so
 * the migrate run cannot leak a host `.env` value into the ephemeral
 * cluster — a stray `DATABASE_URL` in the host's shell would otherwise
 * silently retarget the migration at the developer's local DB.
 *
 * Throws whatever `execFileSync` throws on a non-zero exit (typically
 * a `Command failed` error with the Prisma stderr embedded). Callers
 * should not catch — a migration failure is a hard test-suite failure.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export interface ApplyPrismaMigrationsOptions {
  /**
   * Absolute path to the service root (the directory containing
   * `prisma/schema.prisma` and `node_modules/prisma`). The harness
   * uses this to locate both the schema file and the Prisma CLI
   * binary.
   */
  readonly serviceRoot: string;
  /**
   * `DATABASE_URL` to pass to `prisma migrate deploy`. The migration
   * will run against this URL — typically the ephemeral container
   * URL returned by `startPostgresContainer`.
   */
  readonly databaseUrl: string;
  /**
   * Override the schema-file path. Defaults to
   * `{serviceRoot}/prisma/schema.prisma`.
   */
  readonly schemaPath?: string;
  /**
   * Override the Prisma CLI binary path. Defaults to
   * `{serviceRoot}/node_modules/prisma/build/index.js`. Override is
   * useful only when the test runs from an unusual working directory
   * where the service-local Prisma install is not resolvable.
   */
  readonly prismaCliPath?: string;
}

/**
 * Run `prisma migrate deploy` against the supplied database URL using
 * the service-local Prisma CLI. Synchronous (mirrors `execFileSync`)
 * because the migration is a hard precondition for every subsequent
 * test step — no benefit to async semantics here.
 */
export function applyPrismaMigrations(options: ApplyPrismaMigrationsOptions): void {
  if (options.serviceRoot.length === 0) {
    throw new Error('applyPrismaMigrations: `serviceRoot` must be a non-empty string');
  }
  if (options.databaseUrl.length === 0) {
    throw new Error('applyPrismaMigrations: `databaseUrl` must be a non-empty string');
  }

  const schemaPath = options.schemaPath ?? resolve(options.serviceRoot, 'prisma', 'schema.prisma');
  const prismaCliPath =
    options.prismaCliPath ??
    resolve(options.serviceRoot, 'node_modules', 'prisma', 'build', 'index.js');

  execFileSync(process.execPath, [prismaCliPath, 'migrate', 'deploy', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: options.databaseUrl },
    stdio: 'inherit',
    cwd: options.serviceRoot,
  });
}
