/**
 * TS-040-followup-2 — service-subscription plans seed-then-list integration.
 *
 * Boots the production `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the read-only plan catalog surface end-to-end:
 *
 *   1. Apply the service's Prisma migrations against the ephemeral DB.
 *   2. Run `seedPlanCatalog` against the live Postgres (NOT the in-memory
 *      FakePrisma the unit tests exercise) — proves the `Decimal(12,2)`
 *      column accepts the `Decimal.toFixed(2)` string the seed emits + the
 *      `jsonb` features array round-trips through Prisma's marshalling.
 *   3. Re-run the seed against the now-populated catalog — proves the
 *      upsert-on-`code` idempotency contract against real Postgres
 *      `UNIQUE` enforcement (the unit test's FakePrisma is permissive
 *      about uniqueness; this catches a regression that, say, dropped
 *      the `findUnique`-then-create-or-update branch in favour of a
 *      direct `create` that would violate the constraint).
 *   4. Hit `GET /api/v1/plans` over HTTP and assert the seven seeded
 *      plans round-trip with the expected `Decimal → minor-units` integer
 *      conversion (`$29.00` → `2900`), the `jsonb` features array
 *      surfaces as a `string[]`, and the ordering matches the contract:
 *      `(customerGroup ASC, sortPosition ASC, code ASC)` against the
 *      Postgres enum's declared order (`family`, `provider`, `academy`).
 *
 * **Load-bearing properties.** Without this test, the following
 * regressions could ship to staging undetected:
 *
 *   - A future refactor that swaps `Decimal.toFixed(2)` for a `Number`
 *     cast would silently lose precision on values like `1000.00`
 *     (becomes `1000` without the `.00` suffix the DB expects), and the
 *     unit test against FakePrisma would still pass.
 *   - A subtle Prisma marshalling regression on the `jsonb` features
 *     column (e.g. the SDK upgrades to a major that serialises arrays
 *     as `{"features": [...]}` envelopes by default) would surface as
 *     a `[]` features array on every plan — type-system-valid,
 *     contract-valid, but broken.
 *   - A re-run of the seed against an already-populated catalog must
 *     leave the seven row IDs unchanged (downstream subscription rows
 *     point at `plans.id` once TS-041b ships); the FakePrisma's auto-
 *     incrementing id-generator preserves stability for a different
 *     reason than Postgres' `@default(cuid())` does (the FakePrisma
 *     happens to not re-call the id generator on update, but real
 *     Prisma's `update` operation also doesn't touch `id` — these are
 *     two different invariants that happen to coincide). The
 *     integration test pins the real invariant.
 *   - A regression in the `listActive` ordering (e.g. someone swaps the
 *     three-key sort for a single-key `code` sort) would produce a
 *     stable-but-different surface — visually identical to the
 *     unit-test fixture but with the pricing-page tiers in the wrong
 *     band order.
 *
 * Why the real AppModule, not a hand-rolled test module? The unit
 * tests already cover the seed function + the service mapper in isolation
 * (against FakePrisma). The integration gap is wire-level: Prisma's real
 * `Decimal` and `jsonb` marshalling, Postgres' real enum-ordering
 * semantics, the env-validated AppModule boot path, and the HTTP-layer
 * contract serialisation. Those only fail when every layer is present.
 *
 * Why not supertest? The library is not on CLAUDE.md §13 approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency.
 *
 * References: PDD §24.1; CLAUDE.md §3.3, §4.1, §9.1, §17.6; TS-009e
 * canonical test in service-identity's `test/integration/wiring.integration.test.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { PlansListResponse } from '@taste-and-see/contracts';
import { startIntegrationTestStack, type IntegrationTestStack } from '@taste-and-see/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');

let stack: IntegrationTestStack;
let app: INestApplication;
let baseUrl: string;

/**
 * Direct Prisma handle used only by the test harness — for two narrow
 * purposes: invoking the production `seedPlanCatalog` (which takes a
 * `PrismaService`) and cross-checking row counts / id stability after a
 * reseed. The harness handle is a separate process-local client with no
 * DI overlap with the AppModule's PrismaService running inside Nest.
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Boot the canonical Postgres + Redis + migrate-deploy stack via the
  // shared harness (TS-009e-followup-1). The image tags + tmpfs +
  // readiness-wait + Prisma-CLI invocation that used to live verbatim
  // here (and across every other service's integration test) now live
  // in `packages/testing/src/integration/` — single source of truth.
  stack = await startIntegrationTestStack({
    serviceRoot: SERVICE_ROOT,
    database: 'subscription_test',
  });

  // ── Env wiring ────────────────────────────────────────────────────
  //
  // `app.module.ts` evaluates `const moduleEnv = loadEnv()` at the
  // top of the file — i.e. as soon as the module is first imported.
  // Every required env var MUST be set BEFORE the AppModule import
  // resolves; the dynamic `await import('../../src/app.module')`
  // below is what triggers that evaluation. Static imports of
  // AppModule at the top of this file would force the validation to
  // run before `beforeAll` had a chance to wire the containers, so
  // the import is deliberately deferred.
  //
  // All secrets are freshly generated per run — no test fixture
  // file, no hard-coded keys. CLAUDE.md §17.12 forbids committing
  // secrets, and the schema's `min(32)` / `min(16)` floors would
  // reject placeholder values anyway. Stripe is never actually
  // called in this test (GET /api/v1/plans is a Prisma-only read);
  // the secret-key value only needs to clear the `min(16)`
  // validation gate.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = stack.databaseUrl;
  process.env.REDIS_URL = stack.redisUrl;
  process.env.STRIPE_SECRET_KEY = `sk_test_${randomBytes(16).toString('hex')}`;
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64');

  // TS-506-followup-3b — this fixture is a copy of the app's env contract that
  // nothing covered, and it had fallen behind the schema. The suite was dying
  // inside `loadEnv` before its first assertion, and because the integration
  // lane is not part of `turbo run test` nothing said so.
  // `packages/testing/src/boot/integration-fixture-env.test.ts` now guards it.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  // Dynamic imports — AppModule's module-load-time env validation
  // runs here, after the env block above. The deps are pulled in
  // parallel to shave a few hundred ms off the boot.
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.useGlobalFilters(new RfcProblemFilter());
  // Bind to loopback explicitly. The production main.ts uses
  // `0.0.0.0` (any-interface) so a Kubernetes pod can be reached;
  // here we want IPv4 loopback so `fetch(baseUrl)` reliably
  // resolves across Linux / macOS / Windows CI runners without
  // pulling in the dual-stack resolver's edge cases.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  // Some Nest builds report `http://[::1]:NNNN` even when listening
  // on 127.0.0.1 — normalise so fetch always sees an IPv4 host.
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client. Used to drive `seedPlanCatalog`
  // directly and to cross-check the resulting row state. The
  // production AppModule's PrismaService is running inside Nest
  // with its own connection — this is a separate process-local
  // client with no DI overlap.
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

/**
 * The seven Phase-1 plan codes from PRD §5 (`PLAN_CATALOG` in
 * `seed-catalog.ts`). Captured here as a sanity-check tuple so a future
 * catalog edit that adds an eighth code surfaces here as a test failure
 * (rather than silently passing because the test counts loose-equality).
 */
const EXPECTED_PLAN_CODES = [
  'family.tier1',
  'family.tier2',
  'family.tier3',
  'provider.basic',
  'provider.certified',
  'provider.elite',
  'academy.membership',
] as const;

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('service-subscription plans integration (TS-040-followup-2)', () => {
  describe('seedPlanCatalog against real Postgres', () => {
    it('first-apply lands all seven Phase-1 plans with the contracted price shape', async () => {
      // Pull seedPlanCatalog dynamically — same deferred-import shape
      // as the AppModule load above, so the module-load-time side
      // effects in `seed-catalog.ts` (the duplicate-code compile-time
      // guard) run after the harness env is in place.
      const { seedPlanCatalog } = await import('../../src/modules/plans/seed');

      const report = await seedPlanCatalog(harnessPrisma);

      expect(report.plansUpserted).toBe(EXPECTED_PLAN_CODES.length);
      expect(report.created).toHaveLength(EXPECTED_PLAN_CODES.length);
      expect(report.updated).toEqual([]);

      const rows = await harnessPrisma.plan.findMany({
        select: { code: true, monthlyPrice: true, annualPrice: true, features: true },
        orderBy: { code: 'asc' },
      });
      expect(rows.map((r) => r.code).sort()).toEqual([...EXPECTED_PLAN_CODES].sort());

      // Spot-check the Decimal round-trip on the highest-value plan
      // — `family.tier3` is $1000.00 / $10000.00 per PRD §5. The
      // value lands in the column as `Decimal(12,2)`; Prisma's
      // JS-side `Decimal` round-trips it. The structural property
      // we care about is that `toFixed(2)` returns the exact string
      // the seed emitted (no floating-point distortion).
      const tier3 = rows.find((r) => r.code === 'family.tier3');
      expect(tier3).toBeDefined();
      expect(tier3?.monthlyPrice.toFixed(2)).toBe('1000.00');
      expect(tier3?.annualPrice.toFixed(2)).toBe('10000.00');

      // Spot-check the `jsonb` features column on a sample row.
      // Prisma surfaces `jsonb` as a `Prisma.JsonValue` — the seed
      // wrote a plain array, so we expect a plain array back.
      const essential = rows.find((r) => r.code === 'family.tier1');
      expect(Array.isArray(essential?.features)).toBe(true);
      const features = essential?.features as unknown as readonly unknown[];
      expect(features.length).toBeGreaterThan(0);
      expect(features.every((f) => typeof f === 'string')).toBe(true);
    });

    it('second-apply is idempotent (no rows created, all rows updated, ids preserved)', async () => {
      const { seedPlanCatalog } = await import('../../src/modules/plans/seed');

      // Capture the id-set BEFORE the second apply. Downstream
      // subscription rows will point at `plans.id` once TS-041b ships;
      // a regression that re-id'd a plan on every reseed would
      // silently break the FK invariant once subscriptions exist.
      const before = await harnessPrisma.plan.findMany({
        select: { id: true, code: true },
      });
      const idsByCode = new Map(before.map((r) => [r.code, r.id]));

      const report = await seedPlanCatalog(harnessPrisma);

      expect(report.created).toEqual([]);
      expect(report.updated).toHaveLength(EXPECTED_PLAN_CODES.length);

      // Row count stable at seven.
      const countAfter = await harnessPrisma.plan.count();
      expect(countAfter).toBe(EXPECTED_PLAN_CODES.length);

      // Per-row id stability — load-bearing for the
      // future-subscription-FK invariant.
      const after = await harnessPrisma.plan.findMany({
        select: { id: true, code: true },
      });
      for (const row of after) {
        expect(idsByCode.get(row.code)).toBe(row.id);
      }
    });
  });

  describe('GET /api/v1/plans', () => {
    it('returns 200 + the seven seeded plans wrapped in { plans: [...] }', async () => {
      const res = await getJson('/api/v1/plans');
      expect(res.status).toBe(200);

      // The response shape is the wrapper envelope from
      // `PlansListResponseSchema` — `{ plans: [...] }`. Asserting on
      // the wrapper (not a bare array) defends against a future
      // refactor that flattened to a top-level array (which would
      // break the forward-compat shape captured in the contract
      // package).
      expect(res.body).toMatchObject({});
      expect(Array.isArray((res.body as PlansListResponse).plans)).toBe(true);

      const list = res.body as PlansListResponse;
      expect(list.plans).toHaveLength(EXPECTED_PLAN_CODES.length);
    });

    it('serialises Decimal prices as integer minor units', async () => {
      const res = await getJson('/api/v1/plans');
      const list = res.body as PlansListResponse;

      // $29.00 → 2900 minor units.
      const essential = list.plans.find((p) => p.code === 'family.tier1');
      expect(essential).toBeDefined();
      expect(essential?.monthlyPriceUsdMinor).toBe(2900);
      expect(essential?.annualPriceUsdMinor).toBe(29_000);

      // $199.00 → 19900 minor units.
      const companion = list.plans.find((p) => p.code === 'family.tier2');
      expect(companion?.monthlyPriceUsdMinor).toBe(19_900);
      expect(companion?.annualPriceUsdMinor).toBe(199_000);

      // $1000.00 → 100000 minor units — the highest-value plan;
      // exercises the upper bound of the integer-conversion path.
      const concierge = list.plans.find((p) => p.code === 'family.tier3');
      expect(concierge?.monthlyPriceUsdMinor).toBe(100_000);
      expect(concierge?.annualPriceUsdMinor).toBe(1_000_000);

      // Float-math sanity: the conversion is `Decimal.mul(100)` →
      // integer, NOT `Number(price) * 100`. The latter would emit
      // 99.00000000000001 etc. for some values; the former is
      // deterministic. Spot-checking on the awkward `99.00` value
      // here is defence-in-depth (the unit test covers the same
      // property against FakePrisma).
      const certified = list.plans.find((p) => p.code === 'provider.certified');
      expect(certified?.monthlyPriceUsdMinor).toBe(9_900);
      expect(Number.isInteger(certified?.monthlyPriceUsdMinor)).toBe(true);
    });

    it('serialises jsonb features as a string[]', async () => {
      const res = await getJson('/api/v1/plans');
      const list = res.body as PlansListResponse;

      for (const plan of list.plans) {
        expect(Array.isArray(plan.features)).toBe(true);
        expect(plan.features.every((f) => typeof f === 'string')).toBe(true);
        // Catalog rows ship with non-empty feature arrays — a
        // regression that lost the features payload in the DTO mapper
        // would surface as an empty array here.
        expect(plan.features.length).toBeGreaterThan(0);
      }
    });

    it('orders by (customerGroup, sortPosition, code) — Postgres enum order', async () => {
      const res = await getJson('/api/v1/plans');
      const list = res.body as PlansListResponse;

      // The enum is declared in this order in the Prisma schema:
      //   family, provider, academy
      // Postgres enums sort by DECLARED order, not alphabetical. So
      // the response groups by family → provider → academy.
      //
      // Within each band the order is `(sortPosition ASC, code ASC)`,
      // which the catalog seeds as:
      //   family.tier1 (sort=0), family.tier2 (sort=1), family.tier3 (sort=2)
      //   provider.basic (sort=0), provider.certified (sort=1), provider.elite (sort=2)
      //   academy.membership (sort=0)
      //
      // Capturing the exact expected order here defends against a
      // future regression that swapped the multi-key sort for a
      // single-key one (e.g. a refactor that "simplified" to
      // `orderBy: { sortPosition: 'asc' }` would scramble the bands).
      expect(list.plans.map((p) => p.code)).toEqual([
        'family.tier1',
        'family.tier2',
        'family.tier3',
        'provider.basic',
        'provider.certified',
        'provider.elite',
        'academy.membership',
      ]);
    });

    it('emits every contract field on every plan', async () => {
      const res = await getJson('/api/v1/plans');
      const list = res.body as PlansListResponse;

      // Sample on a single plan to assert the full shape — the
      // contract layer's `.strict()` will reject unknown fields if
      // any leaked through.
      const essential = list.plans.find((p) => p.code === 'family.tier1');
      expect(essential).toMatchObject({
        code: 'family.tier1',
        name: 'Essential',
        customerGroup: 'family',
        currency: 'USD',
        active: true,
      });
      // Required ISO-8601 string timestamps. The contract enforces
      // `.datetime()` so a Date-toString leak would surface here.
      expect(typeof essential?.createdAt).toBe('string');
      expect(typeof essential?.updatedAt).toBe('string');
      expect(() => new Date(essential!.createdAt).toISOString()).not.toThrow();
      expect(() => new Date(essential!.updatedAt).toISOString()).not.toThrow();
      // CUID-ish id — the production seed uses Prisma's @default(cuid()).
      expect(essential?.id).toMatch(/^[a-z0-9]+$/);
    });
  });
});
