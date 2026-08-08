/**
 * TS-270-followup-2 — service-ads skeleton boot + /healthz + /readyz +
 * `ad_campaigns` round-trip + in-schema FK cascade integration.
 *
 * Boots the production `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the health surface + the hand-written migration
 * set end-to-end:
 *
 *   1. Apply the service's full Prisma migration set against the ephemeral
 *      DB (`prisma migrate deploy` — the same execution path production
 *      deployment uses), which lands the three hand-authored migrations:
 *      `20260612160000_init` (the four core tables), `20260615120000_ad_slot_schedules`,
 *      and `20260615130000_ad_creative_reviews`.
 *   2. Boot the production AppModule (env-validated via `loadEnv()`,
 *      `NestAuthModule` + `IdempotencyModule` wired against the live Redis,
 *      `ObservabilityModule` + the tenant-scope gate wired) and bind
 *      `app.listen(0, '127.0.0.1')` to an ephemeral port.
 *   3. Hit `GET /healthz` over HTTP and assert the 200 + the `service-ads`-
 *      pinned liveness envelope.
 *   4. Hit `GET /readyz` over HTTP and assert the 200 + `checks.postgres = 'ok'`
 *      — the load-bearing assertion that the Prisma multiSchema feature works
 *      end-to-end against a live Postgres.
 *   5. Cross-check the migrate-deploy result directly via the harness Prisma
 *      client: the `ads` schema exists with its load-bearing tables, an
 *      `AdCampaign` round-trips (proving the `Decimal(12,2)` budget column,
 *      the `currency` column, the `advertiser_kind` / `ad_campaign_status`
 *      enums), and the in-schema FK cascade (`ad_creatives` /
 *      `ad_targeting_rules` rows are deleted when their parent campaign is).
 *
 * **Load-bearing properties.** Without this test, the following regressions
 * could ship to staging undetected:
 *
 *   - The Prisma multiSchema preview feature is required for `@@schema("ads")`.
 *     A regression that dropped `previewFeatures = ["multiSchema"]` from the
 *     generator block (or `schemas = ["ads"]` from the datasource) would
 *     produce a client that can't address the schema-qualified tables, and the
 *     unit tests against the fake Prisma would still pass. The `/readyz` ping +
 *     the `AdCampaign` round-trip catch that.
 *   - The three migrations' internal consistency. The unit suites never run
 *     `prisma migrate deploy`; they read from a hand-coded `FakeAdsPrisma`. A
 *     migration that referenced a missing column, a non-existent enum value, or
 *     a mis-declared FK would only surface at deploy time without an integration
 *     test. The schema-table enumeration test catches missing-table regressions;
 *     the campaign round-trip catches Decimal-column + enum-value regressions;
 *     the cascade test catches the `onDelete: Cascade` FK-declaration regression.
 *   - The `Decimal(12,2)` budget column. CLAUDE.md §4.1 forbids floats for
 *     money; the column round-trip proves a `'5000.00'` string survives the
 *     DB boundary as an exact decimal (not a lossy float).
 *   - The AppModule's module-load-time env validation (the top-of-file
 *     `const moduleEnv = loadEnv()` call in `app.module.ts`) is exercised here
 *     against a realistic env block, and the `IdempotencyModule`'s `redis-url`
 *     backend wires up against a live Redis at boot — both surface at
 *     AppModule construction time, before the first HTTP test runs.
 *
 * **Why the real AppModule, not a hand-rolled test module?** The unit tests
 * already cover the health controller in isolation (against the fake Prisma).
 * The integration gap is wire-level: Prisma's real multiSchema marshalling
 * against a live Postgres, the env-validated AppModule boot path (NestAuth +
 * Idempotency + tenant-scope + observability), and the HTTP-layer contract.
 * Those only fail when every layer is present.
 *
 * **Why not supertest?** The library is not on CLAUDE.md §13's approved list.
 * Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')` cover the same
 * surface and avoid another dependency.
 *
 * Docker is wedged on the author host ([[env_docker_desktop_hang]]); this test
 * fails locally at `GenericContainer.start` ("Could not find a working
 * container runtime strategy") but runs green in CI under the `integration-test`
 * job which provisions a real Docker engine via ubuntu-24.04.
 *
 * References: PDD §24.1; CLAUDE.md §3.3, §4.1, §9.1; TS-009e canonical test in
 * service-identity's `test/integration/wiring.integration.test.ts`; the
 * service-provider canonical test in
 * `apps/service-provider/test/integration/wiring.integration.test.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { startIntegrationTestStack, type IntegrationTestStack } from '@taste-and-see/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');

let stack: IntegrationTestStack;
let app: INestApplication;
let baseUrl: string;

/**
 * Direct Prisma handle used only by the test harness — for cross-checking
 * schema presence + round-tripping campaign / creative / targeting-rule rows
 * against the live database. The harness handle is a separate process-local
 * client with no DI overlap with the AppModule's PrismaService running inside
 * Nest (this one does not flow through the tenant-scope wrapper, which is
 * exactly what we want for harness inspection).
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Boot the canonical Postgres + Redis + migrate-deploy stack via the shared
  // harness (TS-009e-followup-1). `prisma migrate deploy` applies the full
  // migration set, so all three ads migrations land against the ephemeral DB.
  stack = await startIntegrationTestStack({
    serviceRoot: SERVICE_ROOT,
    database: 'ads_test',
  });

  // ── Env wiring ──────────────────────────────────────────────────────────
  //
  // `app.module.ts` evaluates `const moduleEnv = loadEnv()` at the top of the
  // file — i.e. as soon as the module is first imported. Every required env
  // var MUST be set BEFORE the AppModule import resolves; the dynamic
  // `await import('../../src/app.module')` below is what triggers that
  // evaluation. Static imports of AppModule at the top of this file would
  // force the validation to run before `beforeAll` had a chance to wire the
  // containers, so the import is deliberately deferred.
  //
  // All secrets are freshly generated per run — no fixture file, no
  // hard-coded keys (CLAUDE.md §17.12). The schema's `min(32)` floors would
  // reject placeholder values anyway. `ADS_INTERNAL_API_KEY` only needs to
  // clear its min-length gate — the sponsored-listings resolve surface is not
  // exercised by the health endpoints.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = stack.databaseUrl;
  process.env.REDIS_URL = stack.redisUrl;
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64');
  process.env.ADS_INTERNAL_API_KEY = randomBytes(32).toString('hex');

  // TS-506-followup-3b — this fixture is a copy of the app's env contract that
  // nothing covered, and it had fallen behind the schema. The suite was dying
  // inside `loadEnv` before its first assertion, and because the integration
  // lane is not part of `turbo run test` nothing said so.
  // `packages/testing/src/boot/integration-fixture-env.test.ts` now guards it.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  // Dynamic imports — AppModule's module-load-time env validation runs here,
  // after the env block above. The deps are pulled in parallel to shave a few
  // hundred ms off the boot.
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new RfcProblemFilter());
  // Bind to loopback explicitly. The production main.ts uses `0.0.0.0`
  // (any-interface) so a Kubernetes pod can be reached; here we want IPv4
  // loopback so `fetch(baseUrl)` reliably resolves across Linux / macOS /
  // Windows CI runners without pulling in the dual-stack resolver's edge cases.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  // Some Nest builds report `http://[::1]:NNNN` even when listening on
  // 127.0.0.1 — normalise so fetch always sees an IPv4 host.
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client — separate process-local connection, no DI
  // overlap with the AppModule's PrismaService running inside Nest. The
  // datasource URL is read from `process.env.DATABASE_URL` (set to
  // `stack.databaseUrl` above), so the client connects to the ephemeral DB.
  // Constructed without an explicit options argument: under this repo's pnpm
  // layout, `@prisma/client` resolves to loosely-typed stub declarations at
  // type-check time (the generated client lives at the service-local
  // `node_modules/.prisma/client` custom output dir), so passing a
  // `datasourceUrl` option would not type-check — env-driven construction is
  // both type-clean and runtime-correct.
  harnessPrisma = new PrismaService();
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

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function getJson(path: string): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
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

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('service-ads wiring (TS-270-followup-2)', () => {
  describe('prisma migrate deploy', () => {
    it('applied the ads schema with the load-bearing tables', async () => {
      // Spot-check the tables shipped by the three migrations: TS-270's four
      // core tables (`ad_campaigns`, `ad_creatives`, `ad_placements`,
      // `ad_targeting_rules`), TS-272a's `ad_slot_schedules`, and TS-277a's
      // append-only `ad_creative_reviews`.
      const tables = await harnessPrisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'ads'
        ORDER BY table_name
      `;
      const names = tables.map((t: { table_name: string }) => t.table_name);
      expect(names).toContain('ad_campaigns');
      expect(names).toContain('ad_creatives');
      expect(names).toContain('ad_placements');
      expect(names).toContain('ad_targeting_rules');
      expect(names).toContain('ad_slot_schedules');
      expect(names).toContain('ad_creative_reviews');
    });

    it('declares every money column as numeric(12,2)', async () => {
      // TS-305d-followup-2b1b — the property the round-trip test's
      // `toString() === '5000.00'` assertion was reaching for and could not
      // reach. CLAUDE.md §4.1: money is `Decimal(12,2)` with an explicit
      // currency column, never a float. That is a fact about the COLUMN, and
      // `information_schema` is where it can be read. A migration that shipped
      // `double precision`, or `numeric` with no scale, passes every
      // JavaScript-side assertion in this file and fails here.
      const columns = await harnessPrisma.$queryRaw<
        Array<{
          table_name: string;
          column_name: string;
          data_type: string;
          numeric_precision: number | null;
          numeric_scale: number | null;
        }>
      >`
        SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = 'ads' AND column_name IN ('budget', 'spend', 'amount', 'price')
        ORDER BY table_name, column_name
      `;

      // A floor, so a renamed column cannot turn this into a vacuous pass.
      expect(columns.length).toBeGreaterThanOrEqual(1);
      for (const column of columns) {
        expect(
          { ...column },
          `${column.table_name}.${column.column_name} is not numeric(12,2)`,
        ).toMatchObject({
          data_type: 'numeric',
          numeric_precision: 12,
          numeric_scale: 2,
        });
      }
    });

    it('round-trips an AdCampaign through PrismaClient against the live multiSchema', async () => {
      // Proves the `previewFeatures = ["multiSchema"]` generator block + the
      // per-model `@@schema("ads")` directive produce a client that can
      // address schema-qualified tables, and that the `Decimal(12,2)` budget
      // column survives the DB boundary as an exact decimal (CLAUDE.md §4.1 —
      // a `'5000.00'` string, never a lossy float). A regression that dropped
      // the preview feature would surface here as a `relation "ads.ad_campaigns"
      // does not exist` Prisma error.
      const created = await harnessPrisma.adCampaign.create({
        data: {
          name: 'Integration Test Campaign',
          advertiserKind: 'provider',
          advertiserId: 'provider_int_test',
          status: 'active',
          // String input keeps the money value float-free across the boundary.
          budget: '5000.00',
          currency: 'USD',
        },
        select: {
          id: true,
          name: true,
          advertiserKind: true,
          status: true,
          budget: true,
          currency: true,
        },
      });

      expect(created.name).toBe('Integration Test Campaign');
      expect(created.advertiserKind).toBe('provider');
      expect(created.status).toBe('active');
      expect(created.currency).toBe('USD');
      // TS-305d-followup-2b1b — this used to assert `toString() === '5000.00'`
      // and could never have passed: `Decimal.toString()` normalises trailing
      // zeros away, so a `numeric(12,2)` column holding `5000.00` returns the
      // string `'5000'`. The scale is a property of the COLUMN, not of the
      // JavaScript rendering of the value, and it is asserted directly against
      // `information_schema` below. What matters here is that the value itself
      // round-trips without coercion — which `toFixed(2)` states in the money
      // form CLAUDE.md §6 uses at presentation.
      expect(created.budget?.toFixed(2)).toBe('5000.00');

      const fetched = await harnessPrisma.adCampaign.findUnique({
        where: { id: created.id },
        select: { id: true, advertiserKind: true, status: true, budget: true },
      });
      expect(fetched).not.toBeNull();
      expect(fetched?.advertiserKind).toBe('provider');
      expect(fetched?.status).toBe('active');
      expect(fetched?.budget?.toFixed(2)).toBe('5000.00');

      await harnessPrisma.adCampaign.delete({ where: { id: created.id } });
    });

    it('round-trips an uncapped (null-budget) AdCampaign', async () => {
      // `budget` is nullable (NULL = uncapped). Proves the nullable Decimal
      // column accepts + returns null without coercion.
      const created = await harnessPrisma.adCampaign.create({
        data: {
          name: 'Internal House Ad',
          advertiserKind: 'internal',
          status: 'draft',
        },
        select: { id: true, advertiserKind: true, advertiserId: true, budget: true },
      });

      expect(created.advertiserKind).toBe('internal');
      // `internal` campaigns carry no advertiser (the soft FK is null).
      expect(created.advertiserId).toBeNull();
      expect(created.budget).toBeNull();

      await harnessPrisma.adCampaign.delete({ where: { id: created.id } });
    });

    it('cascades the in-schema FKs: deleting a campaign deletes its creatives + targeting rules', async () => {
      // Proves the `onDelete: Cascade` FK declarations on `ad_creatives` and
      // `ad_targeting_rules` are materialised in the migration DDL — a child
      // row is meaningless once its parent campaign is gone. The unit suite's
      // FakeAdsPrisma can't model referential integrity; only a live PG can.
      const campaign = await harnessPrisma.adCampaign.create({
        data: {
          name: 'Cascade Test Campaign',
          advertiserKind: 'provider',
          advertiserId: 'provider_cascade_test',
          status: 'active',
          creatives: {
            create: [
              {
                kind: 'sponsored_listing',
                assetKeys: [],
                headline: 'Cascade creative',
                status: 'approved',
              },
            ],
          },
          targetingRules: {
            create: [
              {
                kind: 'tier',
                // Opaque to the skeleton; TS-273 persists a JSON AST here.
                value: '{"operator":"any_of","values":["tier_3"]}',
              },
            ],
          },
        },
        select: { id: true },
      });

      // Both children exist before the delete.
      const creativesBefore = await harnessPrisma.adCreative.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
      });
      const rulesBefore = await harnessPrisma.adTargetingRule.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
      });
      expect(creativesBefore).toHaveLength(1);
      expect(rulesBefore).toHaveLength(1);

      // Delete the parent — the FK cascade should remove both children.
      await harnessPrisma.adCampaign.delete({ where: { id: campaign.id } });

      const creativesAfter = await harnessPrisma.adCreative.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
      });
      const rulesAfter = await harnessPrisma.adTargetingRule.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
      });
      expect(creativesAfter).toHaveLength(0);
      expect(rulesAfter).toHaveLength(0);
    });
  });

  describe('GET /healthz', () => {
    it('returns 200 + the service-pinned liveness envelope', async () => {
      const res = await getJson('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'service-ads',
      });

      const body = res.body as {
        status: string;
        service: string;
        version: string;
        uptimeSeconds: number;
      };
      // SERVICE_VERSION defaults to `dev` in the env schema when unset (and we
      // deliberately don't set it in this test).
      expect(body.version).toBe('dev');
      // Liveness must NOT depend on Postgres — here we just confirm the wire
      // response is well-formed.
      expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /readyz', () => {
    it('returns 200 + the postgres-ok readiness envelope', async () => {
      const res = await getJson('/readyz');
      expect(res.status).toBe(200);

      // The load-bearing assertion: `checks.postgres = 'ok'` proves the live
      // `SELECT 1` ping landed against the ephemeral Postgres. A regression
      // that broke the Prisma multiSchema wiring (e.g. dropped
      // `schemas = ["ads"]` from the datasource block, or removed the
      // `multiSchema` preview feature) would surface here as a 503 + a
      // "postgres readiness check failed" RFC 7807 payload.
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'service-ads',
        checks: { postgres: 'ok' },
      });

      const body = res.body as {
        status: string;
        service: string;
        version: string;
        uptimeSeconds: number;
        checks: { postgres: string };
      };
      expect(body.version).toBe('dev');
      expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });
});
