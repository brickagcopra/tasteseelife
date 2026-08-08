/**
 * TS-050-followup-2 — service-provider skeleton boot + /healthz + /readyz
 * integration.
 *
 * Boots the production `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the health surface end-to-end:
 *
 *   1. Apply the service's Prisma migrations against the ephemeral DB
 *      (`prisma migrate deploy` against the canonical migration set —
 *      same execution path production deployment uses).
 *   2. Boot the production AppModule (env-validated via `loadEnv()`,
 *      IdempotencyModule wired against the live Redis, NestAuthModule
 *      wired with a freshly-generated 48-byte JWT secret) and bind
 *      `app.listen(0, '127.0.0.1')` to an ephemeral port.
 *   3. Hit `GET /healthz` over HTTP and assert the 200 + the
 *      `LivenessResponse` shape — `service-provider`-pinned name +
 *      uptime + version.
 *   4. Hit `GET /readyz` over HTTP and assert the 200 + the
 *      `ReadinessResponse` shape — `checks.postgres = 'ok'` is the
 *      load-bearing assertion (proves the Prisma multiSchema feature
 *      works end-to-end against a live Postgres; the unit suite uses
 *      an in-memory fake that can never catch a misconfigured
 *      `schemas = ["provider"]` block).
 *   5. Cross-check the migrate-deploy result directly via the harness
 *      Prisma client: the `provider` schema exists, the four
 *      load-bearing tables (`providers`, `provider_applications`,
 *      `provider_background_checks`, `outbox_events`) are present,
 *      and a `Provider` row round-trips through the generated client
 *      against the live `Decimal(12,2)`-free schema.
 *
 * **Load-bearing properties.** Without this test, the following
 * regressions could ship to staging undetected:
 *
 *   - The Prisma multiSchema preview feature is required for
 *     `@@schema("provider")` — a regression that dropped
 *     `previewFeatures = ["multiSchema"]` from the generator block
 *     would produce a Prisma client that can't address the schema-
 *     qualified tables, and the unit test against FakePrisma would
 *     still pass. The `/readyz` ping against the live schema-
 *     qualified `users`-equivalent (here: `providers`) catches that.
 *   - The migration set's internal consistency. The unit tests never
 *     run `prisma migrate deploy`; they read from a hand-coded
 *     FakePrisma. A new migration that referenced a missing column
 *     or used a non-existent enum value would only surface at
 *     deploy time without an integration test. The schema-table
 *     enumeration test catches missing-table regressions; the
 *     Provider round-trip catches enum-value regressions on the
 *     `provider_status` / `provider_tier` enums.
 *   - The AppModule's module-load-time env validation (the top-of-
 *     file `const moduleEnv = loadEnv()` call) is exercised here
 *     against a realistic env block. A regression that tightened
 *     the env contract without a paired test update would surface
 *     here.
 *   - The IdempotencyModule's `redis-url` backend wires up against a
 *     live Redis at boot. A regression that broke that wiring
 *     would surface at `AppModule` construction time, which is
 *     before the first HTTP test runs.
 *
 * **Why the real AppModule, not a hand-rolled test module?** The unit
 * tests already cover the health controller in isolation (against
 * FakePrisma). The integration gap is wire-level: Prisma's real
 * multiSchema marshalling against a live Postgres, the env-validated
 * AppModule boot path, and the HTTP-layer contract. Those only fail
 * when every layer is present.
 *
 * **Why not supertest?** The library is not on CLAUDE.md §13 approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency.
 *
 * References: PDD §24.1; CLAUDE.md §3.3, §4.1, §9.1; TS-009e canonical
 * test in service-identity's `test/integration/wiring.integration.test.ts`;
 * TS-040-followup-2 canonical test in service-subscription's
 * `test/integration/plans.integration.test.ts`.
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
 * Direct Prisma handle used only by the test harness — for cross-
 * checking schema presence + round-tripping a Provider row against the
 * live database. The harness handle is a separate process-local
 * client with no DI overlap with the AppModule's PrismaService running
 * inside Nest.
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
    database: 'provider_test',
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
  // secrets, and the schema's `min(32)` floors would reject
  // placeholder values anyway. Checkr is never actually called in
  // this test (the health endpoints don't reach the ApplicationsModule);
  // the API key only needs to clear the `min(20)` validation gate.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = stack.databaseUrl;
  process.env.REDIS_URL = stack.redisUrl;
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64');
  // AES-256 key — exactly 32 bytes, base64-encoded.
  process.env.BACKGROUND_CHECK_PAYLOAD_ENC_KEY = randomBytes(32).toString('base64');
  process.env.CHECKR_API_KEY = `chk_test_${randomBytes(16).toString('hex')}`;
  process.env.BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY = randomBytes(32).toString('hex');
  process.env.PROVIDER_DISCOVERY_INTERNAL_API_KEY = randomBytes(32).toString('hex');
  // Added 2026-08-06: both keys became required after this fixture was
  // written, and the suite had been failing at `loadEnv` — before reaching a
  // single assertion — for however long. The integration lane is not in
  // `turbo run test`, so nothing said so.
  //
  // This is the same drift `boot-graph-stub-env.test.ts` (TS-506-followup-3)
  // guards for `STUB_ENV`, in a THIRD copy of the env contract that no guard
  // covers. See TS-305d-followup-2's entry — extending that guard to the
  // integration fixtures is filed as TS-506-followup-3b.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  process.env.PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY = randomBytes(32).toString('hex');

  // Dynamic imports — AppModule's module-load-time env validation
  // runs here, after the env block above. The deps are pulled in
  // parallel to shave a few hundred ms off the boot.
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  // `['error']`, not `false` (TS-305d-followup-2b). This suite spent an
  // unknown stretch failing `/readyz` with a 503 whose cause was
  // swallowed by the controller's catch and then stripped from the wire
  // by `RfcProblemFilter`. Silencing Nest entirely means a boot-time or
  // probe-time failure arrives as a bare status-code mismatch. `error`
  // only — `warn` and above would drown the run in Prisma/ioredis noise.
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.useGlobalFilters(new RfcProblemFilter());
  // Bind to loopback explicitly. The production main.ts uses
  // `0.0.0.0` (any-interface) so a Kubernetes pod can be reached;
  // here we want IPv4 loopback so `fetch(baseUrl)` reliably resolves
  // across Linux / macOS / Windows CI runners without pulling in the
  // dual-stack resolver's edge cases.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  // Some Nest builds report `http://[::1]:NNNN` even when listening
  // on 127.0.0.1 — normalise so fetch always sees an IPv4 host.
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client. Used to cross-check schema presence
  // and round-trip a Provider row against the live database. The
  // production AppModule's PrismaService is running inside Nest with
  // its own connection — this is a separate process-local client
  // with no DI overlap.
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

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('service-provider wiring (TS-050-followup-2)', () => {
  describe('prisma migrate deploy', () => {
    it('applied the provider schema with the four load-bearing tables', async () => {
      // Spot-check the four tables shipped by the TS-050 + TS-051 +
      // TS-052 + TS-142-followup-1 migration set. The `outbox_events`
      // table proves the 20260516120000_outbox_events migration
      // applied; the rest cover TS-050 (`providers`), TS-051
      // (`provider_applications`, `provider_background_checks`), and
      // TS-052 (`certifications`, `provider_certifications`,
      // `provider_tier_history`).
      const tables = await harnessPrisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'provider'
        ORDER BY table_name
      `;
      const names = tables.map((t) => t.table_name);
      expect(names).toContain('providers');
      expect(names).toContain('provider_applications');
      expect(names).toContain('provider_background_checks');
      expect(names).toContain('certifications');
      expect(names).toContain('provider_certifications');
      expect(names).toContain('provider_tier_history');
      expect(names).toContain('outbox_events');
    });

    it('round-trips a Provider row through PrismaClient against the live multiSchema', async () => {
      // Proves the `previewFeatures = ["multiSchema"]` generator
      // block + the per-model `@@schema("provider")` directive
      // produce a client that can address schema-qualified tables.
      // A regression that dropped the preview feature flag would
      // surface here as a `relation "provider.providers" does not
      // exist` Prisma error.
      const userId = `user_int_${Date.now()}_${process.pid}`;
      const created = await harnessPrisma.provider.create({
        data: {
          userId,
          status: 'pending',
          tier: 'basic',
          displayName: 'Integration Test Provider',
          timeZone: 'America/New_York',
        },
        select: { id: true, userId: true, status: true, tier: true, displayName: true },
      });

      expect(created.userId).toBe(userId);
      expect(created.status).toBe('pending');
      expect(created.tier).toBe('basic');
      expect(created.displayName).toBe('Integration Test Provider');

      const fetched = await harnessPrisma.provider.findUnique({
        where: { id: created.id },
        select: { id: true, userId: true, status: true, tier: true },
      });
      expect(fetched).not.toBeNull();
      expect(fetched?.userId).toBe(userId);
      expect(fetched?.status).toBe('pending');
      expect(fetched?.tier).toBe('basic');

      await harnessPrisma.provider.delete({ where: { id: created.id } });
    });
  });

  describe('GET /healthz', () => {
    it('returns 200 + the service-pinned liveness envelope', async () => {
      const res = await getJson('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'service-provider',
      });

      const body = res.body as {
        status: string;
        service: string;
        version: string;
        uptimeSeconds: number;
      };
      // SERVICE_VERSION defaults to `dev` in the env schema when
      // unset (and we deliberately don't set it in this test).
      expect(body.version).toBe('dev');
      // Liveness must NOT depend on Postgres — the unit test
      // pins the property in isolation; here we just confirm the
      // wire response is well-formed.
      expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /readyz', () => {
    it('returns 200 + the postgres-ok readiness envelope', async () => {
      const res = await getJson('/readyz');
      // TS-305d-followup-2b — carry the body into the failure message.
      // A bare `expected 503 to be 200` says a pod would never join its
      // Service's endpoints and nothing about why; the RFC 7807 payload
      // names the cause.
      expect(res.status, `/readyz body: ${JSON.stringify(res.body)}`).toBe(200);

      // The load-bearing assertion: `checks.postgres = 'ok'` proves
      // the live `SELECT 1` ping landed against the ephemeral
      // Postgres. A regression that broke the Prisma multiSchema
      // wiring (e.g. dropped `schemas = ["provider"]` from the
      // datasource block, or removed the `multiSchema` preview
      // feature) would surface here as a 503 + a "postgres
      // readiness check failed" RFC 7807 payload.
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'service-provider',
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
