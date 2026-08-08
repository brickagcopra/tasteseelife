/**
 * TS-211-followup-5 — service-search ranking-config integration.
 *
 * Boots the real `AppModule` against an ephemeral Postgres + Redis pair
 * (via the shared `@taste-and-see/testing` harness) and exercises the
 * full ranking-config CRUD lifecycle:
 *
 *   1. **Migration-seeded `global` row.** `prisma migrate deploy`
 *      applies `20260521150000_init_search_ranking_config` which
 *      `INSERT … ON CONFLICT DO NOTHING`s the canonical `global` row
 *      with TS-211 spec defaults (Elite ×1.5, Certified ×1.2, Basic
 *      ×1.0). Without an integration test, a regression that dropped
 *      the seed `INSERT` from the migration would only surface in
 *      staging when the resolver's `global` fallback returned env
 *      defaults instead of the row's stored weights — visually
 *      identical until ops mutates the row.
 *
 *   2. **CRUD lifecycle over HTTP.** list → get global → upsert NYC
 *      (created) → list shows both → upsert NYC replay (unchanged) →
 *      upsert NYC with new weights (updated) → delete NYC → list
 *      returns global only → delete NYC again (not_found → 404) →
 *      delete global (global_protected → 422). Proves the
 *      `InternalSharedSecretGuard` accepts the canonical header, the
 *      Prisma round-trip honours the model's `@@unique` + `@updatedAt`
 *      semantics against real Postgres, and the response shapes match
 *      the contract package's `.strict()` schemas.
 *
 *   3. **`RankingConfigService.resolveWeights` resolution.** Per-region
 *      override returns the region's weights; an unknown region falls
 *      back to `global`. Hits the live cache layer (30s TTL) so a
 *      subsequent invalidate-on-mutation read picks up the fresh row.
 *
 * **Load-bearing properties this test pins** (regressions invisible to
 * the unit suite):
 *
 *   - The migration's `INSERT … ON CONFLICT DO NOTHING` actually runs
 *     and lands the `global` row. The unit tests against `FakePrisma`
 *     start with an empty in-memory store; only an integration test can
 *     catch a regression that lost the seed SQL.
 *   - `tier_weight_*` columns are `DOUBLE PRECISION` not money — a
 *     refactor that incorrectly switched to `Decimal(12,2)` would
 *     pass type-check but silently change the resolver's float identity
 *     (1.5 → "1.50" string) in ways that break `===` equality on the
 *     cached path.
 *   - The `@unique` on `region_code` enforces the upsert path's natural
 *     key against real Postgres `UNIQUE` enforcement. A second
 *     `searchRankingConfig.create({ data: { regionCode: 'global', … } })`
 *     would throw `P2002` — the service correctly routes through
 *     `findUnique` → `update` rather than a second `create`.
 *   - `updatedAt` semantics — Prisma's `@updatedAt` bumps on every
 *     `update()` call; the service's "unchanged" short-circuit
 *     deliberately skips `update()` when the body matches the stored
 *     row, so a replay PUT returns the SAME `updatedAt` as the first
 *     write. A regression that dropped the short-circuit would surface
 *     here as a drifting `updatedAt`.
 *
 * Why the real AppModule, not a hand-rolled test module? The unit tests
 * already cover every service method + controller branch in isolation
 * (against `FakePrisma` + a mock store). The integration gap is
 * wire-level: Prisma's real `Float` round-trip, Postgres' real `UNIQUE`
 * enforcement, the env-validated AppModule boot path, the
 * `InternalSharedSecretGuard` against real header parsing, and the
 * `RfcProblemFilter`-shaped error responses. Those only fail when every
 * layer is present.
 *
 * Why not supertest? The library is not on CLAUDE.md §13 approved list.
 * Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')` cover the
 * same surface and avoid another dependency.
 *
 * References: PDD §24.1; CLAUDE.md §3.5, §3.7, §4.1, §9.1; TS-009e-followup-1a
 * canonical pattern in `apps/service-subscription/test/integration/plans.integration.test.ts`;
 * TS-211 in `apps/service-search/src/modules/ranking-config/`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import {
  SEARCH_RANKING_REGION_CODE_GLOBAL,
  type DeleteSearchRankingConfigResponse,
  type GetSearchRankingConfigResponse,
  type ListSearchRankingConfigResponse,
  type UpsertSearchRankingConfigResponse,
} from '@taste-and-see/contracts';
import { startIntegrationTestStack, type IntegrationTestStack } from '@taste-and-see/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');

let stack: IntegrationTestStack;
let app: INestApplication;
let baseUrl: string;

/**
 * Direct Prisma handle used only by the test harness — for cross-checks
 * (row counts after a reseed, env-fallback assertion via row deletion).
 * The handle is a separate process-local client with no DI overlap with
 * the AppModule's `PrismaService` running inside Nest.
 */
let harnessPrisma: PrismaService;

/**
 * Shared-secret value the test harness pins on every internal endpoint.
 * Generated fresh per run; `min(32)` clears the env schema's floor.
 */
const INTERNAL_API_KEY = randomBytes(32).toString('base64url');

beforeAll(async () => {
  stack = await startIntegrationTestStack({
    serviceRoot: SERVICE_ROOT,
    database: 'search_test',
  });

  // ── Env wiring ────────────────────────────────────────────────────
  //
  // `app.module.ts` evaluates `const moduleEnv = loadEnv()` at the top
  // of the file — i.e. as soon as the module is first imported. Every
  // required env var MUST be set BEFORE the AppModule import resolves;
  // the dynamic `await import('../../src/app.module')` below is what
  // triggers that evaluation.
  //
  // All secrets are freshly generated per run — no test fixture file,
  // no hard-coded keys. CLAUDE.md §17.12 forbids committing secrets,
  // and the schema's `min(32)` floor would reject placeholder values
  // anyway.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = stack.databaseUrl;
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64');
  process.env.SEARCH_INDEX_API_KEY = INTERNAL_API_KEY;
  // TS-506-followup-3b — this fixture is a copy of the app's env contract that
  // nothing covered, and it had fallen behind the schema. The suite was dying
  // inside `loadEnv` before its first assertion, and because the integration
  // lane is not part of `turbo run test` nothing said so.
  // `packages/testing/src/boot/integration-fixture-env.test.ts` now guards it.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  // SEARCH_INDEX_HEADER_NAME defaults to `x-internal-api-key` — leave
  // unset so the env-default surfaces alongside the secret.

  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  // `['error']`, not `false` (TS-305d-followup-2b). A silenced Nest turns a
  // boot-time or DI failure into a bare status-code mismatch; this suite's 14
  // failures were all one swallowed TypeError.
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.useGlobalFilters(new RfcProblemFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  harnessPrisma = new PrismaService({ datasourceUrl: stack.databaseUrl });
  await harnessPrisma.onModuleInit();
});

afterAll(async () => {
  if (harnessPrisma) {
    await harnessPrisma.onModuleDestroy();
  }
  if (app) {
    await app.close();
  }
  if (stack) {
    await stack.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function callJson(
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  init: { body?: unknown; secret?: string | null } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
  }
  // `null` means "deliberately omit the header"; `undefined` falls back
  // to the canonical secret. Tests that exercise the unauthorised path
  // pass `null` explicitly.
  if (init.secret !== null) {
    headers['x-internal-api-key'] = init.secret ?? INTERNAL_API_KEY;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const raw = await response.text();
  let body: unknown = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { status: response.status, body };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('service-search ranking-config integration (TS-211-followup-5)', () => {
  describe('initial migration seeds the global row', () => {
    it('list returns exactly the global row after migrate-deploy', async () => {
      const res = await callJson('GET', '/api/v1/internal/search/ranking-config');
      expect(res.status).toBe(200);
      const list = res.body as ListSearchRankingConfigResponse;
      expect(list.configs).toHaveLength(1);
      const row = list.configs[0];
      expect(row).toBeDefined();
      // Defensive narrowing — TypeScript still sees row as possibly
      // undefined under noUncheckedIndexedAccess.
      if (row === undefined) throw new Error('expected one config row');
      expect(row.regionCode).toBe(SEARCH_RANKING_REGION_CODE_GLOBAL);
      // TS-211 spec defaults pinned by the migration's INSERT statement.
      // A regression that flipped the order (Basic ×1.5 / Elite ×1.0)
      // would pass type-check but silently make every Basic-tier provider
      // outrank an Elite one — invisible to the unit suite.
      expect(row.tierWeightBasic).toBe(1.0);
      expect(row.tierWeightCertified).toBe(1.2);
      expect(row.tierWeightElite).toBe(1.5);
      // Seeded rows carry no attributing user (the migration is system-
      // owned, not actor-owned).
      expect(row.updatedByUserId).toBeNull();
      // ISO-8601 timestamps with offset — the contract requires
      // `.datetime({ offset: true })` so a Date-toString leak would
      // surface here.
      expect(() => new Date(row.createdAt).toISOString()).not.toThrow();
      expect(() => new Date(row.updatedAt).toISOString()).not.toThrow();
    });

    it('get global returns the seeded row wrapped in the "found" discriminant', async () => {
      const res = await callJson(
        'GET',
        `/api/v1/internal/search/ranking-config/${SEARCH_RANKING_REGION_CODE_GLOBAL}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as GetSearchRankingConfigResponse;
      expect(body.kind).toBe('found');
      if (body.kind !== 'found') throw new Error('expected found discriminant');
      expect(body.config.regionCode).toBe(SEARCH_RANKING_REGION_CODE_GLOBAL);
      expect(body.config.tierWeightBasic).toBe(1.0);
      expect(body.config.tierWeightCertified).toBe(1.2);
      expect(body.config.tierWeightElite).toBe(1.5);
    });

    it('get unknown region returns the "not_found" discriminant (200, not 404)', async () => {
      // The contract surfaces a missing per-region row as a discriminated
      // union, NOT a 404 — the BFF (TS-211-followup-1) maps it to 404
      // for the browser. Pinning the 200 + `not_found` shape here
      // prevents an over-eager refactor from short-circuiting to a 404
      // at this layer and breaking the BFF's "row may legitimately not
      // exist" framing.
      const res = await callJson('GET', '/api/v1/internal/search/ranking-config/unknown_region');
      expect(res.status).toBe(200);
      const body = res.body as GetSearchRankingConfigResponse;
      expect(body.kind).toBe('not_found');
      if (body.kind !== 'not_found') throw new Error('expected not_found discriminant');
      expect(body.regionCode).toBe('unknown_region');
    });

    it('rejects internal endpoints without the shared secret', async () => {
      const res = await callJson('GET', '/api/v1/internal/search/ranking-config', {
        secret: null,
      });
      expect(res.status).toBe(401);
      // Generic "Internal authentication required" body — no oracle
      // about which secret is configured.
      expect(res.body).toMatchObject({ status: 401, title: 'Unauthorized' });
    });
  });

  describe('CRUD lifecycle over HTTP', () => {
    it('upsert nyc creates a new row (outcome=created)', async () => {
      const res = await callJson('PUT', '/api/v1/internal/search/ranking-config/nyc', {
        body: {
          description: 'NYC five-borough override',
          tierWeightBasic: 0.9,
          tierWeightCertified: 1.3,
          tierWeightElite: 1.8,
        },
      });
      expect(res.status).toBe(200);
      const body = res.body as UpsertSearchRankingConfigResponse;
      expect(body.outcome).toBe('created');
      expect(body.config.regionCode).toBe('nyc');
      expect(body.config.tierWeightBasic).toBe(0.9);
      expect(body.config.tierWeightCertified).toBe(1.3);
      expect(body.config.tierWeightElite).toBe(1.8);
      expect(body.config.description).toBe('NYC five-borough override');
      // Direct callers (curl, this test) don't carry an attributing
      // user id — the value lands as null per the contract.
      expect(body.config.updatedByUserId).toBeNull();
    });

    it('list returns both rows after the upsert', async () => {
      const res = await callJson('GET', '/api/v1/internal/search/ranking-config');
      expect(res.status).toBe(200);
      const list = res.body as ListSearchRankingConfigResponse;
      expect(list.configs).toHaveLength(2);
      // The service orders by regionCode ASC — `global` comes before
      // `nyc` alphabetically. Pin the order so a refactor that swapped
      // to descending doesn't silently flip the dashboard layout.
      expect(list.configs.map((c) => c.regionCode)).toEqual([
        SEARCH_RANKING_REGION_CODE_GLOBAL,
        'nyc',
      ]);
    });

    it('upsert nyc with same body replays unchanged + preserves updatedAt', async () => {
      // First, read the current `updatedAt` so the replay's
      // preservation assertion has a baseline.
      const before = await callJson('GET', '/api/v1/internal/search/ranking-config/nyc');
      const beforeBody = before.body as GetSearchRankingConfigResponse;
      if (beforeBody.kind !== 'found') throw new Error('expected found pre-replay');
      const previousUpdatedAt = beforeBody.config.updatedAt;

      const res = await callJson('PUT', '/api/v1/internal/search/ranking-config/nyc', {
        body: {
          description: 'NYC five-borough override',
          tierWeightBasic: 0.9,
          tierWeightCertified: 1.3,
          tierWeightElite: 1.8,
        },
      });
      expect(res.status).toBe(200);
      const body = res.body as UpsertSearchRankingConfigResponse;
      expect(body.outcome).toBe('unchanged');
      // The load-bearing invariant: byte-equal replay does NOT bump
      // updatedAt. The unit test covers this against FakePrisma; this
      // assertion catches a regression that dropped the short-circuit
      // in favour of an unconditional `update()` (which Prisma's
      // `@updatedAt` would honour).
      expect(body.config.updatedAt).toBe(previousUpdatedAt);
    });

    it('upsert nyc with new weights returns outcome=updated + bumps updatedAt', async () => {
      const before = await callJson('GET', '/api/v1/internal/search/ranking-config/nyc');
      const beforeBody = before.body as GetSearchRankingConfigResponse;
      if (beforeBody.kind !== 'found') throw new Error('expected found pre-update');
      const previousUpdatedAt = beforeBody.config.updatedAt;

      // Move the Elite weight from 1.8 to 2.0 — a strictly-real change.
      const res = await callJson('PUT', '/api/v1/internal/search/ranking-config/nyc', {
        body: {
          description: 'NYC five-borough override',
          tierWeightBasic: 0.9,
          tierWeightCertified: 1.3,
          tierWeightElite: 2.0,
        },
      });
      expect(res.status).toBe(200);
      const body = res.body as UpsertSearchRankingConfigResponse;
      expect(body.outcome).toBe('updated');
      expect(body.config.tierWeightElite).toBe(2.0);
      // updatedAt strictly later than the pre-update snapshot. Equality
      // would imply the same physical row at the same `@updatedAt`
      // instant — possible only if the short-circuit fired, which
      // contradicts `outcome: 'updated'`.
      expect(new Date(body.config.updatedAt).getTime()).toBeGreaterThan(
        new Date(previousUpdatedAt).getTime(),
      );
    });

    it('rejects an upsert whose body violates the tier-weight bounds', async () => {
      // `SEARCH_RANKING_TIER_WEIGHT_MAX` is 10; supplying 100 fails the
      // contract. The `RfcProblemFilter` shapes the response as RFC 7807.
      const res = await callJson('PUT', '/api/v1/internal/search/ranking-config/nyc', {
        body: {
          tierWeightBasic: 100,
          tierWeightCertified: 1.3,
          tierWeightElite: 1.8,
        },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 400 });
    });

    it('delete unknown region returns 404', async () => {
      const res = await callJson('DELETE', '/api/v1/internal/search/ranking-config/bay_area');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
    });

    it('delete global is rejected with 422 + global_protected detail', async () => {
      const res = await callJson(
        'DELETE',
        `/api/v1/internal/search/ranking-config/${SEARCH_RANKING_REGION_CODE_GLOBAL}`,
      );
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ status: 422, title: 'Unprocessable Entity' });
      // The detail line names the rationale ("load-bearing fallback")
      // so ops sees WHY the row is special, not just THAT it's special.
      const body = res.body as { detail?: string };
      expect(typeof body.detail).toBe('string');
      expect(body.detail).toContain(SEARCH_RANKING_REGION_CODE_GLOBAL);
    });

    it('delete nyc removes the row', async () => {
      const res = await callJson('DELETE', '/api/v1/internal/search/ranking-config/nyc');
      expect(res.status).toBe(200);
      const body = res.body as DeleteSearchRankingConfigResponse;
      expect(body.outcome).toBe('deleted');
      expect(body.regionCode).toBe('nyc');
    });

    it('list returns only the global row after the delete', async () => {
      const res = await callJson('GET', '/api/v1/internal/search/ranking-config');
      expect(res.status).toBe(200);
      const list = res.body as ListSearchRankingConfigResponse;
      expect(list.configs).toHaveLength(1);
      expect(list.configs[0]?.regionCode).toBe(SEARCH_RANKING_REGION_CODE_GLOBAL);
    });

    it('delete nyc a second time returns 404', async () => {
      const res = await callJson('DELETE', '/api/v1/internal/search/ranking-config/nyc');
      expect(res.status).toBe(404);
    });
  });

  describe('RankingConfigService.resolveWeights', () => {
    it('per-region override returns the region weights when present', async () => {
      // Re-seat the NYC row so the resolver has a non-fallback row to
      // hit. The previous describe block deleted it; resurrect here so
      // this block is independent of the order it runs in.
      const upsert = await callJson('PUT', '/api/v1/internal/search/ranking-config/nyc', {
        body: {
          tierWeightBasic: 0.8,
          tierWeightCertified: 1.4,
          tierWeightElite: 2.2,
        },
      });
      expect(upsert.status).toBe(200);

      const { RankingConfigService } = await import(
        '../../src/modules/ranking-config/services/ranking-config.service'
      );
      const service = app.get(RankingConfigService);
      // Drop any cached entry from a previous describe block so the
      // read goes through the persistence layer.
      service.resetCacheForTesting();

      const resolved = await service.resolveWeights('nyc');
      expect(resolved.basic).toBe(0.8);
      expect(resolved.certified).toBe(1.4);
      expect(resolved.elite).toBe(2.2);
      expect(resolved.source).toBe('region');
      expect(resolved.regionCode).toBe('nyc');
    });

    it('unknown region falls back to global', async () => {
      const { RankingConfigService } = await import(
        '../../src/modules/ranking-config/services/ranking-config.service'
      );
      const service = app.get(RankingConfigService);
      service.resetCacheForTesting();

      const resolved = await service.resolveWeights('bay_area');
      // Global row's TS-211 spec defaults.
      expect(resolved.basic).toBe(1.0);
      expect(resolved.certified).toBe(1.2);
      expect(resolved.elite).toBe(1.5);
      expect(resolved.source).toBe('global');
      // The resolved row IS the global row even though the caller asked
      // for `bay_area` — the `regionCode` field reports the source-of-
      // weights, not the request.
      expect(resolved.regionCode).toBe(SEARCH_RANKING_REGION_CODE_GLOBAL);
    });

    it('falls back to env defaults when the global row is missing', async () => {
      // The service refuses to DELETE the `global` row via the HTTP
      // surface (the load-bearing fallback rule). The env-fallback
      // branch only runs when both rows are physically absent — which
      // is what happens during a fresh boot before the migration runs,
      // or in a hypothetical disaster-recovery state. Reach around the
      // service-layer guard and delete every row directly through the
      // harness handle so the resolver hits the env path.
      await harnessPrisma.searchRankingConfig.deleteMany({});

      const { RankingConfigService } = await import(
        '../../src/modules/ranking-config/services/ranking-config.service'
      );
      const service = app.get(RankingConfigService);
      service.resetCacheForTesting();

      const resolved = await service.resolveWeights('global');
      // Env defaults match the seeded global row's values (TS-211 spec):
      // Basic 1.0 / Certified 1.2 / Elite 1.5. The shape we pin here is
      // the `source: 'env'` discriminant — defends against a regression
      // that fell back to global silently without recording the source.
      expect(resolved.source).toBe('env');
      expect(resolved.basic).toBe(1.0);
      expect(resolved.certified).toBe(1.2);
      expect(resolved.elite).toBe(1.5);
    });
  });
});
