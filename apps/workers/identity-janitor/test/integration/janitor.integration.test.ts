/**
 * TS-022-followup-3b — identity-janitor integration test against a real
 * Postgres via Testcontainers.
 *
 * The unit suite (`src/janitor/prune.repository.test.ts`) drives the
 * batch loop against a `FakeExecutor` that replays a queued list of
 * per-batch delete counts — it proves the loop's control flow but never
 * touches a database, so it cannot catch:
 *
 *   - A malformed `buildDeleteSql` string (a typo'd keyword, a wrong
 *     placeholder, an unquoted identifier) — the fake never parses the
 *     SQL, so any string at all "passes".
 *   - The retention threshold semantics — `expires_at < now() -
 *     make_interval(days => $1::int)` is the load-bearing predicate, and
 *     the fake's return values are hand-authored counts, not the result
 *     of evaluating that predicate against real rows.
 *   - The PK-subselect `LIMIT $2` actually bounding each `DELETE` to
 *     `batchSize` rows against a real backlog.
 *   - `result.rowCount` plumbing through `PgPruneExecutor` against the
 *     real `pg` driver.
 *
 * This suite boots an ephemeral Postgres-16 container, creates the two
 * `identity`-schema tables the janitor sweeps, seeds rows straddling the
 * retention window, and runs the REAL `PgPruneExecutor` + `PruneRepository`
 * + `JanitorWorkerService` against them — asserting only retention-aged
 * rows are deleted, the batch loop drains a >batch backlog, and the
 * per-sweep cap defers the remainder.
 *
 * **Why create the two tables directly rather than apply service-identity's
 * Prisma migrations.** The janitor connects with raw `pg` and only ever
 * references the `id` + `expires_at` columns (CLAUDE.md §2.3 — it never
 * imports service-identity's Prisma client). Applying service-identity's
 * migration set here would couple this worker's test to another service's
 * full schema through the test surface — exactly the cross-service coupling
 * §2.3 forbids. The acceptance criterion explicitly allows "just creates the
 * two tables", so the DDL below is a minimal-but-faithful projection: the
 * same schema/table/column names + the same `expires_at` index the real
 * migration ships, which is everything the prune SQL reads.
 *
 * **Why not the shared `startIntegrationTestStack`.** That harness also
 * boots Redis and runs `prisma migrate deploy`; the janitor needs neither.
 * `startPostgresContainer` is the right lower-level primitive.
 *
 * References: PDD §24.1; CLAUDE.md §9.1, §2.3, §4.1; TS-009e-followup-1
 * harness; `apps/workers/identity-janitor/src/janitor/prune.repository.ts`.
 */

import 'reflect-metadata';

import { startPostgresContainer, type StartedPostgresContainer } from '@taste-and-see/testing';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { JanitorWorkerService } from '../../src/janitor/janitor-worker.service';
import { buildPruneTargets } from '../../src/janitor/prune-targets';
import { PgPruneExecutor, PruneRepository } from '../../src/janitor/prune.repository';
import type { PruneTarget } from '../../src/janitor/prune-targets';

let postgres: StartedPostgresContainer;
let pool: Pool;

/**
 * The two tables the janitor sweeps. Only `id` (text PK) + `expires_at`
 * (timestamptz) + the `expires_at` index are needed — the prune SQL
 * reads nothing else. The names mirror the real `identity` migration so
 * `buildPruneTargets` resolves the same schema/table/column constants.
 */
const TABLES = ['refresh_tokens', 'mfa_challenges'] as const;
type IdentityTable = (typeof TABLES)[number];

beforeAll(async () => {
  postgres = await startPostgresContainer({ database: 'identity_janitor_test' });
  pool = new Pool({ connectionString: postgres.databaseUrl });

  await pool.query('CREATE SCHEMA IF NOT EXISTS identity');
  await pool.query(`
    CREATE TABLE identity.refresh_tokens (
      id text PRIMARY KEY,
      expires_at timestamptz NOT NULL
    )
  `);
  await pool.query(
    'CREATE INDEX refresh_tokens_expires_at_idx ON identity.refresh_tokens (expires_at)',
  );
  await pool.query(`
    CREATE TABLE identity.mfa_challenges (
      id text PRIMARY KEY,
      expires_at timestamptz NOT NULL
    )
  `);
  await pool.query(
    'CREATE INDEX mfa_challenges_expires_at_idx ON identity.mfa_challenges (expires_at)',
  );
});

afterEach(async () => {
  // Each test seeds fresh rows; truncate between tests so they stay
  // independent regardless of execution order.
  await pool.query('TRUNCATE identity.refresh_tokens, identity.mfa_challenges');
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  if (postgres) {
    await postgres.container.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert one row whose `expires_at` is `daysFromNow` days from the
 * statement's transaction time. Negative = in the past. The table name
 * comes from the {@link IdentityTable} union (compile-time constant set),
 * so the interpolation carries no injection surface.
 */
async function seedRow(table: IdentityTable, id: string, daysFromNow: number): Promise<void> {
  await pool.query(
    `INSERT INTO identity.${table} (id, expires_at)
     VALUES ($1, now() + make_interval(days => $2::int))`,
    [id, daysFromNow],
  );
}

/** Bulk-insert `count` rows, all expired `daysAgo` days in the past. */
async function seedExpiredBatch(
  table: IdentityTable,
  prefix: string,
  count: number,
  daysAgo: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO identity.${table} (id, expires_at)
     SELECT $1 || g, now() - make_interval(days => $2::int)
     FROM generate_series(1, $3) AS g`,
    [prefix, daysAgo, count],
  );
}

async function remainingIds(table: IdentityTable): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM identity.${table} ORDER BY expires_at ASC`,
  );
  return rows.map((r) => r.id);
}

async function rowCount(table: IdentityTable): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM identity.${table}`,
  );
  return Number(rows[0]?.n ?? '0');
}

/** A target for the given table with an overridable retention + enabled flag. */
function targetFor(table: IdentityTable, retentionDays: number, enabled = true): PruneTarget {
  return {
    key: table,
    schema: 'identity',
    table,
    expiresAtColumn: 'expires_at',
    retentionDays,
    enabled,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('identity-janitor integration (TS-022-followup-3b)', () => {
  describe('retention-window straddle against the real driver', () => {
    it('deletes only refresh_tokens rows older than the retention window', async () => {
      await seedRow('refresh_tokens', 'tok_old_40d', -40); // eligible
      await seedRow('refresh_tokens', 'tok_old_31d', -31); // eligible (just past 30d)
      await seedRow('refresh_tokens', 'tok_recent_20d', -20); // expired but within retention — keep
      await seedRow('refresh_tokens', 'tok_future_5d', 5); // not expired — keep

      const repo = new PruneRepository(new PgPruneExecutor(pool), 5_000, 1_000);
      const result = await repo.prune(targetFor('refresh_tokens', 30));

      expect(result).toEqual({
        key: 'refresh_tokens',
        deleted: 2,
        batches: 1,
        cappedOut: false,
      });
      // Survivors ordered by expires_at ASC: the -20d row, then the +5d row.
      expect(await remainingIds('refresh_tokens')).toEqual(['tok_recent_20d', 'tok_future_5d']);
    });

    it('deletes only mfa_challenges rows older than the retention window', async () => {
      await seedRow('mfa_challenges', 'mfa_old_45d', -45); // eligible
      await seedRow('mfa_challenges', 'mfa_recent_10d', -10); // within retention — keep

      const repo = new PruneRepository(new PgPruneExecutor(pool), 5_000, 1_000);
      const result = await repo.prune(targetFor('mfa_challenges', 30));

      expect(result.deleted).toBe(1);
      expect(result.cappedOut).toBe(false);
      expect(await remainingIds('mfa_challenges')).toEqual(['mfa_recent_10d']);
    });

    it('with retentionDays=0 deletes a just-expired row but keeps a future one', async () => {
      await seedRow('refresh_tokens', 'tok_expired_1d', -1); // already expired
      await seedRow('refresh_tokens', 'tok_future_1d', 1); // not yet expired

      const repo = new PruneRepository(new PgPruneExecutor(pool), 5_000, 1_000);
      const result = await repo.prune(targetFor('refresh_tokens', 0));

      expect(result.deleted).toBe(1);
      expect(await remainingIds('refresh_tokens')).toEqual(['tok_future_1d']);
    });
  });

  describe('batch loop against a real backlog', () => {
    it('drains a backlog larger than the batch size across multiple bounded DELETEs', async () => {
      // 25 eligible rows, batch size 10 → 10 + 10 + 5 = three batches,
      // the short final batch ends the loop.
      await seedExpiredBatch('refresh_tokens', 'tok_eligible_', 25, 40);

      const repo = new PruneRepository(new PgPruneExecutor(pool), 10, 1_000);
      const result = await repo.prune(targetFor('refresh_tokens', 30));

      expect(result).toEqual({
        key: 'refresh_tokens',
        deleted: 25,
        batches: 3,
        cappedOut: false,
      });
      expect(await rowCount('refresh_tokens')).toBe(0);
    });

    it('defers the remainder when the per-sweep batch cap is hit', async () => {
      // 25 eligible rows, batch size 10, cap 2 → 10 + 10 deleted, the
      // remaining 5 are deferred to the next sweep.
      await seedExpiredBatch('refresh_tokens', 'tok_eligible_', 25, 40);

      const repo = new PruneRepository(new PgPruneExecutor(pool), 10, 2);
      const result = await repo.prune(targetFor('refresh_tokens', 30));

      expect(result).toEqual({
        key: 'refresh_tokens',
        deleted: 20,
        batches: 2,
        cappedOut: true,
      });
      // The cap stopped the loop; the backlog tail survives this sweep.
      expect(await rowCount('refresh_tokens')).toBe(5);
    });
  });

  describe('JanitorWorkerService.sweepOnce across both targets', () => {
    it('prunes enabled targets and skips disabled ones, end-to-end via buildPruneTargets', async () => {
      // refresh_tokens: 3 eligible + 1 within-retention survivor.
      await seedExpiredBatch('refresh_tokens', 'tok_eligible_', 3, 40);
      await seedRow('refresh_tokens', 'tok_recent', -5);
      // mfa_challenges: 4 eligible — but the target is disabled this
      // sweep, so none should be touched.
      await seedExpiredBatch('mfa_challenges', 'mfa_eligible_', 4, 40);

      // Build the targets the way the worker does at boot, from a real
      // env — with the mfa target's per-table enable flag flipped off so
      // the `skipped` branch is exercised against the real DB.
      const env = loadEnv({
        DATABASE_URL: postgres.databaseUrl,
        MFA_CHALLENGE_PRUNE_ENABLED: 'false',
      });
      const targets = buildPruneTargets(env);

      const repo = new PruneRepository(new PgPruneExecutor(pool), 5_000, 1_000);
      const worker = new JanitorWorkerService(repo, targets);

      const results = await worker.sweepOnce();

      const refresh = results.find((r) => r.key === 'refresh_tokens');
      const mfa = results.find((r) => r.key === 'mfa_challenges');

      expect(refresh).toMatchObject({ skipped: false, deleted: 3, cappedOut: false });
      expect(refresh?.error).toBeUndefined();
      expect(mfa).toMatchObject({ skipped: true, deleted: 0, batches: 0 });

      // refresh_tokens: only the within-retention survivor remains.
      expect(await remainingIds('refresh_tokens')).toEqual(['tok_recent']);
      // mfa_challenges: untouched because the target was disabled.
      expect(await rowCount('mfa_challenges')).toBe(4);
    });
  });
});
