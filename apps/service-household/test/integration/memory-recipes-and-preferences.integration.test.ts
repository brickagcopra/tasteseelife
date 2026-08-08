/**
 * TS-033-followup-7 — end-to-end memory-recipes + senior-preferences integration.
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and exercises both senior-profile surfaces over HTTP —
 * proving the wire contract from the controller boundary down to the
 * Prisma persistence layer (CLAUDE.md §3 / §4.1 / §9.1; PDD §24.1).
 *
 * Why the real `AppModule`, not a hand-rolled test module? The unit
 * tests (`memory-recipes.service.test.ts`, `senior-preferences.service.test.ts`)
 * already cover every service method + controller branch in isolation
 * against `FakePrisma`. The integration gap is wire-level: Prisma's
 * composite-PK upsert behaviour for `(senior_id, key)` against
 * Postgres' real `UNIQUE` enforcement, the `aggregate({ _max })` query
 * shape against an empty set + a populated set, the `orderBy [{ sortPosition },
 * { createdAt }]` index-only scan against real Postgres ordering
 * semantics with `Timestamptz(6)` microsecond precision, the
 * `$transaction([upsert, deleteMany, …])` batch against Postgres'
 * MVCC isolation, and the tenant-scope gate in `enforce` mode
 * (CLAUDE.md §3.2). Those only fail when every layer is present.
 *
 * Scope:
 *
 *   Block 1 — `'memory recipes HTTP CRUD against real Postgres'` (4 tests):
 *     1. Three POSTs in sequence auto-assign `sortPosition` 0/1/2 from
 *        `aggregate({ _max })`; soft-delete the middle one and a fourth
 *        POST lands at 3 (not 1) — the deleted slot does NOT reset the
 *        running counter. PATCH the second's `requestedForUpcomingVisit`
 *        to true → GET reflects the change. DELETE the first → list
 *        returns the remaining two in `sortPosition` order. The
 *        composite-orderBy `(sortPosition ASC, createdAt ASC)` is
 *        exercised end-to-end against the real Postgres index.
 *     2. Cap-422 short-circuit. Seed `MEMORY_RECIPES_MAX_PER_SENIOR`
 *        (200) rows directly via the harness Prisma (skipping 200
 *        HTTP round-trips that would balloon per-file runtime), then
 *        the 201st POST returns 422 with the cap-message. Cap-422
 *        must not leave a 201st row (the service's count-then-create
 *        check fires before the insert). After soft-deleting one, a
 *        fresh POST succeeds at 201 + the cap holds at 200. The
 *        wire-level contract proves the Postgres
 *        `count(*) WHERE deleted_at IS NULL` matches the service's
 *        expectation.
 *     3. PATCH happy path + empty-body 400. Same shape as the emergency-
 *        contacts test — Zod accepts `{}` for syntactic ergonomics; the
 *        service requires real intent and returns 400.
 *     4. DELETE idempotency — first DELETE returns 204 + the row is
 *        soft-deleted (`deletedAt != null`); second DELETE on the same
 *        id still returns 204 + the tombstone is byte-identical (the
 *        service's `if (existing.deletedAt !== null) return` short-
 *        circuit fires).
 *
 *   Block 2 — `'senior preferences HTTP bulk-upsert against real Postgres'` (5 tests):
 *     1. The "5 entries = 3 inserts + 2 deletes against pre-seeded keys"
 *        merge-semantics scenario from the task acceptance criterion.
 *        Pre-seed 4 keys via two PATCHes → PATCH 5 entries (3 inserts of
 *        new keys + 2 deletes of pre-seeded keys + 0 updates) → GET
 *        returns the merged set (2 pre-seeded survivors + 3 new) in
 *        alphabetical key order. Raw `harnessPrisma.seniorPreference.count`
 *        confirms the projection matches.
 *     2. Composite-PK upsert behaviour — an existing key's value is
 *        updated in-place (not duplicated). Two PATCHes with the same
 *        key + different values → second value wins; raw row count
 *        stays at 1 for that key. Defends against a regression where
 *        Prisma's `upsert` silently degrades to a second `create`
 *        against the `seniorId_key` composite PK.
 *     3. Atomic batch — a PATCH with 3 entries succeeds; if any single
 *        entry would fail mid-batch, no entries land. Hard to construct
 *        a failing intermediate row without crafting a contract-invalid
 *        payload (which the Zod pipe rejects upfront), so this test
 *        instead pins the all-or-nothing transaction shape: a
 *        successful 3-entry PATCH writes all 3, observed via direct
 *        raw row count after the call.
 *     4. Empty-entries 400, duplicate-key 400.
 *     5. Alphabetical ordering — insert keys in reverse alphabetical
 *        order via PATCH → GET returns them in ascending alpha order.
 *        Real Postgres `ORDER BY key ASC` matches the unit test's
 *        `Array.sort` semantics for ASCII keys; the integration test
 *        pins the contract.
 *
 *   Block 3 — `'row-level authorisation'` (3 tests):
 *     6. 403 across both surfaces when the caller has no active
 *        `HouseholdMember` row + defence-in-depth: the senior stays
 *        clean (no half-write — the membership check fires BEFORE the
 *        cap-check and BEFORE the transaction).
 *     7. 404 for a soft-deleted senior.
 *     8. 404 for a missing recipe id.
 *
 * Why not supertest? The library is not on CLAUDE.md §13's approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency. Mirrors the
 * canonical shape established by
 * `apps/service-household/test/integration/emergency-contacts-and-access.integration.test.ts`.
 *
 * References: PDD §24.1; CLAUDE.md §3.2, §3.3, §4.1, §9.1, §17.1;
 * TS-031-followup-5 canonical pattern in
 * `apps/service-household/test/integration/intake.integration.test.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type {
  BulkUpsertSeniorPreferencesRequest,
  CreateMemoryRecipeRequest,
  MemoryRecipe,
  MemoryRecipesListResponse,
  SeniorPreferencesResponse,
  UpdateMemoryRecipeRequest,
} from '@taste-and-see/contracts';
import { MEMORY_RECIPES_MAX_PER_SENIOR } from '@taste-and-see/contracts';
import { createIsolatedDatabase, type IsolatedDatabaseHandle } from '@taste-and-see/testing';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');
const JWT_ISSUER = 'taste-and-see/service-identity';
const JWT_AUDIENCE = 'taste-and-see/api';

let database: IsolatedDatabaseHandle;
let app: INestApplication;
let baseUrl: string;
let jwtAccessSecret: string;

/**
 * Direct Prisma handle used only by the test harness for two narrow
 * purposes: (1) seeding `Household` + `HouseholdMember` + `Senior` rows
 * for each test (in the absence of service-side seed HTTP endpoints —
 * household / senior management lands with TS-121 web-family, not the
 * bounded context under test here), and (2) reading raw row counts +
 * `deletedAt` tombstones to assert the storage invariants the HTTP
 * surface elides. The harness Prisma is a SEPARATE process-local
 * client constructed via `new PrismaService({ datasourceUrl })` and
 * never goes through the DI-managed `wrapWithTenantScope` Proxy — so
 * test setup writes deliberately bypass the tenant-scope gate (the
 * production code path is what the HTTP tests below exercise via the
 * real `AppModule`).
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The shared Redis
  // URL is read directly from the globalSetup-provided value. The
  // database name is per-file unique so sibling integration tests in
  // the same suite cannot collide on row state.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'household_test_recipes_prefs',
    serviceRoot: SERVICE_ROOT,
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
  // secrets, and the env schema's `min(32)` / "base64 32-byte" floors
  // would reject placeholder values anyway.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = database.databaseUrl;
  process.env.REDIS_URL = inject('redisUrl');
  jwtAccessSecret = randomBytes(48).toString('base64');
  process.env.JWT_ACCESS_SECRET = jwtAccessSecret;
  process.env.JWT_ISSUER = JWT_ISSUER;
  process.env.JWT_AUDIENCE = JWT_AUDIENCE;
  process.env.HOUSEHOLD_INTAKE_ENC_KEY = randomBytes(32).toString('base64');
  process.env.HOUSEHOLD_ACCESS_ENC_KEY = randomBytes(32).toString('base64');
  // Visit-prep + wellness-summary shared-secrets — never invoked from
  // this test file, but the env schema's `min(32)` floor requires a real
  // value at boot.
  process.env.HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY = randomBytes(32).toString('hex');
  process.env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY = randomBytes(32).toString('hex');
  // Lower idempotency in-flight TTL so a slow assertion never wedges
  // the cache slot for the default 60s.
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = '5';

  // TS-506-followup-3b — this fixture is a copy of the app's env contract that
  // nothing covered, and it had fallen behind the schema. The suite was dying
  // inside `loadEnv` before its first assertion, and because the integration
  // lane is not part of `turbo run test` nothing said so.
  // `packages/testing/src/boot/integration-fixture-env.test.ts` now guards it.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  process.env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY = randomBytes(32).toString('hex');
  // Dynamic imports — AppModule's module-load-time env validation
  // runs here, after the env block above. The deps are pulled in
  // parallel to shave a few hundred ms off the boot.
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new RfcProblemFilter());
  // Bind to loopback explicitly. The production main.ts uses
  // `0.0.0.0` (any-interface) so a Kubernetes pod can be reached;
  // here we want IPv4 loopback so `fetch(baseUrl)` reliably
  // resolves across Linux / macOS / Windows CI runners without
  // pulling in the dual-stack resolver's edge cases.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client. Used solely to seed household / senior
  // rows and to read raw row counts. Separate process-local client
  // from the DI-managed one inside Nest — no DI overlap, no shared
  // pool.
  harnessPrisma = new PrismaService({ datasourceUrl: database.databaseUrl });
  await harnessPrisma.onModuleInit();
});

afterAll(async () => {
  if (harnessPrisma) {
    await harnessPrisma.onModuleDestroy();
  }
  if (app) {
    await app.close();
  }
  if (database) {
    await database.drop();
  }
});

// ─────────────────────────────────────────────────────────────────────
// HTTP + token helpers. Deliberately minimal — every call shapes its
// own headers and the helper returns enough of the Response that
// individual tests can assert on status and JSON body without
// re-parsing the same boilerplate.
// ─────────────────────────────────────────────────────────────────────

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function callJson(args: {
  readonly method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}): Promise<JsonResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${args.token}`,
  };
  if (args.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (args.idempotencyKey !== undefined) {
    headers['idempotency-key'] = args.idempotencyKey;
  }

  const response = await fetch(`${baseUrl}${args.path}`, {
    method: args.method,
    headers,
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
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
 * Mint an HS256 access token with the same secret + issuer + audience
 * the AppModule was booted with. The payload shape mirrors `auth-sdk`'s
 * `AccessTokenPayloadSchema` (sub / sid / mfa / roles / tenantScope).
 * The `tenantScope` carries the `householdId` the
 * `TenantContextInterceptor` will seed into the Prisma extension's
 * frame — for service-household, every model lives under the household
 * scope.
 */
function signAccessToken(args: { readonly userId: string; readonly householdId: string }): string {
  return jwt.sign(
    {
      sub: args.userId,
      sid: `sess_${args.userId}`,
      mfa: false,
      roles: [],
      tenantScope: { type: 'household', householdId: args.householdId },
    },
    jwtAccessSecret,
    {
      algorithm: 'HS256',
      expiresIn: 900,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    },
  );
}

/**
 * Fresh per-call idempotency key. Mirrors the production client's
 * "new key per write attempt" discipline so two requests in a single
 * test cannot accidentally hit the cached-replay branch.
 */
function freshIdempotencyKey(): string {
  return `recipes-prefs-${randomBytes(8).toString('hex')}`;
}

/**
 * Seed a household + primary-payer membership + one senior into the
 * test database. Returns the three ids the test then drives via the
 * HTTP surface. The harness Prisma bypasses the tenant-scope gate
 * (it is constructed directly, not through DI), so the seed runs
 * unscoped — production seeding is a separate concern owned by the
 * household-creation flow (TS-121).
 */
async function seedHousehold(): Promise<{
  readonly householdId: string;
  readonly seniorId: string;
  readonly payerUserId: string;
}> {
  const payerUserId = `user_${randomBytes(8).toString('hex')}`;
  const household = await harnessPrisma.household.create({
    data: {
      primaryPayerUserId: payerUserId,
      addressLine1: '1 Memory Lane',
      addressCity: 'New York',
      addressRegion: 'NY',
      addressPostalCode: '10021',
      addressCountry: 'US',
      timeZone: 'America/New_York',
    },
    select: { id: true },
  });
  await harnessPrisma.householdMember.create({
    data: {
      householdId: household.id,
      userId: payerUserId,
      memberRole: 'primary_payer',
      acceptedAt: new Date(),
    },
    select: { id: true },
  });
  const senior = await harnessPrisma.senior.create({
    data: {
      householdId: household.id,
      firstName: 'Helen',
      lastName: 'Marek',
    },
    select: { id: true },
  });
  return { householdId: household.id, seniorId: senior.id, payerUserId };
}

/**
 * Helper used by the recipes CRUD tests to build a valid create
 * payload. Keeps the test bodies focused on what's actually being
 * asserted rather than re-stating the contract shape on every line.
 */
function buildRecipePayload(args: {
  readonly title: string;
  readonly description?: string;
  readonly source?: CreateMemoryRecipeRequest['source'];
  readonly requestedForUpcomingVisit?: boolean;
}): CreateMemoryRecipeRequest {
  return {
    title: args.title,
    description: args.description ?? `Story behind ${args.title} — a few sentences of context.`,
    source: args.source ?? 'family_contribution',
    ...(args.requestedForUpcomingVisit !== undefined
      ? { requestedForUpcomingVisit: args.requestedForUpcomingVisit }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('memory recipes HTTP CRUD against real Postgres', () => {
  it('auto-assigns sortPosition 0/1/2; PATCH then DELETE preserve order', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // POST three recipes in order. The service's
    // `aggregate({ _max: { sortPosition } })` query against ACTIVE
    // rows returns null → 0 for the empty case, then 0 → 1 → 2 as
    // each successive recipe lands. The composite `orderBy
    // [{ sortPosition }, { createdAt }]` in the list endpoint relies
    // on this monotonic assignment.
    const insertNames = ['Pierogi', 'Borscht', 'Goulash'];
    const created: MemoryRecipe[] = [];
    for (const name of insertNames) {
      const post = await callJson({
        method: 'POST',
        path: `/api/v1/seniors/${seniorId}/memory-recipes`,
        token,
        body: buildRecipePayload({ title: name }),
        idempotencyKey: freshIdempotencyKey(),
      });
      expect(post.status).toBe(201);
      created.push(post.body as MemoryRecipe);
    }
    expect(created.map((r) => r.sortPosition)).toEqual([0, 1, 2]);
    expect(created.map((r) => r.source)).toEqual([
      'family_contribution',
      'family_contribution',
      'family_contribution',
    ]);
    // `contributedByUserId` is set on `family_contribution` only —
    // the service stamps it from the request context.
    expect(created.map((r) => r.contributedByUserId)).toEqual([
      payerUserId,
      payerUserId,
      payerUserId,
    ]);

    // PATCH the middle recipe (Borscht) — flip the
    // `requestedForUpcomingVisit` pin. The other fields must survive
    // untouched; the response is the read-back DTO.
    const patchBody: UpdateMemoryRecipeRequest = {
      requestedForUpcomingVisit: true,
    };
    const patch = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${created[1]!.id}`,
      token,
      body: patchBody,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(patch.status).toBe(200);
    const patched = patch.body as MemoryRecipe;
    expect(patched.id).toBe(created[1]!.id);
    expect(patched.requestedForUpcomingVisit).toBe(true);
    expect(patched.title).toBe('Borscht');
    expect(patched.sortPosition).toBe(1);

    // GET reflects the pin.
    const listPostPatch = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
    });
    expect(listPostPatch.status).toBe(200);
    const postPatchBody = listPostPatch.body as MemoryRecipesListResponse;
    expect(postPatchBody.recipes).toHaveLength(3);
    expect(postPatchBody.recipes[1]!.requestedForUpcomingVisit).toBe(true);
    expect(postPatchBody.recipes[0]!.requestedForUpcomingVisit).toBe(false);
    expect(postPatchBody.recipes[2]!.requestedForUpcomingVisit).toBe(false);

    // DELETE the first recipe (Pierogi). The list endpoint filters
    // soft-deleted rows; the remaining two must appear in their
    // original sortPosition order (1, 2).
    const del = await callJson({
      method: 'DELETE',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${created[0]!.id}`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(del.status).toBe(204);

    const listPostDelete = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
    });
    expect(listPostDelete.status).toBe(200);
    const postDeleteBody = listPostDelete.body as MemoryRecipesListResponse;
    expect(postDeleteBody.recipes).toHaveLength(2);
    expect(postDeleteBody.recipes.map((r) => r.title)).toEqual(['Borscht', 'Goulash']);
    expect(postDeleteBody.recipes.map((r) => r.sortPosition)).toEqual([1, 2]);

    // Defence-in-depth: the soft-deleted row is still in the table,
    // just filtered out by the list endpoint. Raw count via the
    // harness Prisma proves the tombstone semantics.
    const totalCount = await harnessPrisma.memoryRecipe.count({
      where: { seniorId },
    });
    expect(totalCount).toBe(3);
    const activeCount = await harnessPrisma.memoryRecipe.count({
      where: { seniorId, deletedAt: null },
    });
    expect(activeCount).toBe(2);

    // A fresh POST after the soft-delete lands at sortPosition 3 —
    // the running counter is `max(sortPosition) + 1` across ACTIVE
    // rows, so the deleted row's slot (0) is NOT reclaimed. This
    // pins the contract that sortPosition is monotone across the
    // lifecycle, not a packed dense index.
    const refill = await callJson({
      method: 'POST',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
      body: buildRecipePayload({ title: 'Refill' }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(refill.status).toBe(201);
    const refillRecipe = refill.body as MemoryRecipe;
    // max across ACTIVE = 2 (Goulash), so the next position is 3.
    expect(refillRecipe.sortPosition).toBe(3);
  });

  it('cap-422 short-circuit: 201st POST returns 422 without writing a row; soft-delete one then re-POST succeeds', async () => {
    // Wire-level cap-422 proof: the count(*) query against the live
    // Postgres `(senior_id, deletedAt IS NULL)` predicate, plus the
    // count-then-create ordering, must fire 422 BEFORE the insert
    // when the active count is at the per-senior cap. We seed the
    // 200 rows directly via the harness Prisma so we don't pay 200
    // HTTP round-trips in CI — the unit test
    // (`memory-recipes.service.test.ts`) already covers every
    // service-method branch; what we're proving here is that the
    // Postgres `count(*) WHERE deleted_at IS NULL` matches the
    // service's expectation.
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const cap = MEMORY_RECIPES_MAX_PER_SENIOR;
    const seedRows = Array.from({ length: cap }, (_, i) => ({
      seniorId,
      title: `Seed ${String(i).padStart(3, '0')}`,
      description: `Story for seed ${i}`,
      source: 'family_contribution',
      sortPosition: i,
    }));
    await harnessPrisma.memoryRecipe.createMany({ data: seedRows });

    const activeAtCap = await harnessPrisma.memoryRecipe.count({
      where: { seniorId, deletedAt: null },
    });
    expect(activeAtCap).toBe(cap);

    // The 201st POST hits the cap-422 short-circuit. The service-
    // layer check fires BEFORE the insert, so the 422 path does
    // not leave a 201st row.
    const overflow = await callJson({
      method: 'POST',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
      body: buildRecipePayload({ title: 'Overflow' }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(overflow.status).toBe(422);
    const overflowBody = overflow.body as { title?: string; status?: number; detail?: string };
    expect(overflowBody.title).toBe('Unprocessable Entity');
    expect(overflowBody.status).toBe(422);
    expect(overflowBody.detail).toContain(`${cap}-recipe maximum`);

    // Cap-422 left no extra row.
    const postOverflowActive = await harnessPrisma.memoryRecipe.count({
      where: { seniorId, deletedAt: null },
    });
    expect(postOverflowActive).toBe(cap);
    const postOverflowTotal = await harnessPrisma.memoryRecipe.count({
      where: { seniorId },
    });
    expect(postOverflowTotal).toBe(cap);

    // Soft-delete one seed via the HTTP surface — the cap-check
    // filters by `deletedAt: null`, so a vacated slot lets the next
    // POST through.
    const oneActive = await harnessPrisma.memoryRecipe.findFirst({
      where: { seniorId, deletedAt: null },
      select: { id: true },
    });
    expect(oneActive).not.toBeNull();
    const del = await callJson({
      method: 'DELETE',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${oneActive!.id}`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(del.status).toBe(204);

    const activePostDelete = await harnessPrisma.memoryRecipe.count({
      where: { seniorId, deletedAt: null },
    });
    expect(activePostDelete).toBe(cap - 1);

    // POST after the vacated slot — must succeed with 201.
    const refill = await callJson({
      method: 'POST',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
      body: buildRecipePayload({ title: 'Refill' }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(refill.status).toBe(201);

    const activePostRefill = await harnessPrisma.memoryRecipe.count({
      where: { seniorId, deletedAt: null },
    });
    expect(activePostRefill).toBe(cap);

    // The 202nd-with-a-vacant-slot still 422s — cap holds.
    const overflowAgain = await callJson({
      method: 'POST',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
      body: buildRecipePayload({ title: 'Overflow 2' }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(overflowAgain.status).toBe(422);
  });

  it('PATCH updates editable fields; empty-body PATCH returns 400', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Seed a recipe to mutate.
    const create = await callJson({
      method: 'POST',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
      body: buildRecipePayload({
        title: 'Original',
        description: 'Original description content.',
      }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(create.status).toBe(201);
    const recipe = create.body as MemoryRecipe;

    // Patch a couple of fields — title + cuisine tag. The other
    // fields are absent in the patch body and must survive
    // untouched. `cuisineTag` flips from null → set; the service
    // accepts the optional `null | string` shape.
    const patchBody: UpdateMemoryRecipeRequest = {
      title: 'Updated Title',
      cuisineTag: 'polish',
    };
    const patch = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${recipe.id}`,
      token,
      body: patchBody,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(patch.status).toBe(200);
    const patched = patch.body as MemoryRecipe;
    expect(patched.id).toBe(recipe.id);
    expect(patched.title).toBe('Updated Title');
    expect(patched.cuisineTag).toBe('polish');
    expect(patched.description).toBe('Original description content.');
    expect(patched.source).toBe(recipe.source);
    expect(patched.sortPosition).toBe(recipe.sortPosition);

    // Clear the cuisine tag via explicit `null` — the service treats
    // `null` as "clear this field" (distinct from omitting, which
    // leaves it untouched).
    const clearPatch = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${recipe.id}`,
      token,
      body: { cuisineTag: null } satisfies UpdateMemoryRecipeRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(clearPatch.status).toBe(200);
    const cleared = clearPatch.body as MemoryRecipe;
    expect(cleared.cuisineTag).toBeNull();
    expect(cleared.title).toBe('Updated Title');

    // Empty-body PATCH — the Zod schema accepts `{}` (every field
    // optional) but the service rejects it with 400.
    const emptyPatch = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${recipe.id}`,
      token,
      body: {},
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(emptyPatch.status).toBe(400);
    const emptyBody = emptyPatch.body as { title?: string; status?: number };
    expect(emptyBody.title).toBe('Bad Request');
    expect(emptyBody.status).toBe(400);
  });

  it('DELETE is idempotent — second DELETE on the same id still returns 204; row stays soft-deleted', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const create = await callJson({
      method: 'POST',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
      body: buildRecipePayload({ title: 'Doomed' }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(create.status).toBe(201);
    const recipe = create.body as MemoryRecipe;

    const first = await callJson({
      method: 'DELETE',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${recipe.id}`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(first.status).toBe(204);

    const firstRow = await harnessPrisma.memoryRecipe.findUniqueOrThrow({
      where: { id: recipe.id },
      select: { id: true, deletedAt: true },
    });
    expect(firstRow.deletedAt).not.toBeNull();
    const firstTombstone = firstRow.deletedAt;

    // Second DELETE with a fresh idempotency key — the service short-
    // circuits when `deletedAt` is already set and returns 204 without
    // re-writing the tombstone. (A fresh idempotency key is critical:
    // re-using the previous key would hit the Redis replay cache, which
    // is not what we want to test here.)
    const second = await callJson({
      method: 'DELETE',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/${recipe.id}`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(second.status).toBe(204);

    // The tombstone must be byte-identical — the second delete did NOT
    // rewrite `deletedAt`, the service's idempotent short-circuit fired.
    const secondRow = await harnessPrisma.memoryRecipe.findUniqueOrThrow({
      where: { id: recipe.id },
      select: { id: true, deletedAt: true },
    });
    expect(secondRow.deletedAt?.getTime()).toBe(firstTombstone?.getTime());

    // List endpoint filters out the soft-deleted row.
    const list = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
    });
    expect(list.status).toBe(200);
    const listBody = list.body as MemoryRecipesListResponse;
    expect(listBody.recipes).toHaveLength(0);
  });
});

describe('senior preferences HTTP bulk-upsert against real Postgres', () => {
  it('merge semantics: 3 inserts + 2 deletes against pre-seeded keys', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Pre-seed 4 keys via a single PATCH. The service's
    // bulk-upsert is the only write surface for preferences; we
    // intentionally exercise it for the seed rather than
    // back-doored via `harnessPrisma.seniorPreference.create` so
    // the test boots from the contract-validated path.
    const seed: BulkUpsertSeniorPreferencesRequest = {
      entries: [
        { key: 'favorite_childhood_dish', value: 'Pierogi' },
        { key: 'comfort_food', value: 'Borscht' },
        { key: 'regional_tradition', value: 'Krakow' },
        { key: 'sunday_ritual', value: 'Long walk after Mass' },
      ],
    };
    const seedResp = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: seed,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(seedResp.status).toBe(200);
    const seedBody = seedResp.body as SeniorPreferencesResponse;
    expect(seedBody.preferences).toHaveLength(4);

    // Raw row count after the seed.
    const postSeedCount = await harnessPrisma.seniorPreference.count({
      where: { seniorId },
    });
    expect(postSeedCount).toBe(4);

    // The task-acceptance batch: 5 entries = 3 inserts (new keys) +
    // 2 deletes (against pre-seeded keys). The merge semantics
    // contract is: keys NOT mentioned in the batch are UNTOUCHED;
    // keys with `value: null` are deleted; keys with `value: string`
    // are inserted-or-updated.
    const batch: BulkUpsertSeniorPreferencesRequest = {
      entries: [
        { key: 'cultural_holiday', value: 'Wigilia' },
        { key: 'morning_routine', value: 'Tea with honey' },
        { key: 'favorite_music', value: 'Chopin nocturnes' },
        { key: 'comfort_food', value: null }, // delete pre-seeded
        { key: 'regional_tradition', value: null }, // delete pre-seeded
      ],
    };
    const batchResp = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: batch,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(batchResp.status).toBe(200);
    const batchBody = batchResp.body as SeniorPreferencesResponse;

    // Projection:
    //   - 4 pre-seeded → 2 deleted → 2 survivors
    //     (favorite_childhood_dish, sunday_ritual)
    //   - 3 fresh inserts
    //   - 0 updates
    //   = 5 total entries in alpha order.
    expect(batchBody.preferences).toHaveLength(5);
    const keys = batchBody.preferences.map((p) => p.key);
    expect(keys).toEqual([
      'cultural_holiday',
      'favorite_childhood_dish',
      'favorite_music',
      'morning_routine',
      'sunday_ritual',
    ]);

    // Values survive untouched on the rows we didn't mention.
    const childhoodDish = batchBody.preferences.find((p) => p.key === 'favorite_childhood_dish');
    expect(childhoodDish?.value).toBe('Pierogi');
    const sundayRitual = batchBody.preferences.find((p) => p.key === 'sunday_ritual');
    expect(sundayRitual?.value).toBe('Long walk after Mass');

    // Fresh inserts carry the values we just sent.
    const culturalHoliday = batchBody.preferences.find((p) => p.key === 'cultural_holiday');
    expect(culturalHoliday?.value).toBe('Wigilia');

    // Raw row count matches the projection — the deleted rows are
    // HARD-deleted (no soft-delete on preferences); the new rows
    // are real INSERTs.
    const finalCount = await harnessPrisma.seniorPreference.count({
      where: { seniorId },
    });
    expect(finalCount).toBe(5);

    // GET round-trip returns the same shape.
    const get = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
    });
    expect(get.status).toBe(200);
    const getBody = get.body as SeniorPreferencesResponse;
    expect(getBody.preferences.map((p) => p.key)).toEqual(keys);
  });

  it('composite-PK upsert updates in-place — second PATCH on same key changes value, not row count', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const first = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: {
        entries: [{ key: 'comfort_food', value: 'Borscht' }],
      } satisfies BulkUpsertSeniorPreferencesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(first.status).toBe(200);
    const firstRow = await harnessPrisma.seniorPreference.findUniqueOrThrow({
      where: { seniorId_key: { seniorId, key: 'comfort_food' } },
      select: { value: true, createdAt: true },
    });
    expect(firstRow.value).toBe('Borscht');
    const initialCreatedAt = firstRow.createdAt;

    // Second PATCH on the same key with a different value. Prisma's
    // `upsert` against the `seniorId_key` composite PK should fall
    // through to UPDATE, not insert a duplicate row. The contract
    // is enforced by the Postgres `PRIMARY KEY (senior_id, key)`,
    // but a regression that swapped `upsert` to `create` would 500
    // with a unique violation rather than silently update.
    const second = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: {
        entries: [{ key: 'comfort_food', value: 'Pierogi' }],
      } satisfies BulkUpsertSeniorPreferencesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(second.status).toBe(200);
    const secondRow = await harnessPrisma.seniorPreference.findUniqueOrThrow({
      where: { seniorId_key: { seniorId, key: 'comfort_food' } },
      select: { value: true, createdAt: true, updatedAt: true },
    });
    expect(secondRow.value).toBe('Pierogi');
    // The `createdAt` must be preserved — upsert.update doesn't touch it.
    expect(secondRow.createdAt.getTime()).toBe(initialCreatedAt.getTime());
    // `updatedAt` is allowed to advance.
    expect(secondRow.updatedAt.getTime()).toBeGreaterThanOrEqual(initialCreatedAt.getTime());

    // Exactly one row exists for the key — no duplicate from a
    // hypothetical `create` regression.
    const rowCount = await harnessPrisma.seniorPreference.count({
      where: { seniorId, key: 'comfort_food' },
    });
    expect(rowCount).toBe(1);
  });

  it('atomic batch — 3 entries in one PATCH all land via $transaction', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // The service wraps every batch in `prisma.$transaction([...])`
    // so any single failure aborts the whole batch. We can't easily
    // construct a failing intermediate row (the Zod pipe rejects
    // contract-invalid entries upfront), so this test pins the
    // happy-path all-or-nothing shape: 3 entries in one PATCH
    // produce exactly 3 rows in Postgres, observable via raw row
    // count after the call.
    const before = await harnessPrisma.seniorPreference.count({ where: { seniorId } });
    expect(before).toBe(0);

    const resp = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: {
        entries: [
          { key: 'a_key', value: 'a_value' },
          { key: 'b_key', value: 'b_value' },
          { key: 'c_key', value: 'c_value' },
        ],
      } satisfies BulkUpsertSeniorPreferencesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as SeniorPreferencesResponse;
    expect(body.preferences).toHaveLength(3);

    const after = await harnessPrisma.seniorPreference.count({ where: { seniorId } });
    expect(after).toBe(3);
  });

  it('empty-entries 400; duplicate-key 400', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Empty `entries: []` — Zod accepts (array constraint is `max(64)`
    // only, no min), service rejects with 400.
    const emptyResp = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: { entries: [] } satisfies BulkUpsertSeniorPreferencesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(emptyResp.status).toBe(400);
    const emptyBody = emptyResp.body as { title?: string; status?: number; detail?: string };
    expect(emptyBody.title).toBe('Bad Request');
    expect(emptyBody.detail).toContain('at least one entry');

    // Duplicate key within a single request — service rejects with
    // 400 ("which value wins?" ambiguity).
    const dupResp = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: {
        entries: [
          { key: 'comfort_food', value: 'Borscht' },
          { key: 'comfort_food', value: 'Pierogi' },
        ],
      } satisfies BulkUpsertSeniorPreferencesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(dupResp.status).toBe(400);
    const dupBody = dupResp.body as { title?: string; status?: number; detail?: string };
    expect(dupBody.title).toBe('Bad Request');
    expect(dupBody.detail).toContain('Duplicate key');

    // Neither error path should have landed a row.
    const rowCount = await harnessPrisma.seniorPreference.count({ where: { seniorId } });
    expect(rowCount).toBe(0);
  });

  it('alphabetical ordering — insert in reverse alpha; list returns ascending', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Insert in reverse alphabetical order so the test catches a
    // regression that swapped `orderBy: [{ key: 'asc' }]` to `desc`
    // or to insertion order.
    const insertOrder = ['z_zeta', 'y_yankee', 'a_alpha', 'm_middle', 'b_bravo'];
    const entries = insertOrder.map((key) => ({ key, value: `value_for_${key}` }));
    const resp = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
      body: { entries } satisfies BulkUpsertSeniorPreferencesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(resp.status).toBe(200);

    const get = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
    });
    expect(get.status).toBe(200);
    const getBody = get.body as SeniorPreferencesResponse;
    expect(getBody.preferences.map((p) => p.key)).toEqual([
      'a_alpha',
      'b_bravo',
      'm_middle',
      'y_yankee',
      'z_zeta',
    ]);
  });
});

describe('row-level authorisation', () => {
  it('returns 403 across both surfaces when the requester is not a member of the household', async () => {
    const { householdId, seniorId } = await seedHousehold();
    // Mint a token for a userId that has no `HouseholdMember` row.
    // CLAUDE.md §3.2 row-level check: authenticated but not authorised.
    const attackerToken = signAccessToken({
      userId: `attacker_${randomBytes(8).toString('hex')}`,
      householdId,
    });

    // Memory-recipes POST — 403.
    const postRecipe = await callJson({
      method: 'POST',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token: attackerToken,
      body: buildRecipePayload({ title: 'Attacker recipe' }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(postRecipe.status).toBe(403);
    const postRecipeBody = postRecipe.body as { title?: string; status?: number };
    expect(postRecipeBody.title).toBe('Forbidden');

    // Memory-recipes GET — 403.
    const getRecipes = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token: attackerToken,
    });
    expect(getRecipes.status).toBe(403);

    // Preferences PATCH — 403.
    const patchPrefs = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token: attackerToken,
      body: {
        entries: [{ key: 'comfort_food', value: 'attacker_value' }],
      } satisfies BulkUpsertSeniorPreferencesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(patchPrefs.status).toBe(403);

    // Preferences GET — 403.
    const getPrefs = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token: attackerToken,
    });
    expect(getPrefs.status).toBe(403);

    // Defence-in-depth: the senior stays clean. A 403 must not
    // leave a half-written row (the membership check fires BEFORE
    // the cap-check and BEFORE the $transaction).
    const recipeCount = await harnessPrisma.memoryRecipe.count({
      where: { seniorId },
    });
    expect(recipeCount).toBe(0);
    const prefsCount = await harnessPrisma.seniorPreference.count({
      where: { seniorId },
    });
    expect(prefsCount).toBe(0);
  });

  it('returns 404 for a soft-deleted senior', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });
    await harnessPrisma.senior.update({
      where: { id: seniorId },
      data: { deletedAt: new Date() },
      select: { id: true },
    });

    const get = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/memory-recipes`,
      token,
    });
    expect(get.status).toBe(404);
    const body = get.body as { title?: string; status?: number };
    expect(body.title).toBe('Not Found');
    expect(body.status).toBe(404);

    const getPrefs = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/preferences`,
      token,
    });
    expect(getPrefs.status).toBe(404);
  });

  it('returns 404 for a missing recipe id', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const patch = await callJson({
      method: 'PATCH',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/does_not_exist_0000000000`,
      token,
      body: { title: 'never lands' } satisfies UpdateMemoryRecipeRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(patch.status).toBe(404);

    const del = await callJson({
      method: 'DELETE',
      path: `/api/v1/seniors/${seniorId}/memory-recipes/does_not_exist_0000000000`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(del.status).toBe(404);
  });

  it('also returns 404 from the preferences surface when senior is missing entirely', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Use a syntactically-valid but never-created seniorId. The
    // service's `loadAuthorisedSenior` returns 404 before any
    // membership check fires, so the unknown id never leaks the
    // 403/404 distinction back to the caller (CLAUDE.md §3.2
    // information-disclosure prudence).
    const get = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/does_not_exist_0000000000/preferences`,
      token,
    });
    expect(get.status).toBe(404);
  });
});
