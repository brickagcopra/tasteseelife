/**
 * TS-032-followup-4 — end-to-end emergency-contacts + access-instructions integration.
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and exercises both household surfaces over HTTP — proving
 * the wire contract from the controller boundary down to the AES-256-GCM
 * cipher boundary, the BYTEA columns, AND the composite-index ordering
 * that `emergency_contacts_household_active_idx` (priority ASC, then
 * createdAt ASC) was sized for (CLAUDE.md §3 / §4.1 / §17.1; PDD §21.3 /
 * §24.1).
 *
 * Why the real `AppModule`, not a hand-rolled test module? The unit
 * tests (`household-access.service.test.ts`, `emergency-contacts.service.test.ts`)
 * already mock the persistence and cipher layers. The integration gap
 * is wire-level: Prisma's `BYTEA` marshalling against the Node `Buffer`
 * boundary, the `JSON.stringify` → `Buffer.from(...,'utf8')` →
 * AES-256-GCM → Postgres → `Buffer` → `JSON.parse` chain for
 * access-instructions, Postgres' real ordering semantics on the
 * composite priority/createdAt index for emergency contacts, and the
 * tenant-scope gate in `enforce` mode (CLAUDE.md §3.2). Those only fail
 * when every layer is present.
 *
 * Scope:
 *
 *   Block 1 — `'household access-instructions HTTP round-trip ...'` (4 tests):
 *     1. PUT full payload → BYTEA columns hold actual ciphertext (not
 *        the JSON-stringified plaintext — verified by searching the raw
 *        bytes for the original door-code / alarm / parking strings),
 *        the cipher metadata columns (IV 12 bytes, auth-tag 16 bytes,
 *        keyVersion=1) are populated, `accessInstructionsUpdatedAt`
 *        non-null, and the round-trip GET returns the original plaintext
 *        field-for-field identical.
 *     2. PUT empty `{}` AFTER a non-empty PUT clears the four BYTEA
 *        columns AND `accessInstructionsUpdatedAt`. The "clear blob =
 *        clear timestamp" rule is the deliberate divergence from the
 *        intake-form "once stamped, never cleared" rule (see
 *        `HouseholdAccessService` header).
 *     3. GET on a never-PUT household returns the empty response shape
 *        — every field null + `accessInstructionsUpdatedAt` null.
 *     4. Cipher non-determinism — two PUTs of the same plaintext produce
 *        DIFFERENT ciphertext + IV bytes. AES-256-GCM with a random IV
 *        per call is the contract; a regression that re-used the IV
 *        would silently produce a deterministic mapping.
 *
 *   Block 2 — `'emergency contacts HTTP CRUD against real Postgres'` (4 tests):
 *     1. Full lifecycle — POST 10 contacts (priorities 1..10) → POST
 *        11th returns 422 with the cap-message → DELETE the 5th → POST
 *        an 11th returns 201 + the cap holds at 10 → GET list returns
 *        10 in priority-then-createdAt order.
 *     2. Composite-index ordering — POST 4 contacts with overlapping
 *        priorities (5, 1, 5, 3 in insertion order) → GET list returns
 *        them as [priority=1, priority=3, priority=5 oldest, priority=5
 *        newest]. The `emergency_contacts_household_active_idx`
 *        composite index makes this an index-only scan; the test pins
 *        the tie-break semantics against real Postgres ordering.
 *     3. PATCH happy path + empty-body rejection — PATCH one field →
 *        200 + read-back reflects the change; PATCH `{}` → 400.
 *     4. DELETE idempotency — first DELETE returns 204 + the row is
 *        soft-deleted (`deletedAt != null`, NOT hard-deleted); second
 *        DELETE on the same id still returns 204 (the service short-
 *        circuits when `deletedAt` is already set).
 *
 *   Block 3 — `'row-level authorisation'` (3 tests):
 *     5. 403 when the caller has no active `HouseholdMember` row.
 *        Defence-in-depth: the household + contacts stay clean on the
 *        403 path (no half-write — the membership check fires before
 *        the encrypt path for access-instructions, before the cap
 *        check for emergency contacts).
 *     6. 404 for a soft-deleted household (access-instructions).
 *     7. 404 for a missing contact id (emergency contacts).
 *
 * Why not supertest? The library is not on CLAUDE.md §13's approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency. Mirrors the
 * canonical shape established by `intake.integration.test.ts`.
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
  CreateEmergencyContactRequest,
  EmergencyContact,
  EmergencyContactsListResponse,
  HouseholdAccessInstructions,
  HouseholdAccessInstructionsResponse,
  UpdateEmergencyContactRequest,
} from '@taste-and-see/contracts';
import { EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD } from '@taste-and-see/contracts';
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
 * purposes: (1) seeding a `Household` + `HouseholdMember` triplet for
 * each test (in the absence of service-side seed HTTP endpoints —
 * household management lands with TS-121 web-family, not the bounded
 * context under test here), and (2) reading the raw `BYTEA` columns +
 * `deletedAt` tombstones to assert the storage invariants. The harness
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
  // URL is read directly from the globalSetup-provided value. The
  // database name is per-file unique so a sibling integration test in
  // the same suite cannot collide on row state.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'household_test_ec_access',
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

  // Harness-only Prisma client. Used solely to seed household rows and
  // to read raw BYTEA columns / deletedAt tombstones. Separate process-
  // local client from the DI-managed one inside Nest — no DI overlap,
  // no shared pool.
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
  return `ec-access-${randomBytes(8).toString('hex')}`;
}

/**
 * Seed a household + primary-payer membership into the test database.
 * Returns the two ids the test then drives via the HTTP surface. The
 * harness Prisma bypasses the tenant-scope gate (it is constructed
 * directly, not through DI), so the seed runs unscoped — production
 * seeding is a separate concern owned by the household-creation flow
 * (TS-121).
 */
async function seedHousehold(): Promise<{
  readonly householdId: string;
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
  return { householdId: household.id, payerUserId };
}

/**
 * A canonical full-payload access-instructions request used by the
 * round-trip test. The string values are deliberately distinctive
 * ASCII tokens so the ciphertext-opaqueness assertion can search for
 * them verbatim in the raw BYTEA bytes — AES-256-GCM produces
 * pseudorandom bytes, so a substring match in latin1-encoded raw bytes
 * would indicate the encrypt path silently degraded to a passthrough
 * or the BYTEA column was written from a different code path.
 */
const FULL_ACCESS_INSTRUCTIONS: HouseholdAccessInstructions = {
  doorCode: '8472#9013',
  keyLocation: 'Lockbox left of front door, combo 3344',
  alarmCode: 'Disarm-9999',
  alarmDisarmInstructions: 'Press OFF then 9999 within 30 seconds.',
  parkingInstructions: 'Garage P3, guest spot 47. Tell attendant Marek visit.',
  doormanInfo: 'Doorman Carlos until 11pm; nightshift Pietr after.',
  petInfo: 'Cat named Pepper — keep indoors; do not feed table scraps.',
  generalNotes: 'Wheelchair ramp at side entrance.',
};

/**
 * Distinctive plaintext markers the cipher MUST NOT leak verbatim
 * into the BYTEA ciphertext. A substring match in latin1-encoded
 * random bytes is vanishingly improbable (256^-N per position) unless
 * the encrypt path silently degraded to a passthrough.
 */
const PLAINTEXT_MARKERS = ['8472#9013', 'Lockbox', 'Disarm-9999', 'Carlos', 'Pepper', 'Wheelchair'];

function assertCiphertextOpaque(buffer: Buffer): void {
  const text = buffer.toString('binary');
  for (const marker of PLAINTEXT_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

/**
 * Helper used by the contacts CRUD tests to build a valid create
 * payload. Keeps the test bodies focused on what's actually being
 * asserted rather than re-stating the contract shape on every line.
 */
function buildContactPayload(args: {
  readonly name: string;
  readonly priority: number;
  readonly email?: string | null;
  readonly notes?: string | null;
}): CreateEmergencyContactRequest {
  const payload: CreateEmergencyContactRequest = {
    name: args.name,
    relationship: 'Adult child',
    phone: '+14155550100',
    priority: args.priority,
  };
  if (args.email !== undefined) {
    return { ...payload, email: args.email };
  }
  if (args.notes !== undefined) {
    return { ...payload, notes: args.notes };
  }
  return payload;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('household access-instructions HTTP round-trip against real Postgres', () => {
  it('PUT persists encrypted payload + GET decrypts it back unchanged', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const put = await callJson({
      method: 'PUT',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
      body: FULL_ACCESS_INSTRUCTIONS,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(put.status).toBe(200);

    const putBody = put.body as HouseholdAccessInstructionsResponse;
    expect(putBody.householdId).toBe(householdId);
    expect(putBody.doorCode).toBe(FULL_ACCESS_INSTRUCTIONS.doorCode);
    expect(putBody.keyLocation).toBe(FULL_ACCESS_INSTRUCTIONS.keyLocation);
    expect(putBody.alarmCode).toBe(FULL_ACCESS_INSTRUCTIONS.alarmCode);
    expect(putBody.alarmDisarmInstructions).toBe(FULL_ACCESS_INSTRUCTIONS.alarmDisarmInstructions);
    expect(putBody.parkingInstructions).toBe(FULL_ACCESS_INSTRUCTIONS.parkingInstructions);
    expect(putBody.doormanInfo).toBe(FULL_ACCESS_INSTRUCTIONS.doormanInfo);
    expect(putBody.petInfo).toBe(FULL_ACCESS_INSTRUCTIONS.petInfo);
    expect(putBody.generalNotes).toBe(FULL_ACCESS_INSTRUCTIONS.generalNotes);
    expect(putBody.accessInstructionsUpdatedAt).not.toBeNull();
    expect(typeof putBody.updatedAt).toBe('string');

    // Read the raw row to prove the cipher boundary actually sits at
    // the Postgres write — the BYTEA columns must hold pseudorandom
    // bytes, NOT the JSON-stringified plaintext.
    const row = await harnessPrisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        accessInstructionsCiphertext: true,
        accessInstructionsIv: true,
        accessInstructionsAuthTag: true,
        accessInstructionsKeyVersion: true,
        accessInstructionsUpdatedAt: true,
      },
    });

    // Cipher metadata: 12-byte GCM IV, 16-byte GCM auth tag, key
    // version pinned to the env default (1). Any drift here would
    // mean the cipher service's contract changed without the
    // migration / env schema catching it.
    expect(row.accessInstructionsCiphertext).toBeInstanceOf(Buffer);
    expect(row.accessInstructionsIv).toBeInstanceOf(Buffer);
    expect(row.accessInstructionsAuthTag).toBeInstanceOf(Buffer);
    expect(row.accessInstructionsIv?.length).toBe(12);
    expect(row.accessInstructionsAuthTag?.length).toBe(16);
    expect(row.accessInstructionsKeyVersion).toBe(1);
    expect(row.accessInstructionsUpdatedAt).not.toBeNull();

    // The load-bearing assertion: NONE of the distinctive plaintext
    // markers may appear in the ciphertext bytes. AES-256-GCM
    // produces pseudorandom bytes — a substring match would mean the
    // encrypt path silently degraded to a passthrough or the column
    // was written from a different code path.
    assertCiphertextOpaque(row.accessInstructionsCiphertext as Buffer);

    // GET round-trip — the cipher service decrypts the BYTEA back to
    // the original plaintext, the service maps it onto the response
    // DTO, and every field comes back identical.
    const get = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
    });
    expect(get.status).toBe(200);
    const getBody = get.body as HouseholdAccessInstructionsResponse;
    expect(getBody.householdId).toBe(householdId);
    expect(getBody.doorCode).toBe(FULL_ACCESS_INSTRUCTIONS.doorCode);
    expect(getBody.keyLocation).toBe(FULL_ACCESS_INSTRUCTIONS.keyLocation);
    expect(getBody.alarmCode).toBe(FULL_ACCESS_INSTRUCTIONS.alarmCode);
    expect(getBody.alarmDisarmInstructions).toBe(FULL_ACCESS_INSTRUCTIONS.alarmDisarmInstructions);
    expect(getBody.parkingInstructions).toBe(FULL_ACCESS_INSTRUCTIONS.parkingInstructions);
    expect(getBody.doormanInfo).toBe(FULL_ACCESS_INSTRUCTIONS.doormanInfo);
    expect(getBody.petInfo).toBe(FULL_ACCESS_INSTRUCTIONS.petInfo);
    expect(getBody.generalNotes).toBe(FULL_ACCESS_INSTRUCTIONS.generalNotes);
    expect(getBody.accessInstructionsUpdatedAt).toBe(putBody.accessInstructionsUpdatedAt);
  });

  it('PUT empty after a non-empty PUT clears ciphertext columns AND accessInstructionsUpdatedAt', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // First, land a non-empty payload — the timestamp + ciphertext
    // columns are populated.
    const seed = await callJson({
      method: 'PUT',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
      body: FULL_ACCESS_INSTRUCTIONS,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(seed.status).toBe(200);

    const seedRow = await harnessPrisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        accessInstructionsCiphertext: true,
        accessInstructionsUpdatedAt: true,
      },
    });
    expect(seedRow.accessInstructionsCiphertext).not.toBeNull();
    expect(seedRow.accessInstructionsUpdatedAt).not.toBeNull();

    // Now PUT an empty payload. The service treats this as "the
    // family no longer wants these instructions on file" — distinct
    // from intake's "once stamped, never cleared" rule.
    const clear = await callJson({
      method: 'PUT',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
      body: {},
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(clear.status).toBe(200);
    const clearBody = clear.body as HouseholdAccessInstructionsResponse;
    expect(clearBody.doorCode).toBeNull();
    expect(clearBody.keyLocation).toBeNull();
    expect(clearBody.alarmCode).toBeNull();
    expect(clearBody.alarmDisarmInstructions).toBeNull();
    expect(clearBody.parkingInstructions).toBeNull();
    expect(clearBody.doormanInfo).toBeNull();
    expect(clearBody.petInfo).toBeNull();
    expect(clearBody.generalNotes).toBeNull();
    expect(clearBody.accessInstructionsUpdatedAt).toBeNull();

    const clearedRow = await harnessPrisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        accessInstructionsCiphertext: true,
        accessInstructionsIv: true,
        accessInstructionsAuthTag: true,
        accessInstructionsKeyVersion: true,
        accessInstructionsUpdatedAt: true,
      },
    });
    expect(clearedRow.accessInstructionsCiphertext).toBeNull();
    expect(clearedRow.accessInstructionsIv).toBeNull();
    expect(clearedRow.accessInstructionsAuthTag).toBeNull();
    expect(clearedRow.accessInstructionsKeyVersion).toBeNull();
    expect(clearedRow.accessInstructionsUpdatedAt).toBeNull();
  });

  it('GET on a never-PUT household returns the empty response shape', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const get = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
    });
    expect(get.status).toBe(200);
    const body = get.body as HouseholdAccessInstructionsResponse;
    expect(body.householdId).toBe(householdId);
    expect(body.doorCode).toBeNull();
    expect(body.keyLocation).toBeNull();
    expect(body.alarmCode).toBeNull();
    expect(body.alarmDisarmInstructions).toBeNull();
    expect(body.parkingInstructions).toBeNull();
    expect(body.doormanInfo).toBeNull();
    expect(body.petInfo).toBeNull();
    expect(body.generalNotes).toBeNull();
    expect(body.accessInstructionsUpdatedAt).toBeNull();
  });

  it('AES-256-GCM is non-deterministic — two PUTs of identical plaintext produce different ciphertext + IV', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const first = await callJson({
      method: 'PUT',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
      body: FULL_ACCESS_INSTRUCTIONS,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(first.status).toBe(200);
    const firstRow = await harnessPrisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        accessInstructionsCiphertext: true,
        accessInstructionsIv: true,
        accessInstructionsAuthTag: true,
      },
    });
    const firstCiphertext = firstRow.accessInstructionsCiphertext as Buffer;
    const firstIv = firstRow.accessInstructionsIv as Buffer;
    const firstAuthTag = firstRow.accessInstructionsAuthTag as Buffer;

    // Second PUT with byte-identical plaintext. AES-256-GCM with a
    // random 96-bit IV per call must produce different IV bytes (the
    // contract — re-using an IV under the same key with GCM breaks
    // the cipher's confidentiality + integrity guarantees) and
    // therefore different ciphertext + auth tag.
    const second = await callJson({
      method: 'PUT',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
      body: FULL_ACCESS_INSTRUCTIONS,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(second.status).toBe(200);
    const secondRow = await harnessPrisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        accessInstructionsCiphertext: true,
        accessInstructionsIv: true,
        accessInstructionsAuthTag: true,
      },
    });
    const secondCiphertext = secondRow.accessInstructionsCiphertext as Buffer;
    const secondIv = secondRow.accessInstructionsIv as Buffer;
    const secondAuthTag = secondRow.accessInstructionsAuthTag as Buffer;

    expect(secondIv.equals(firstIv)).toBe(false);
    expect(secondCiphertext.equals(firstCiphertext)).toBe(false);
    expect(secondAuthTag.equals(firstAuthTag)).toBe(false);

    // And of course the GET round-trip still decrypts to the same
    // plaintext after the second write.
    const get = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
    });
    expect(get.status).toBe(200);
    const getBody = get.body as HouseholdAccessInstructionsResponse;
    expect(getBody.doorCode).toBe(FULL_ACCESS_INSTRUCTIONS.doorCode);
    expect(getBody.alarmCode).toBe(FULL_ACCESS_INSTRUCTIONS.alarmCode);
  });
});

describe('emergency contacts HTTP CRUD against real Postgres', () => {
  it('POST up to cap; 11th returns 422; soft-delete one then POST succeeds; cap holds at 10', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // POST exactly `EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD` contacts.
    // Priorities 1..10 in distinct positions so the order is fully
    // determined by `priority` (no createdAt tie-breaks under test
    // here — that's the next describe block).
    const created: EmergencyContact[] = [];
    for (let i = 1; i <= EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD; i++) {
      const post = await callJson({
        method: 'POST',
        path: `/api/v1/households/${householdId}/emergency-contacts`,
        token,
        body: buildContactPayload({ name: `Contact ${i}`, priority: i }),
        idempotencyKey: freshIdempotencyKey(),
      });
      expect(post.status).toBe(201);
      created.push(post.body as EmergencyContact);
    }
    expect(created).toHaveLength(EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD);

    // The 11th create must fail with the cap-422 contract. The
    // service-layer check fires BEFORE the insert, so the 422 path
    // does not leave an 11th row in the table — verified below.
    const overflow = await callJson({
      method: 'POST',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
      body: buildContactPayload({ name: 'Overflow', priority: 1 }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(overflow.status).toBe(422);
    const overflowBody = overflow.body as { title?: string; status?: number; detail?: string };
    expect(overflowBody.title).toBe('Unprocessable Entity');
    expect(overflowBody.status).toBe(422);
    expect(overflowBody.detail).toContain(
      `${EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD}-contact maximum`,
    );

    // Cap-422 must not have written a row. Active-count stays at 10.
    const preDeleteActive = await harnessPrisma.emergencyContact.count({
      where: { householdId, deletedAt: null },
    });
    expect(preDeleteActive).toBe(EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD);

    // Soft-delete one of the existing contacts. The DELETE endpoint
    // sets `deletedAt`; the row stays in the table. The cap-check
    // filters by `deletedAt: null`, so a freshly-vacated slot lets
    // the next POST through.
    const victim = created[4]!;
    const del = await callJson({
      method: 'DELETE',
      path: `/api/v1/households/${householdId}/emergency-contacts/${victim.id}`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(del.status).toBe(204);

    // Verify the soft-delete shape — `deletedAt` set, row still in
    // the table (not hard-deleted).
    const victimRow = await harnessPrisma.emergencyContact.findUniqueOrThrow({
      where: { id: victim.id },
      select: { id: true, deletedAt: true },
    });
    expect(victimRow.deletedAt).not.toBeNull();

    // POST after the vacated slot — must succeed with 201.
    const refill = await callJson({
      method: 'POST',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
      body: buildContactPayload({ name: 'Refill', priority: 5 }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(refill.status).toBe(201);

    // Active count is back at cap. The 11th still 422s.
    const postRefillActive = await harnessPrisma.emergencyContact.count({
      where: { householdId, deletedAt: null },
    });
    expect(postRefillActive).toBe(EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD);

    const overflowAgain = await callJson({
      method: 'POST',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
      body: buildContactPayload({ name: 'Overflow 2', priority: 1 }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(overflowAgain.status).toBe(422);

    // GET list returns exactly 10 active contacts in priority-then-
    // createdAt order. The soft-deleted row is filtered out.
    const list = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
    });
    expect(list.status).toBe(200);
    const listBody = list.body as EmergencyContactsListResponse;
    expect(listBody.contacts).toHaveLength(EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD);
    expect(listBody.contacts.map((c) => c.id)).not.toContain(victim.id);
    // Priorities must be ascending.
    const priorities = listBody.contacts.map((c) => c.priority);
    const sortedPriorities = [...priorities].sort((a, b) => a - b);
    expect(priorities).toEqual(sortedPriorities);
  });

  it('composite-index ordering: priority ASC then createdAt ASC for ties', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Insert four contacts with overlapping priorities in a specific
    // order so the test pins both axes of the composite index. The
    // expected output order is fully determined by `priority ASC,
    // createdAt ASC` — the index that powers the list endpoint
    // (`emergency_contacts_household_active_idx`).
    //
    // Insertion order: A(p=5), B(p=1), C(p=5), D(p=3)
    // Expected list:    B(p=1), D(p=3), A(p=5, older), C(p=5, newer)
    const insertNames = ['A', 'B', 'C', 'D'];
    const insertPriorities = [5, 1, 5, 3];
    const insertedIds: Record<string, string> = {};
    for (let i = 0; i < insertNames.length; i++) {
      const post = await callJson({
        method: 'POST',
        path: `/api/v1/households/${householdId}/emergency-contacts`,
        token,
        body: buildContactPayload({
          name: insertNames[i]!,
          priority: insertPriorities[i]!,
        }),
        idempotencyKey: freshIdempotencyKey(),
      });
      expect(post.status).toBe(201);
      const created = post.body as EmergencyContact;
      insertedIds[insertNames[i]!] = created.id;
    }

    const list = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
    });
    expect(list.status).toBe(200);
    const listBody = list.body as EmergencyContactsListResponse;
    expect(listBody.contacts).toHaveLength(4);
    expect(listBody.contacts.map((c) => c.name)).toEqual(['B', 'D', 'A', 'C']);
    expect(listBody.contacts.map((c) => c.priority)).toEqual([1, 3, 5, 5]);

    // The A → C tie-break must be createdAt ascending — A was
    // inserted before C, so A comes first under equal priority.
    const aIndex = listBody.contacts.findIndex((c) => c.name === 'A');
    const cIndex = listBody.contacts.findIndex((c) => c.name === 'C');
    expect(aIndex).toBeLessThan(cIndex);
    const aCreatedAt = Date.parse(listBody.contacts[aIndex]!.createdAt);
    const cCreatedAt = Date.parse(listBody.contacts[cIndex]!.createdAt);
    expect(aCreatedAt).toBeLessThanOrEqual(cCreatedAt);
  });

  it('PATCH updates editable fields; empty-body PATCH returns 400', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    // Seed a contact to mutate.
    const create = await callJson({
      method: 'POST',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
      body: buildContactPayload({ name: 'Original', priority: 2 }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(create.status).toBe(201);
    const contact = create.body as EmergencyContact;

    // Patch a couple of fields — name + priority. The other fields
    // are absent in the patch body and must survive untouched.
    const patchBody: UpdateEmergencyContactRequest = {
      name: 'Updated Name',
      priority: 1,
    };
    const patch = await callJson({
      method: 'PATCH',
      path: `/api/v1/households/${householdId}/emergency-contacts/${contact.id}`,
      token,
      body: patchBody,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(patch.status).toBe(200);
    const patched = patch.body as EmergencyContact;
    expect(patched.id).toBe(contact.id);
    expect(patched.name).toBe('Updated Name');
    expect(patched.priority).toBe(1);
    expect(patched.phone).toBe(contact.phone);
    expect(patched.relationship).toBe(contact.relationship);

    // Empty-body PATCH — the Zod schema accepts `{}` (every field
    // optional) but the service rejects it with 400.
    const emptyPatch = await callJson({
      method: 'PATCH',
      path: `/api/v1/households/${householdId}/emergency-contacts/${contact.id}`,
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
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const create = await callJson({
      method: 'POST',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
      body: buildContactPayload({ name: 'Doomed', priority: 1 }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(create.status).toBe(201);
    const contact = create.body as EmergencyContact;

    const first = await callJson({
      method: 'DELETE',
      path: `/api/v1/households/${householdId}/emergency-contacts/${contact.id}`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(first.status).toBe(204);

    const firstRow = await harnessPrisma.emergencyContact.findUniqueOrThrow({
      where: { id: contact.id },
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
      path: `/api/v1/households/${householdId}/emergency-contacts/${contact.id}`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(second.status).toBe(204);

    // The tombstone must be byte-identical — the second delete did NOT
    // rewrite `deletedAt`, the service's idempotent short-circuit fired.
    const secondRow = await harnessPrisma.emergencyContact.findUniqueOrThrow({
      where: { id: contact.id },
      select: { id: true, deletedAt: true },
    });
    expect(secondRow.deletedAt?.getTime()).toBe(firstTombstone?.getTime());

    // List endpoint filters out the soft-deleted row.
    const list = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token,
    });
    expect(list.status).toBe(200);
    const listBody = list.body as EmergencyContactsListResponse;
    expect(listBody.contacts).toHaveLength(0);
  });
});

describe('row-level authorisation', () => {
  it('returns 403 when the requester is not a member of the household', async () => {
    const { householdId } = await seedHousehold();
    // Mint a token for a userId that has no `HouseholdMember` row.
    // CLAUDE.md §3.2 row-level check: authenticated but not authorised.
    // Note: the access-token `tenantScope` is set to the senior's
    // household (an attacker could forge any scope they want once they
    // hold a valid token) — the service's membership check is the
    // actual guard, not the claim.
    const attackerToken = signAccessToken({
      userId: `attacker_${randomBytes(8).toString('hex')}`,
      householdId,
    });

    // Access-instructions PUT — 403.
    const putAccess = await callJson({
      method: 'PUT',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token: attackerToken,
      body: FULL_ACCESS_INSTRUCTIONS,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(putAccess.status).toBe(403);
    const putAccessBody = putAccess.body as { title?: string; status?: number };
    expect(putAccessBody.title).toBe('Forbidden');

    // Access-instructions GET — 403.
    const getAccess = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token: attackerToken,
    });
    expect(getAccess.status).toBe(403);

    // Emergency-contacts POST — 403.
    const postContact = await callJson({
      method: 'POST',
      path: `/api/v1/households/${householdId}/emergency-contacts`,
      token: attackerToken,
      body: buildContactPayload({ name: 'Attacker contact', priority: 1 }),
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(postContact.status).toBe(403);

    // Defence-in-depth: the household stays clean. A 403 must not
    // leave a half-written ciphertext or a stray contact row (the
    // membership check fires before the encrypt path AND before the
    // cap check + insert).
    const householdRow = await harnessPrisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        accessInstructionsCiphertext: true,
        accessInstructionsUpdatedAt: true,
      },
    });
    expect(householdRow.accessInstructionsCiphertext).toBeNull();
    expect(householdRow.accessInstructionsUpdatedAt).toBeNull();
    const contactCount = await harnessPrisma.emergencyContact.count({
      where: { householdId },
    });
    expect(contactCount).toBe(0);
  });

  it('returns 404 for a soft-deleted household (access-instructions)', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });
    await harnessPrisma.household.update({
      where: { id: householdId },
      data: { deletedAt: new Date() },
      select: { id: true },
    });

    const get = await callJson({
      method: 'GET',
      path: `/api/v1/households/${householdId}/access-instructions`,
      token,
    });
    expect(get.status).toBe(404);
    const body = get.body as { title?: string; status?: number };
    expect(body.title).toBe('Not Found');
    expect(body.status).toBe(404);
  });

  it('returns 404 for a missing contact id', async () => {
    const { householdId, payerUserId } = await seedHousehold();
    const token = signAccessToken({ userId: payerUserId, householdId });

    const patch = await callJson({
      method: 'PATCH',
      path: `/api/v1/households/${householdId}/emergency-contacts/does_not_exist_0000000000`,
      token,
      body: { name: 'never lands' },
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(patch.status).toBe(404);

    const del = await callJson({
      method: 'DELETE',
      path: `/api/v1/households/${householdId}/emergency-contacts/does_not_exist_0000000000`,
      token,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(del.status).toBe(404);
  });
});
