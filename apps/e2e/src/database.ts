import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runOrThrow } from './exec';
import {
  E2E_DATABASE_NAME,
  FLEET,
  adminDatabaseUrl,
  e2eDatabaseUrl,
  serviceDir,
  type FleetService,
} from './fleet';
import { REPO_ROOT, loadRepoEnvExample } from './repo-env';

/**
 * E2E database lifecycle (TS-505).
 *
 * **Drop and rebuild by default.** Every run starts from an empty database and
 * replays every migration. That costs a few seconds and buys two things: specs
 * that cannot pass because of a row a previous run left behind, and a standing
 * check that the migration history applies cleanly from zero — which
 * CLAUDE.md §4.4 asks for and which nothing else in this repo exercises
 * (each service's integration suite migrates its own throwaway container, one
 * service at a time, never the fleet together in one database).
 *
 * Set `E2E_RESET_DATABASE=false` to keep the existing database and only apply
 * pending migrations. That is an iteration convenience, not a supported mode:
 * a suite run that way proves less, so CI never sets it.
 *
 * **The database is never `tastesee`.** A destructive reset that could point at
 * a developer's working database is a footgun with no upside, so the name is a
 * constant in `fleet.ts` rather than anything derived from the environment.
 */

/** Where the harness stages the one-line SQL files Prisma's CLI needs a path for. */
const TMP_DIR = resolve(REPO_ROOT, 'apps', 'e2e', '.tmp');

export interface DatabaseSetupResult {
  readonly databaseUrl: string;
  readonly reset: boolean;
  readonly migrated: readonly string[];
  /** Fleet members whose post-migration seed script ran. */
  readonly seeded: readonly string[];
}

/**
 * Seed scripts that must run after a service's migrations (TS-505d1).
 *
 * A migration creates the table; the catalog fills it, and some tables are
 * useless empty. `identity.roles` is the first: `super_admin` has to exist as
 * a row before the harness can grant it, and without it every admin surface on
 * the platform is unreachable by any actor the suite can mint.
 *
 * Keyed by fleet directory so a service that is not in `FLEET` cannot have its
 * seed run against a schema that was never migrated. Each entry names a
 * package script rather than a path — the script is the interface the
 * deployment uses too (CLAUDE.md §14 deploy notes say `pnpm seed:rbac` must
 * re-run whenever a permission is added), so the suite exercising the same
 * entry point means a broken seed breaks here rather than in staging.
 */
const SEED_SCRIPTS: Readonly<Record<string, string>> = {
  'service-identity': 'seed:rbac',
  // A journal line references an account by code. Without the chart, the
  // first `booking.completed` a consumer picks up fails to post — and it
  // fails inside a background consumer, where the symptom is a journal that
  // never appears rather than an error anyone sees.
  'service-accounting': 'seed:chart-of-accounts',
};

/**
 * Provision the E2E database and bring every schema-owning fleet member's
 * migrations up to date.
 *
 * `prisma migrate deploy` creates the database when it is absent, so the only
 * step that needs an admin connection is the drop.
 */
export async function setUpDatabase(baseEnv: Record<string, string>): Promise<DatabaseSetupResult> {
  const baseDatabaseUrl = baseEnv['DATABASE_URL'];
  if (baseDatabaseUrl === undefined || baseDatabaseUrl === '') {
    throw new Error('DATABASE_URL is missing from .env.example — cannot derive the E2E database.');
  }

  const databaseUrl = e2eDatabaseUrl(baseDatabaseUrl);
  const reset = process.env['E2E_RESET_DATABASE'] !== 'false';

  if (reset) {
    await dropDatabase(baseDatabaseUrl);
  }

  const migrated: string[] = [];
  const seeded: string[] = [];
  for (const service of FLEET) {
    if (service.ownsSchema === null) {
      continue;
    }
    await migrateService(service, databaseUrl);
    migrated.push(service.dir);

    const seedScript = SEED_SCRIPTS[service.dir];
    if (seedScript !== undefined) {
      await seedService(service, seedScript, databaseUrl);
      seeded.push(`${service.dir}:${seedScript}`);
    }
  }

  return { databaseUrl, reset, migrated, seeded };
}

/**
 * `DROP DATABASE IF EXISTS` against the maintenance database.
 *
 * The URL is handed to Prisma through `DATABASE_URL` rather than `--url` so no
 * shell metacharacter from the connection string reaches a command line; the
 * `--schema` flag then tells Prisma which datasource block to read it into.
 */
async function dropDatabase(baseDatabaseUrl: string): Promise<void> {
  // Any schema-owning service's schema file works — the datasource block is
  // read only to learn the provider and the `env("DATABASE_URL")` binding.
  const anchor = FLEET.find((service) => service.ownsSchema !== null);
  if (anchor === undefined) {
    throw new Error('No schema-owning service in FLEET — nothing can be migrated.');
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const sqlPath = resolve(TMP_DIR, 'drop-e2e-database.sql');
  writeFileSync(sqlPath, `DROP DATABASE IF EXISTS "${E2E_DATABASE_NAME}";\n`, 'utf8');

  try {
    await runOrThrow(
      'pnpm',
      ['exec', 'prisma', 'db', 'execute', '--schema', 'prisma/schema.prisma', '--file', sqlPath],
      {
        cwd: serviceDir(anchor),
        env: { ...process.env, DATABASE_URL: adminDatabaseUrl(baseDatabaseUrl) },
        timeoutMs: 60_000,
      },
    );
  } finally {
    rmSync(sqlPath, { force: true });
  }
}

async function migrateService(service: FleetService, databaseUrl: string): Promise<void> {
  await runOrThrow('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: serviceDir(service),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeoutMs: 180_000,
  });
}

/**
 * Run one of a service's own seed scripts against the E2E database.
 *
 * The scripts are compiled entry points (`node dist/scripts/…`), so this needs
 * the service to have been built — which `turbo.json`'s `test:e2e` already
 * guarantees via `dependsOn: ["^build"]` (TS-503). `.env.example` is passed
 * through because the scripts call the service's own `loadEnv()` and will
 * refuse to start on a partial environment.
 */
async function seedService(
  service: FleetService,
  script: string,
  databaseUrl: string,
): Promise<void> {
  await runOrThrow('pnpm', ['run', script], {
    cwd: serviceDir(service),
    env: {
      ...process.env,
      ...loadRepoEnvExample(),
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
    },
    timeoutMs: 120_000,
  });
}
