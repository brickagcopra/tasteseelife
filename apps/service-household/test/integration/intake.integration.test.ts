/**
 * TS-031-followup-5 — end-to-end senior intake integration.
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the intake surface over HTTP — proving the
 * wire contract from the controller boundary down to the AES-256-GCM
 * cipher boundary and the Postgres `BYTEA` columns (CLAUDE.md §3 /
 * §17.1; PDD §21.3 / §24.1).
 *
 * Scope:
 *
 *   1. **PUT round-trip** — full intake payload persists, the BYTEA
 *      columns hold actual ciphertext (not the JSON-stringified
 *      plaintext — verified by searching the raw bytes for the
 *      original DOB / notes strings), the cipher metadata columns
 *      (IV 12 bytes, auth-tag 16 bytes, key_version) are populated,
 *      and the round-trip GET returns the original plaintext back.
 *      Operational tag arrays land as Postgres `TEXT[]` cleartext.
 *
 *   2. **Empty intake semantics** — a wire payload of `{}` (Zod parses
 *      into operational defaults + null sensitive fields) writes
 *      `NULL` to every BYTEA column AND leaves `intake_completed_at`
 *      null. The family-dashboard nudge ("still needed") relies on
 *      this distinction.
 *
 *   3. **Operational-only completion stamp** — a payload with just
 *      tags / mobility / dementia (no encrypted notes, no DOB) still
 *      stamps `intake_completed_at`. The cipher columns remain
 *      `NULL` because there is no sensitive payload.
 *
 *   4. **Row-level authorisation** — a token whose `userId` does not
 *      hold an active `HouseholdMember` row for the senior's
 *      household gets 403. A soft-deleted senior gets 404. An
 *      unknown senior id gets 404.
 *
 * Why the real `AppModule`, not a hand-rolled test module? The unit
 * tests (`intake.service.test.ts`) already mock the persistence and
 * cipher layers. The integration gap is wire-level: Prisma's `BYTEA`
 * marshalling against the Node `Buffer` boundary, the `JSON.stringify`
 * → `Buffer.from(...,'utf8')` → AES-256-GCM → Postgres → `Buffer` →
 * `JSON.parse` chain, and the tenant-scope gate (CLAUDE.md §3.2) in
 * `enforce` mode. Those only fail when every layer is present.
 *
 * Why not supertest? The library is not on CLAUDE.md §13's approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency. Mirrors the
 * canonical shape established by
 * `apps/service-identity/test/integration/auth.integration.test.ts`.
 *
 * References: PDD §24.1; CLAUDE.md §3.2, §3.3, §9.1, §17.1; TS-009e
 * canonical test in
 * `apps/service-identity/test/integration/auth.integration.test.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { SeniorIntake, SeniorIntakeResponse } from '@taste-and-see/contracts';
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
 * purposes: (1) seeding a `Household` + `HouseholdMember` + `Senior`
 * row triplet for each test (in the absence of service-side seed HTTP
 * endpoints — household / senior management lands with TS-121 web-family,
 * not the bounded context under test here), and (2) reading the raw
 * `BYTEA` columns to assert the ciphertext is non-cleartext. The harness
 * Prisma is a SEPARATE process-local client constructed via
 * `new PrismaService({ datasourceUrl })` and never goes through the
 * DI-managed `wrapWithTenantScope` Proxy — so test setup writes
 * deliberately bypass the tenant-scope gate (the production code path
 * is what the HTTP tests below exercise via the real `AppModule`).
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The shared Redis
  // URL is read directly from the globalSetup-provided value.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'household_test_intake',
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
  // rows and to read raw BYTEA columns. Separate process-local client
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

interface IntakeResponse {
  readonly status: number;
  readonly body: unknown;
}

async function callJson(args: {
  readonly method: 'GET' | 'PUT';
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}): Promise<IntakeResponse> {
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
 * the AppModule was booted with. The payload shape mirrors
 * `auth-sdk`'s `AccessTokenPayloadSchema` (sub / sid / mfa / roles /
 * tenantScope). The `tenantScope` is the `householdId` claim the
 * `TenantContextInterceptor` will seed into the Prisma extension's
 * frame — for service-household, every model lives under the
 * household scope.
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
 * A canonical full-payload intake used by the round-trip test. The
 * sensitive fields are deliberately distinctive ASCII so the
 * non-cleartext BYTEA assertion can search for them verbatim.
 */
const FULL_INTAKE: SeniorIntake = {
  dateOfBirth: '1948-03-14',
  dementiaStatus: 'mild_cognitive_impairment',
  mobilityLevel: 'aided_cane',
  languageTags: ['en-US', 'pl-PL'],
  dietaryTags: ['low_sodium', 'soft_textures'],
  allergenTags: ['shellfish', 'tree_nut'],
  dietaryNotes: 'Prefers warm soups; dinner before 6pm.',
  allergyNotes: 'Anaphylaxis on cashew diagnosed 2014; carries EpiPen.',
  mobilityNotes: 'Cane for stairs; steady on flat ground.',
  medicalNotes: 'Cardiologist follow-up at Mount Sinai every six months.',
};

/**
 * Marker substrings the cipher MUST NOT leak verbatim into the BYTEA
 * ciphertext. AES-256-GCM transforms the plaintext into pseudorandom
 * bytes — any byte-for-byte match would indicate the encrypt path
 * silently degraded to a passthrough.
 */
const PLAINTEXT_MARKERS = ['1948-03-14', 'EpiPen', 'Mount Sinai', 'Anaphylaxis', 'warm soups'];

function assertCiphertextOpaque(buffer: Buffer): void {
  const text = buffer.toString('binary');
  for (const marker of PLAINTEXT_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('intake HTTP round-trip against real Postgres', () => {
  it('PUT persists encrypted payload + GET decrypts it back unchanged', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const put = await callJson({
      method: 'PUT',
      path: `/api/v1/seniors/${seniorId}/intake`,
      token,
      body: FULL_INTAKE,
      idempotencyKey: `intake-put-${randomBytes(8).toString('hex')}`,
    });
    expect(put.status).toBe(200);

    const putBody = put.body as SeniorIntakeResponse;
    expect(putBody.seniorId).toBe(seniorId);
    expect(putBody.dateOfBirth).toBe(FULL_INTAKE.dateOfBirth);
    expect(putBody.dietaryNotes).toBe(FULL_INTAKE.dietaryNotes);
    expect(putBody.allergyNotes).toBe(FULL_INTAKE.allergyNotes);
    expect(putBody.mobilityNotes).toBe(FULL_INTAKE.mobilityNotes);
    expect(putBody.medicalNotes).toBe(FULL_INTAKE.medicalNotes);
    expect(putBody.dementiaStatus).toBe(FULL_INTAKE.dementiaStatus);
    expect(putBody.mobilityLevel).toBe(FULL_INTAKE.mobilityLevel);
    expect(putBody.languageTags).toEqual(FULL_INTAKE.languageTags);
    expect(putBody.dietaryTags).toEqual(FULL_INTAKE.dietaryTags);
    expect(putBody.allergenTags).toEqual(FULL_INTAKE.allergenTags);
    expect(putBody.intakeCompletedAt).not.toBeNull();
    expect(typeof putBody.updatedAt).toBe('string');

    // Read the raw row to prove the cipher boundary actually sits at
    // the Postgres write — the BYTEA columns must hold pseudorandom
    // bytes, NOT the JSON-stringified plaintext.
    const row = await harnessPrisma.senior.findUniqueOrThrow({
      where: { id: seniorId },
      select: {
        languageTags: true,
        dietaryTags: true,
        allergenTags: true,
        mobilityLevel: true,
        dementiaStatus: true,
        intakePayloadCiphertext: true,
        intakePayloadIv: true,
        intakePayloadAuthTag: true,
        intakePayloadKeyVersion: true,
        intakeCompletedAt: true,
      },
    });

    // Operational columns: plain Postgres TEXT[] / enum values. The
    // chef-match query (PDD §8.5 / §14.1) reads them directly without
    // decrypting, so cleartext at rest is the deliberate shape.
    expect(row.languageTags).toEqual(FULL_INTAKE.languageTags);
    expect(row.dietaryTags).toEqual(FULL_INTAKE.dietaryTags);
    expect(row.allergenTags).toEqual(FULL_INTAKE.allergenTags);
    expect(row.mobilityLevel).toBe('aided_cane');
    expect(row.dementiaStatus).toBe('mild_cognitive_impairment');

    // Cipher metadata: 12-byte GCM IV, 16-byte GCM auth tag, key
    // version pinned to the env default (1). Any drift here would
    // mean the cipher service's contract changed without the
    // migration / env schema catching it.
    expect(row.intakePayloadCiphertext).toBeInstanceOf(Buffer);
    expect(row.intakePayloadIv).toBeInstanceOf(Buffer);
    expect(row.intakePayloadAuthTag).toBeInstanceOf(Buffer);
    expect(row.intakePayloadIv?.length).toBe(12);
    expect(row.intakePayloadAuthTag?.length).toBe(16);
    expect(row.intakePayloadKeyVersion).toBe(1);
    expect(row.intakeCompletedAt).not.toBeNull();

    // The load-bearing assertion: NONE of the distinctive plaintext
    // markers may appear in the ciphertext. AES-256-GCM produces
    // pseudorandom bytes — a substring match would mean the encrypt
    // path silently degraded to a passthrough or the column was
    // written from a different code path.
    assertCiphertextOpaque(row.intakePayloadCiphertext as Buffer);

    // GET round-trip — the cipher service decrypts the BYTEA back to
    // the original plaintext, the service maps it onto the response
    // DTO, and every field comes back identical.
    const get = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/intake`,
      token,
    });
    expect(get.status).toBe(200);
    const getBody = get.body as SeniorIntakeResponse;
    expect(getBody.seniorId).toBe(seniorId);
    expect(getBody.dateOfBirth).toBe(FULL_INTAKE.dateOfBirth);
    expect(getBody.dietaryNotes).toBe(FULL_INTAKE.dietaryNotes);
    expect(getBody.allergyNotes).toBe(FULL_INTAKE.allergyNotes);
    expect(getBody.mobilityNotes).toBe(FULL_INTAKE.mobilityNotes);
    expect(getBody.medicalNotes).toBe(FULL_INTAKE.medicalNotes);
    expect(getBody.dementiaStatus).toBe(FULL_INTAKE.dementiaStatus);
    expect(getBody.mobilityLevel).toBe(FULL_INTAKE.mobilityLevel);
    expect(getBody.languageTags).toEqual(FULL_INTAKE.languageTags);
    expect(getBody.dietaryTags).toEqual(FULL_INTAKE.dietaryTags);
    expect(getBody.allergenTags).toEqual(FULL_INTAKE.allergenTags);
    expect(getBody.intakeCompletedAt).toBe(putBody.intakeCompletedAt);
  });

  it('PUT with an empty payload leaves ciphertext columns null and intake_completed_at null', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // `{}` parses via Zod to operational defaults (`unknown` mobility,
    // `none` dementia, empty tag arrays) and absent sensitive fields.
    // The service treats this as "no meaningful intake yet" — no
    // ciphertext write, no completion stamp.
    const put = await callJson({
      method: 'PUT',
      path: `/api/v1/seniors/${seniorId}/intake`,
      token,
      body: {},
    });
    expect(put.status).toBe(200);
    const putBody = put.body as SeniorIntakeResponse;
    expect(putBody.intakeCompletedAt).toBeNull();
    expect(putBody.dateOfBirth).toBeNull();
    expect(putBody.dietaryNotes).toBeNull();

    const row = await harnessPrisma.senior.findUniqueOrThrow({
      where: { id: seniorId },
      select: {
        intakePayloadCiphertext: true,
        intakePayloadIv: true,
        intakePayloadAuthTag: true,
        intakePayloadKeyVersion: true,
        intakeCompletedAt: true,
      },
    });
    expect(row.intakePayloadCiphertext).toBeNull();
    expect(row.intakePayloadIv).toBeNull();
    expect(row.intakePayloadAuthTag).toBeNull();
    expect(row.intakePayloadKeyVersion).toBeNull();
    expect(row.intakeCompletedAt).toBeNull();
  });

  it('PUT with operational-only payload stamps intake_completed_at but leaves ciphertext null', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Tags + mobility = "the family has expressed a meaningful
    // operational preference" → completion stamp lands. No sensitive
    // notes / DOB → ciphertext columns stay null. The service-side
    // `hasOperational` helper is the gate.
    const put = await callJson({
      method: 'PUT',
      path: `/api/v1/seniors/${seniorId}/intake`,
      token,
      body: {
        languageTags: ['en-US'],
        dietaryTags: ['vegetarian'],
        mobilityLevel: 'independent',
      },
    });
    expect(put.status).toBe(200);
    const putBody = put.body as SeniorIntakeResponse;
    expect(putBody.intakeCompletedAt).not.toBeNull();
    expect(putBody.dateOfBirth).toBeNull();
    expect(putBody.dietaryNotes).toBeNull();

    const row = await harnessPrisma.senior.findUniqueOrThrow({
      where: { id: seniorId },
      select: {
        languageTags: true,
        dietaryTags: true,
        mobilityLevel: true,
        intakePayloadCiphertext: true,
        intakePayloadIv: true,
        intakePayloadAuthTag: true,
        intakePayloadKeyVersion: true,
        intakeCompletedAt: true,
      },
    });
    expect(row.languageTags).toEqual(['en-US']);
    expect(row.dietaryTags).toEqual(['vegetarian']);
    expect(row.mobilityLevel).toBe('independent');
    expect(row.intakePayloadCiphertext).toBeNull();
    expect(row.intakePayloadIv).toBeNull();
    expect(row.intakePayloadAuthTag).toBeNull();
    expect(row.intakePayloadKeyVersion).toBeNull();
    expect(row.intakeCompletedAt).not.toBeNull();
  });

  it('GET on a never-PUT senior returns the empty response shape', async () => {
    const { householdId, seniorId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const get = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/intake`,
      token,
    });
    expect(get.status).toBe(200);
    const body = get.body as SeniorIntakeResponse;
    expect(body.seniorId).toBe(seniorId);
    expect(body.dateOfBirth).toBeNull();
    expect(body.dietaryNotes).toBeNull();
    expect(body.allergyNotes).toBeNull();
    expect(body.mobilityNotes).toBeNull();
    expect(body.medicalNotes).toBeNull();
    expect(body.languageTags).toEqual([]);
    expect(body.dietaryTags).toEqual([]);
    expect(body.allergenTags).toEqual([]);
    expect(body.mobilityLevel).toBe('unknown');
    expect(body.dementiaStatus).toBe('none');
    expect(body.intakeCompletedAt).toBeNull();
  });
});

describe('intake row-level authorisation', () => {
  it('returns 403 when the requester is not a member of the senior’s household', async () => {
    const { householdId, seniorId } = await seedHousehold();
    // Mint a token for a userId that has no `HouseholdMember` row.
    // CLAUDE.md §3.2 row-level check: authenticated but not authorised.
    // Note: the access-token `tenantScope` is set to the senior's
    // household (an attacker could forge any scope they want once
    // they hold a valid token) — the service's membership check is
    // the actual guard, not the claim.
    const attackerToken = signAccessToken({
      userId: `attacker_${randomBytes(8).toString('hex')}`,
      householdId,
    });

    const get = await callJson({
      method: 'GET',
      path: `/api/v1/seniors/${seniorId}/intake`,
      token: attackerToken,
    });
    expect(get.status).toBe(403);
    const body = get.body as { title?: string; status?: number };
    expect(body.title).toBe('Forbidden');
    expect(body.status).toBe(403);

    const put = await callJson({
      method: 'PUT',
      path: `/api/v1/seniors/${seniorId}/intake`,
      token: attackerToken,
      body: FULL_INTAKE,
    });
    expect(put.status).toBe(403);

    // Defence-in-depth: the senior row stays clean. A 403 must not
    // leave a half-written intake (the membership check fires before
    // the encrypt path).
    const row = await harnessPrisma.senior.findUniqueOrThrow({
      where: { id: seniorId },
      select: { intakePayloadCiphertext: true, intakeCompletedAt: true },
    });
    expect(row.intakePayloadCiphertext).toBeNull();
    expect(row.intakeCompletedAt).toBeNull();
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
      path: `/api/v1/seniors/${seniorId}/intake`,
      token,
    });
    expect(get.status).toBe(404);
    const body = get.body as { title?: string; status?: number };
    expect(body.title).toBe('Not Found');
    expect(body.status).toBe(404);
  });

  it('returns 404 for an unknown senior id', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const get = await callJson({
      method: 'GET',
      // CUID-shaped value that won't collide with any seeded id.
      path: '/api/v1/seniors/clz_does_not_exist_0000000000000/intake',
      token,
    });
    expect(get.status).toBe(404);
  });
});
