import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every Prisma migration directory name must be unique **across the whole
 * repo**, not merely within its own service (TS-505d2).
 *
 * **This is not tidiness. It is a silent data-loss bug.** Phase 1 puts every
 * bounded context in one Postgres database with a schema each (see any
 * service's `datasource db { schemas = [...] }` and `OUTBOX_SOURCES` in
 * `.env.example`, which names outbox tables as `schema.table` across services
 * on one connection). Prisma records applied migrations in a single
 * `_prisma_migrations` table in that database, **keyed by directory name and
 * nothing else** — not by schema, not by service, not by checksum-plus-schema.
 *
 * So when five services each shipped a migration called
 * `20260608120000_outbox_events`, the first `prisma migrate deploy` to run
 * recorded the name and **the other four were skipped as already applied.**
 * `prisma migrate status` then reports "Database schema is up to date!" for
 * every one of them, because from its point of view they are. The tables were
 * simply never created:
 *
 *   - `search.outbox_events` — and `search-click.emitter.ts` appends to it on
 *     every recorded click, so `POST /api/v1/search/clicks` was a 500.
 *   - `accounting.outbox_events`, `household.outbox_events`,
 *     `webhook.outbox_events` — no live producer yet, but the relay logs a
 *     `relation does not exist` error for each on every poll cycle.
 *
 * Found when `worker-outbox-relay` was first run against a real fleet: no
 * suite on the platform could see it, because every service migrates its own
 * throwaway database in isolation, where the names cannot collide.
 *
 * **Why a name check and not a schema check.** Prisma's ledger has no notion
 * of which schema a migration touched, so a uniqueness rule on the name is the
 * only thing that maps onto how the collision actually happens. Prefixing the
 * service name is the convention this enforces in effect: `20260608120300_
 * search_outbox_events` cannot collide with anybody.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');
const WORKERS_DIR = path.join(APPS_DIR, 'workers');

interface Migration {
  readonly name: string;
  readonly owner: string;
}

function migrationsIn(workspaceDir: string, owner: string): Migration[] {
  const dir = path.join(workspaceDir, 'prisma', 'migrations');
  if (!isDirectory(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => isDirectory(path.join(dir, entry)))
    .map((name) => ({ name, owner }));
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function allMigrations(): Migration[] {
  const out: Migration[] = [];

  for (const entry of readdirSync(APPS_DIR)) {
    if (entry === 'workers') continue;
    const workspace = path.join(APPS_DIR, entry);
    if (!isDirectory(workspace)) continue;
    out.push(...migrationsIn(workspace, entry));
  }

  // `apps/workers/*` is swept too. No worker owns a schema today, but that
  // path has been missed by enough repo-wide sweeps (see `service-ports.test.ts`)
  // that leaving it out would be the same mistake a fourth time.
  if (isDirectory(WORKERS_DIR)) {
    for (const entry of readdirSync(WORKERS_DIR)) {
      const workspace = path.join(WORKERS_DIR, entry);
      if (!isDirectory(workspace)) continue;
      out.push(...migrationsIn(workspace, `workers/${entry}`));
    }
  }

  return out;
}

describe('prisma migration names', () => {
  const migrations = allMigrations();

  /**
   * The same "did the walk break?" assertion `service-ports.test.ts` carries.
   * Without it, a rename of `prisma/migrations` or a change to the layout
   * turns "no collisions" into "no data" and the guard passes forever.
   */
  it('discovers the repo’s migrations', () => {
    expect(migrations.length).toBeGreaterThan(100);
    expect(new Set(migrations.map((m) => m.owner)).size).toBeGreaterThan(10);
  });

  it('are unique across every service, because one database shares one ledger', () => {
    const byName = new Map<string, string[]>();
    for (const migration of migrations) {
      const owners = byName.get(migration.name) ?? [];
      owners.push(migration.owner);
      byName.set(migration.name, owners);
    }

    const collisions = [...byName.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([name, owners]) => `${name} → ${owners.sort().join(', ')}`);

    expect(
      collisions,
      'Prisma keys `_prisma_migrations` by directory name alone. With one ' +
        'database per environment, only the first of these will ever be ' +
        'applied and the rest are skipped in silence — `prisma migrate status` ' +
        'reports "up to date" for all of them. Rename all but one, prefixing ' +
        'the owning service.',
    ).toEqual([]);
  });
});
