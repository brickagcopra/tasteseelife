/**
 * TS-298 — ABAC row-level access integration tests (household cell).
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and asserts the role × scope visibility matrix for the
 * family-member → household cell (CLAUDE.md §3.2; PDD §10.2): a user
 * sees ONLY the rows of households they actively belong to, across
 * every membership-gated read surface the service exposes.
 *
 * What the sibling suites already cover — and this one deliberately
 * does not repeat: callers with NO membership anywhere get 403
 * (`emergency-contacts-and-access.integration.test.ts` block 3,
 * `memory-recipes-and-preferences.integration.test.ts` "row-level
 * authorisation"). The cell those suites leave open is the horizontal
 * one: an authenticated user with a REAL membership in household A
 * probing household B's rows with the same (valid) token. That is
 * the classic horizontal-privilege-escalation shape and the heart of
 * TS-298's acceptance.
 *
 * Scope:
 *
 *   Block 1 — `'seniors directory row-level visibility'` (3 tests):
 *     GET /api/v1/me/seniors is the only user→senior resolver on the
 *     platform; its membership query IS the row-level filter.
 *       1. A member of household A (with household B alive next to it
 *          in the same database) sees exactly A's seniors — B's ids
 *          never appear.
 *       2. A user who belongs to BOTH households sees the union —
 *          membership rows drive visibility, not the token's single
 *          `tenantScope` frame (documented `proceed_scoped` contract).
 *       3. A user with no memberships gets the documented empty-list
 *          shape (200 `{seniors: []}`), not a 403.
 *
 *   Block 2 — `'cross-household probes are refused'` (4 tests, one per
 *   membership-gated read surface):
 *       Emergency contacts, access-instructions, memory recipes,
 *       senior preferences. Each test drives BOTH halves of the matrix
 *       cell with the SAME token: the member's own household reads
 *       back 200 with only its rows; the probe against household B is
 *       403 with the RFC 7807 problem shape AND none of B's seeded
 *       marker strings anywhere in either response body (leak check —
 *          a 403 that echoed row data would still be a defect).
 *
 *   Block 3 — `'tenant-scope gate enforce mode'` (1 test):
 *       Proves — not assumes — that the DI-managed Prisma client runs
 *       the tenant-scope extension in `enforce` mode: a query issued
 *       outside any request frame rejects with
 *       `MissingRequestContextError` instead of proceeding unscoped.
 *
 * Deliberately OUT of scope (do not add here):
 *   - provider → own-bookings visibility: service-booking's read paths
 *     record the actor but do not yet gate on it — enforcement is owned
 *     by TS-141 / TS-060-followup-1a. A test here would bless the gap.
 *   - partner_admin → tenant visibility: no partner service or
 *     tenant-scoped read surface exists yet (partner roles carry empty
 *     permission sets); the cell becomes testable when service-partner
 *     lands.
 *
 * Bootstrap cloned from the canonical household integration suites
 * (`intake.integration.test.ts` shape); see those files for the
 * why-not-supertest and env-before-dynamic-import notes.
 *
 * References: CLAUDE.md §3.2, §9.1, §9.3; PDD §10.2; TS-009e; TS-214.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type {
  CreateEmergencyContactRequest,
  CreateMemoryRecipeRequest,
  EmergencyContactsListResponse,
  HouseholdAccessInstructionsResponse,
  MemoryRecipesListResponse,
  MySeniorsResponse,
  SeniorPreferencesResponse,
} from '@taste-and-see/contracts';
import { MissingRequestContextError } from '@taste-and-see/nest-prisma-tenant-scope';
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
 * Direct Prisma handle used only by the test harness to seed
 * `Household` + `HouseholdMember` + `Senior` rows (household / senior
 * management lands with TS-121 web-family, not the bounded context
 * under test). The harness Prisma is a SEPARATE process-local client
 * constructed via `new PrismaService({ datasourceUrl })` and never
 * goes through the DI-managed `wrapWithTenantScope` Proxy — so test
 * setup writes deliberately bypass the tenant-scope gate (the
 * production code path is what the HTTP tests below exercise via the
 * real `AppModule`).
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The database name
  // is per-file unique so sibling integration tests cannot collide.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'household_test_row_level',
    serviceRoot: SERVICE_ROOT,
  });

  // ── Env wiring ────────────────────────────────────────────────────
  //
  // `app.module.ts` evaluates `loadEnv()` at module load — every
  // required env var MUST be set BEFORE the dynamic AppModule import
  // below resolves. All secrets are freshly generated per run.
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
  // this test file, but the env schema's `min(32)` floor requires a
  // real value at boot.
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
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new RfcProblemFilter());
  // IPv4 loopback so `fetch(baseUrl)` resolves consistently across CI
  // runners — see sibling suites for the dual-stack note.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

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
// HTTP + token helpers — same minimal shapes as the sibling suites.
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
 * Mint an HS256 access token mirroring `auth-sdk`'s
 * `AccessTokenPayloadSchema`. The `tenantScope` carries the household
 * the member belongs to — exactly what identity would issue for a
 * family user. The cross-household probes below therefore run with a
 * token whose frame points at household A while the URL points at
 * household B: the tenant-scope gate passes (a frame is present), and
 * the service-layer membership query is what must refuse the read.
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

function freshIdempotencyKey(): string {
  return `row-level-${randomBytes(8).toString('hex')}`;
}

interface SeededHousehold {
  readonly householdId: string;
  readonly payerUserId: string;
  readonly seniorIds: readonly string[];
  readonly token: string;
}

/**
 * Seed one household with an accepted primary-payer membership and
 * `seniorCount` active seniors. Names carry the caller's marker so a
 * leak of one household's rows into another household's response is
 * greppable in the raw body.
 */
async function seedHousehold(args: {
  readonly marker: string;
  readonly seniorCount: number;
}): Promise<SeededHousehold> {
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
  const seniorIds: string[] = [];
  for (let index = 0; index < args.seniorCount; index += 1) {
    const senior = await harnessPrisma.senior.create({
      data: {
        householdId: household.id,
        firstName: `${args.marker}Senior${index}`,
        lastName: 'Rowlevel',
      },
      select: { id: true },
    });
    seniorIds.push(senior.id);
  }
  return {
    householdId: household.id,
    payerUserId,
    seniorIds,
    token: signAccessToken({ userId: payerUserId, householdId: household.id }),
  };
}

/** Add an accepted non-payer membership for an existing user. */
async function addMembership(args: {
  readonly householdId: string;
  readonly userId: string;
}): Promise<void> {
  await harnessPrisma.householdMember.create({
    data: {
      householdId: args.householdId,
      userId: args.userId,
      // TS-305d-followup-2b1b — `family_member` is not a value of
      // `HouseholdMemberRole`, which is `primary_payer | family_observer |
      // senior_user`. The helper's own doc-line says "non-payer membership",
      // and `family_observer` is that role — the one CLAUDE.md §12 scopes to
      // what the senior has consented to share.
      memberRole: 'family_observer',
      acceptedAt: new Date(),
    },
    select: { id: true },
  });
}

/**
 * Give household B one row on each membership-gated surface, written
 * through the REAL HTTP write paths as B's own member (the write-path
 * contracts are already pinned by the sibling CRUD suites — reusing
 * them keeps this harness free of storage-shape knowledge). The
 * distinctive marker strings are what the probe tests then assert
 * never appear in a response served to household A's member.
 */
async function populateSurfaces(target: SeededHousehold, marker: string): Promise<void> {
  const seniorId = target.seniorIds[0];
  if (seniorId === undefined) {
    throw new Error('populateSurfaces requires a household seeded with at least one senior');
  }

  const contactPayload: CreateEmergencyContactRequest = {
    name: `${marker}Contact`,
    relationship: 'Adult child',
    phone: '+14155550100',
    priority: 1,
  };
  const contact = await callJson({
    method: 'POST',
    path: `/api/v1/households/${target.householdId}/emergency-contacts`,
    token: target.token,
    body: contactPayload,
    idempotencyKey: freshIdempotencyKey(),
  });
  expect(contact.status).toBe(201);

  const instructions = await callJson({
    method: 'PUT',
    path: `/api/v1/households/${target.householdId}/access-instructions`,
    token: target.token,
    body: { doorCode: `${marker}Code`, generalNotes: `${marker}Notes` },
    idempotencyKey: freshIdempotencyKey(),
  });
  expect(instructions.status).toBe(200);

  const recipePayload: CreateMemoryRecipeRequest = {
    title: `${marker}Recipe`,
    description: `Story behind ${marker}Recipe — a few sentences of context.`,
    source: 'family_contribution',
  };
  const recipe = await callJson({
    method: 'POST',
    path: `/api/v1/seniors/${seniorId}/memory-recipes`,
    token: target.token,
    body: recipePayload,
    idempotencyKey: freshIdempotencyKey(),
  });
  expect(recipe.status).toBe(201);

  const prefs = await callJson({
    method: 'PATCH',
    path: `/api/v1/seniors/${seniorId}/preferences`,
    token: target.token,
    body: { entries: [{ key: 'favorite_dish', value: `${marker}Paella` }] },
    idempotencyKey: freshIdempotencyKey(),
  });
  expect(prefs.status).toBe(200);
}

/**
 * Assert the RFC 7807 refusal shape AND that none of the target
 * household's marker strings leaked into the body. A 403 whose problem
 * `detail` echoed row data would still be a horizontal-privilege leak.
 */
function expectForbiddenWithoutLeak(response: JsonResponse, marker: string): void {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ title: 'Forbidden', status: 403 });
  expect(JSON.stringify(response.body)).not.toContain(marker);
}

// ─────────────────────────────────────────────────────────────────────
// Block 1 — seniors directory
// ─────────────────────────────────────────────────────────────────────

describe('seniors directory row-level visibility (GET /api/v1/me/seniors)', () => {
  it("member of household A sees exactly A's seniors — B's never leak", async () => {
    const a = await seedHousehold({ marker: 'DirA', seniorCount: 2 });
    const b = await seedHousehold({ marker: 'DirB', seniorCount: 1 });

    const response = await callJson({
      method: 'GET',
      path: '/api/v1/me/seniors',
      token: a.token,
    });
    expect(response.status).toBe(200);

    const body = response.body as MySeniorsResponse;
    expect(body.seniors).toHaveLength(2);
    const returnedIds = body.seniors.map((s) => s.seniorId).sort();
    expect(returnedIds).toEqual([...a.seniorIds].sort());
    for (const senior of body.seniors) {
      expect(senior.householdId).toBe(a.householdId);
    }
    // Belt-and-braces: B's household and senior ids appear nowhere in
    // the raw body.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(b.householdId);
    for (const bSeniorId of b.seniorIds) {
      expect(raw).not.toContain(bSeniorId);
    }
  });

  it('a user belonging to BOTH households sees the union — membership rows drive visibility', async () => {
    const a = await seedHousehold({ marker: 'UnionA', seniorCount: 1 });
    const b = await seedHousehold({ marker: 'UnionB', seniorCount: 1 });
    const dualUserId = `user_${randomBytes(8).toString('hex')}`;
    await addMembership({ householdId: a.householdId, userId: dualUserId });
    await addMembership({ householdId: b.householdId, userId: dualUserId });

    // The token's tenantScope frame points at A only — the directory
    // must still return both households' seniors, because membership
    // rows (not the frame) are the row-level filter. This pins the
    // documented `proceed_scoped` contract: the enforce-mode gate
    // requires a frame to be PRESENT but does not auto-restrict the
    // query to the frame's household.
    const response = await callJson({
      method: 'GET',
      path: '/api/v1/me/seniors',
      token: signAccessToken({ userId: dualUserId, householdId: a.householdId }),
    });
    expect(response.status).toBe(200);

    const body = response.body as MySeniorsResponse;
    const households = new Set(body.seniors.map((s) => s.householdId));
    expect(households).toEqual(new Set([a.householdId, b.householdId]));
    expect(body.seniors).toHaveLength(2);
  });

  it('a user with no memberships gets the documented empty list, not a 403', async () => {
    const strangerUserId = `user_${randomBytes(8).toString('hex')}`;
    // Identity would scope a family token to whatever household the
    // user belongs to; a stranger's frame points at a household id
    // that simply has no membership row for them.
    const response = await callJson({
      method: 'GET',
      path: '/api/v1/me/seniors',
      token: signAccessToken({
        userId: strangerUserId,
        householdId: `hh_${randomBytes(8).toString('hex')}`,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ seniors: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Block 2 — cross-household probes (member of A probing B)
// ─────────────────────────────────────────────────────────────────────

describe('cross-household probes are refused (member of A probing household B)', () => {
  it("emergency contacts: A's member lists A (200, only A's rows) and is 403 on B", async () => {
    const a = await seedHousehold({ marker: 'EcA', seniorCount: 1 });
    const b = await seedHousehold({ marker: 'EcB', seniorCount: 1 });
    await populateSurfaces(a, 'EcA');
    await populateSurfaces(b, 'EcB');

    const own = await callJson({
      method: 'GET',
      path: `/api/v1/households/${a.householdId}/emergency-contacts`,
      token: a.token,
    });
    expect(own.status).toBe(200);
    const ownBody = own.body as EmergencyContactsListResponse;
    expect(ownBody.contacts).toHaveLength(1);
    expect(ownBody.contacts.map((c) => c.name)).toEqual(['EcAContact']);
    expect(JSON.stringify(ownBody)).not.toContain('EcB');

    const probe = await callJson({
      method: 'GET',
      path: `/api/v1/households/${b.householdId}/emergency-contacts`,
      token: a.token,
    });
    expectForbiddenWithoutLeak(probe, 'EcB');
  });

  it("access-instructions: A's member reads A (200) and is 403 on B with no plaintext leak", async () => {
    const a = await seedHousehold({ marker: 'AiA', seniorCount: 1 });
    const b = await seedHousehold({ marker: 'AiB', seniorCount: 1 });
    await populateSurfaces(a, 'AiA');
    await populateSurfaces(b, 'AiB');

    const own = await callJson({
      method: 'GET',
      path: `/api/v1/households/${a.householdId}/access-instructions`,
      token: a.token,
    });
    expect(own.status).toBe(200);
    const ownBody = own.body as HouseholdAccessInstructionsResponse;
    expect(ownBody.householdId).toBe(a.householdId);
    expect(ownBody.doorCode).toBe('AiACode');
    expect(JSON.stringify(ownBody)).not.toContain('AiB');

    // The probe target holds DECRYPTED door/alarm data on the 200 path
    // — the 403 must fire before the decrypt and echo none of it.
    const probe = await callJson({
      method: 'GET',
      path: `/api/v1/households/${b.householdId}/access-instructions`,
      token: a.token,
    });
    expectForbiddenWithoutLeak(probe, 'AiB');
  });

  it("memory recipes: A's member lists A's senior (200, only A's rows) and is 403 on B's senior", async () => {
    const a = await seedHousehold({ marker: 'MrA', seniorCount: 1 });
    const b = await seedHousehold({ marker: 'MrB', seniorCount: 1 });
    await populateSurfaces(a, 'MrA');
    await populateSurfaces(b, 'MrB');
    const aSeniorId = a.seniorIds[0];
    const bSeniorId = b.seniorIds[0];
    if (aSeniorId === undefined || bSeniorId === undefined) {
      throw new Error('seedHousehold must return the seeded senior ids');
    }

    const own = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${aSeniorId}/memory-recipes`,
      token: a.token,
    });
    expect(own.status).toBe(200);
    const ownBody = own.body as MemoryRecipesListResponse;
    expect(ownBody.recipes.map((r) => r.title)).toEqual(['MrARecipe']);
    expect(JSON.stringify(ownBody)).not.toContain('MrB');

    const probe = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${bSeniorId}/memory-recipes`,
      token: a.token,
    });
    expectForbiddenWithoutLeak(probe, 'MrB');
  });

  it("senior preferences: A's member lists A's senior (200, only A's rows) and is 403 on B's senior", async () => {
    const a = await seedHousehold({ marker: 'SpA', seniorCount: 1 });
    const b = await seedHousehold({ marker: 'SpB', seniorCount: 1 });
    await populateSurfaces(a, 'SpA');
    await populateSurfaces(b, 'SpB');
    const aSeniorId = a.seniorIds[0];
    const bSeniorId = b.seniorIds[0];
    if (aSeniorId === undefined || bSeniorId === undefined) {
      throw new Error('seedHousehold must return the seeded senior ids');
    }

    const own = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${aSeniorId}/preferences`,
      token: a.token,
    });
    expect(own.status).toBe(200);
    const ownBody = own.body as SeniorPreferencesResponse;
    expect(ownBody.seniorId).toBe(aSeniorId);
    expect(ownBody.preferences.map((p) => p.value)).toEqual(['SpAPaella']);
    expect(JSON.stringify(ownBody)).not.toContain('SpB');

    const probe = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${bSeniorId}/preferences`,
      token: a.token,
    });
    expectForbiddenWithoutLeak(probe, 'SpB');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Block 3 — enforce-mode proof
// ─────────────────────────────────────────────────────────────────────

describe('tenant-scope gate enforce mode', () => {
  it('the DI-managed Prisma client blocks queries issued outside any request frame', async () => {
    // `app.get(PrismaService)` resolves the `wrapWithTenantScope`
    // Proxy the production request path uses. Outside a request there
    // is no AsyncLocalStorage frame, and service-household boots the
    // gate with `enforcement: 'enforce'` + an empty unscoped-models
    // list — so the extension must reject rather than run the query
    // unscoped. This is the "context-less access is blocked" half of
    // CLAUDE.md §3.2 that the HTTP tests above cannot reach (every
    // HTTP request passes through the TenantContextInterceptor and
    // always has a frame).
    const scopedPrisma = app.get(PrismaService);
    await expect(scopedPrisma.household.findMany({ select: { id: true } })).rejects.toBeInstanceOf(
      MissingRequestContextError,
    );
  });
});
