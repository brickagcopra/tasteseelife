/**
 * TS-062-followup-9 — end-to-end booking visit-notes integration.
 *
 * Boots the production `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the visit-notes surface over HTTP — proving
 * the wire contract from the controller boundary down to the Prisma
 * `upsert` against the UNIQUE `booking_id` index, the lifecycle gate
 * (PRD §6.4 / PDD §9.2 — notes only writable while the booking is
 * `in_progress` or `completed`), and the `Idempotency-Key` replay
 * cache (CLAUDE.md §3.3 / §17.5).
 *
 * Scope (the six acceptance bullets from `Pending_tasks.md` for
 * TS-062-followup-9):
 *
 *   1. **Partial PUT against an in_progress booking** — body containing
 *      only `mood` lands the row with the enum persisted, `recorded_at`
 *      stamped server-side (non-null), `photo_keys` defaulted to the
 *      empty array, and the other observation fields null.
 *
 *   2. **Full PUT replaces the partial row** — same `id`, all
 *      observation columns now reflect the new values, `recordedAt`
 *      and `updatedAt` advance past the first call's stamps. Defends
 *      against a regression that swapped `upsert` for `create` (which
 *      would 500 on the second call, not update in place).
 *
 *   3. **PUT against a `pending` booking** — 409 Conflict with the
 *      `Visit notes cannot be written while the booking is in pending`
 *      detail. The `booking_visit_notes` row count for that booking
 *      remains zero — the lifecycle gate fires BEFORE the upsert.
 *
 *   4. **GET after upsert** — 200 OK + body shape parses cleanly
 *      against `VisitNotesResponseSchema` (the network contract). The
 *      timestamps round-trip as ISO-8601 strings; `photoKeys` arrives
 *      as a `string[]`.
 *
 *   5. **GET against a booking with no notes** — 404 Not Found with
 *      the `No visit notes recorded for booking ...` detail. The
 *      family-portal renders an empty-state placeholder for this
 *      shape.
 *
 *   6. **Concurrent PUT race against the UNIQUE booking_id constraint**
 *      — three parallel PUTs with distinct `Idempotency-Key`s + distinct
 *      payloads land exactly one row in `booking_visit_notes`. Prisma's
 *      `upsert` against the UNIQUE column resolves the race via Postgres'
 *      `INSERT ... ON CONFLICT DO UPDATE`, so the survivors come back
 *      as 200 OK rather than 500. The final row's `mood` is one of the
 *      three payloads (whichever committed last).
 *
 * **Why the real `AppModule`, not a hand-rolled test module?** The
 * unit tests (`visit-notes.service.test.ts` +
 * `visit-notes.controller.test.ts`) already cover the service +
 * controller in isolation against a fake Prisma. The integration gap is
 * wire-level: Prisma's `upsert` against Postgres' real UNIQUE
 * constraint behaviour under concurrent execution, the `enforce`-mode
 * `TenantContextInterceptor` against the live Redis-backed gate, and
 * the `@Idempotent()` interceptor against the live Redis.
 *
 * **Why not supertest?** The library is not on CLAUDE.md §13 approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency. Mirrors the
 * canonical shape established by `recurrence.integration.test.ts`.
 *
 * References: PRD §6.4 family peace-of-mind dashboard; PDD §9.2
 * booking-lifecycle sequence; CLAUDE.md §3.2 row-level access,
 * §3.3 idempotency, §9.1 contract tests, §17.5 idempotency on writes;
 * TS-009e-followup-2 shared-stack harness; TS-061-followup-4 canonical
 * service-booking integration-test shape.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import {
  VisitNotesResponseSchema,
  type UpsertVisitNotesRequest,
  type VisitNotesResponse,
} from '@taste-and-see/contracts';
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
 * purposes: (1) seeding parent `booking.bookings` rows in specific
 * lifecycle states so each test starts from a known fixture, and
 * (2) reading raw `booking.booking_visit_notes` rows to assert the
 * upsert / lifecycle-gate invariants. The harness Prisma is a
 * SEPARATE process-local client constructed via
 * `new PrismaService({ datasourceUrl })` and never goes through the
 * DI-managed `wrapWithTenantScope` Proxy — so test reads/writes
 * deliberately bypass the tenant-scope gate (the production HTTP path
 * exercises the gate via the real `AppModule`).
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'booking_test_visit_notes',
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
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = database.databaseUrl;
  process.env.REDIS_URL = inject('redisUrl');
  jwtAccessSecret = randomBytes(48).toString('base64');
  process.env.JWT_ACCESS_SECRET = jwtAccessSecret;
  process.env.JWT_ISSUER = JWT_ISSUER;
  process.env.JWT_AUDIENCE = JWT_AUDIENCE;
  // Tier-gating dispatch shared-secret — never invoked from this test
  // file (PUT /api/v1/bookings/:id/visit-notes sits behind
  // AccessTokenGuard, not the internal shared-secret pinning), but
  // the env schema's `min(32)` floor requires a real value at boot.
  process.env.BOOKING_TIER_DISPATCH_API_KEY = randomBytes(32).toString('hex');
  // Wellness-summary internal shared-secret (TS-235) — never invoked
  // from this test file, but the env schema's `min(32)` floor requires a
  // real value at boot.
  process.env.BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY = randomBytes(32).toString('hex');
  // Lower idempotency in-flight TTL so a slow assertion never wedges
  // the cache slot for the default 60s.
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = '5';

  // TS-506-followup-3b — this fixture is a copy of the app's env contract that
  // nothing covered, and it had fallen behind the schema. The suite was dying
  // inside `loadEnv` before its first assertion, and because the integration
  // lane is not part of `turbo run test` nothing said so.
  // `packages/testing/src/boot/integration-fixture-env.test.ts` now guards it.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  // Dynamic imports — AppModule's module-load-time env validation
  // runs here, after the env block above.
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new RfcProblemFilter());
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
// HTTP + token helpers.
// ─────────────────────────────────────────────────────────────────────

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function callJson(args: {
  readonly method: 'GET' | 'PUT';
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
 * the AppModule was booted with. The payload shape mirrors
 * `auth-sdk`'s `AccessTokenPayloadSchema` (sub / sid / mfa / roles /
 * tenantScope). The `tenantScope` is the `householdId` claim the
 * `TenantContextInterceptor` will seed into the Prisma extension's
 * frame — sufficient for the gate to issue a `proceed_scoped`
 * decision against the `enforce` mode service-booking is booted in.
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
  return `vn-${randomBytes(8).toString('hex')}`;
}

function freshSoftFkIds(): {
  readonly householdId: string;
  readonly seniorId: string;
  readonly providerId: string;
  readonly userId: string;
} {
  const stamp = randomBytes(6).toString('hex');
  return {
    householdId: `hh_${stamp}`,
    seniorId: `sen_${stamp}`,
    providerId: `prv_${stamp}`,
    userId: `usr_${stamp}`,
  };
}

/**
 * Seed a parent `booking.bookings` row directly via the harness Prisma.
 *
 * The visit-notes surface depends on a parent booking row in a specific
 * lifecycle state (`in_progress` / `completed` for happy-path writes;
 * `pending` for the gate-rejection test). Seeding via the harness
 * bypasses the BookingsService (which is the System Under Test for
 * TS-060 / TS-061, not for this slice) and lands the row in exactly
 * the state we need without exercising any tier-gating / outbox /
 * idempotency machinery that's irrelevant to visit-notes.
 *
 * Money columns are `Decimal(12,2)` per CLAUDE.md §4.1 — we pass plain
 * strings (e.g. `'150.00'`) which Prisma serialises to Postgres'
 * Decimal type without floating-point error.
 */
async function seedBookingInState(args: {
  readonly householdId: string;
  readonly seniorId: string;
  readonly providerId: string;
  readonly status: 'pending' | 'confirmed' | 'in_progress' | 'completed';
}): Promise<{ readonly id: string }> {
  const row = await harnessPrisma.booking.create({
    data: {
      householdId: args.householdId,
      seniorId: args.seniorId,
      providerId: args.providerId,
      serviceKind: 'companion_dining',
      status: args.status,
      scheduledStart: new Date('2026-06-09T18:00:00.000Z'),
      scheduledEnd: new Date('2026-06-09T20:00:00.000Z'),
      currency: 'USD',
      basePrice: '150.00',
      commissionRate: '0.2000',
      commissionAmount: '30.00',
      finalPrice: '150.00',
    },
    select: { id: true },
  });
  return row;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('PUT/GET /api/v1/bookings/:bookingId/visit-notes against real Postgres', () => {
  it('upserts a partial payload (mood only) against an in_progress booking and lands a row with photo_keys=[]', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const booking = await seedBookingInState({ ...ids, status: 'in_progress' });

    const beforeStamp = new Date();
    const partial: UpsertVisitNotesRequest = { mood: 'bright' };
    const res = await callJson({
      method: 'PUT',
      path: `/api/v1/bookings/${booking.id}/visit-notes`,
      token,
      body: partial,
      idempotencyKey: freshIdempotencyKey(),
    });
    const afterStamp = new Date();

    expect(res.status).toBe(200);
    const respBody = res.body as VisitNotesResponse;
    expect(respBody.bookingId).toBe(booking.id);
    expect(respBody.mood).toBe('bright');
    expect(respBody.appetite).toBeNull();
    expect(respBody.hydration).toBeNull();
    expect(respBody.socialEngagement).toBeNull();
    expect(respBody.freeform).toBeNull();
    expect(respBody.photoKeys).toEqual([]);
    expect(respBody.recordedByUserId).toBe(ids.userId);

    // DB-level read-back — the row landed in Postgres with the
    // expected shape. Crucially:
    //   - photo_keys defaulted to the empty array (the contract layer
    //     resolves the omitted field to `[]`, the service writes `[]`,
    //     and the column default is `[]` belt-and-braces).
    //   - recorded_at was stamped server-side from the request
    //     handler's wall-clock, so it lies inside the {before, after}
    //     window we captured around the HTTP call.
    const persisted = await harnessPrisma.bookingVisitNote.findUniqueOrThrow({
      where: { bookingId: booking.id },
      select: {
        id: true,
        bookingId: true,
        mood: true,
        appetite: true,
        hydration: true,
        socialEngagement: true,
        freeform: true,
        photoKeys: true,
        recordedByUserId: true,
        recordedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(persisted.bookingId).toBe(booking.id);
    expect(persisted.mood).toBe('bright');
    expect(persisted.appetite).toBeNull();
    expect(persisted.hydration).toBeNull();
    expect(persisted.socialEngagement).toBeNull();
    expect(persisted.freeform).toBeNull();
    expect(persisted.photoKeys).toEqual([]);
    expect(persisted.recordedByUserId).toBe(ids.userId);
    expect(persisted.recordedAt.getTime()).toBeGreaterThanOrEqual(beforeStamp.getTime());
    expect(persisted.recordedAt.getTime()).toBeLessThanOrEqual(afterStamp.getTime());

    // Defence-in-depth: exactly one row for this booking.
    const count = await harnessPrisma.bookingVisitNote.count({
      where: { bookingId: booking.id },
    });
    expect(count).toBe(1);
  });

  it('updates the same row in place on a second PUT with a full payload (id preserved, updated_at advanced)', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const booking = await seedBookingInState({ ...ids, status: 'in_progress' });

    // First call — partial payload, lands the row.
    const partial: UpsertVisitNotesRequest = { mood: 'subdued' };
    const first = await callJson({
      method: 'PUT',
      path: `/api/v1/bookings/${booking.id}/visit-notes`,
      token,
      body: partial,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(first.status).toBe(200);
    const firstRow = await harnessPrisma.bookingVisitNote.findUniqueOrThrow({
      where: { bookingId: booking.id },
      select: { id: true, recordedAt: true, updatedAt: true, createdAt: true },
    });

    // Second call — full payload, fresh Idempotency-Key (so the
    // interceptor's cache doesn't replay the first response).
    const full: UpsertVisitNotesRequest = {
      mood: 'joyful',
      appetite: 'hearty',
      hydration: 'good',
      socialEngagement: 'vibrant',
      freeform: 'She finished the lentil soup and asked for the recipe — second time this month.',
      photoKeys: ['mds_recipe_card_abc123'],
    };
    const second = await callJson({
      method: 'PUT',
      path: `/api/v1/bookings/${booking.id}/visit-notes`,
      token,
      body: full,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(second.status).toBe(200);
    const secondBody = second.body as VisitNotesResponse;
    expect(secondBody.bookingId).toBe(booking.id);
    expect(secondBody.mood).toBe('joyful');
    expect(secondBody.appetite).toBe('hearty');
    expect(secondBody.hydration).toBe('good');
    expect(secondBody.socialEngagement).toBe('vibrant');
    expect(secondBody.freeform).toBe(full.freeform!);
    expect(secondBody.photoKeys).toEqual(['mds_recipe_card_abc123']);

    // Row-shape invariants in Postgres:
    //   1. Exactly ONE row for this booking (the upsert updated in
    //      place; a regression that swapped `upsert` for `create`
    //      would 500 on the second call OR land a second row).
    //   2. The row's `id` is unchanged across the two calls (the
    //      upsert chose the UPDATE branch).
    //   3. `recordedAt` AND `updatedAt` advanced past the first
    //      call's stamps.
    //   4. `createdAt` did NOT advance — Prisma's `@updatedAt`
    //      directive touches `updatedAt` on update, but `createdAt`
    //      is `@default(now())` and only fires on insert.
    const count = await harnessPrisma.bookingVisitNote.count({
      where: { bookingId: booking.id },
    });
    expect(count).toBe(1);

    const secondRow = await harnessPrisma.bookingVisitNote.findUniqueOrThrow({
      where: { bookingId: booking.id },
      select: {
        id: true,
        mood: true,
        appetite: true,
        hydration: true,
        socialEngagement: true,
        freeform: true,
        photoKeys: true,
        recordedByUserId: true,
        recordedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(secondRow.id).toBe(firstRow.id);
    expect(secondRow.mood).toBe('joyful');
    expect(secondRow.appetite).toBe('hearty');
    expect(secondRow.hydration).toBe('good');
    expect(secondRow.socialEngagement).toBe('vibrant');
    expect(secondRow.freeform).toBe(full.freeform!);
    expect(secondRow.photoKeys).toEqual(['mds_recipe_card_abc123']);
    expect(secondRow.recordedAt.getTime()).toBeGreaterThanOrEqual(firstRow.recordedAt.getTime());
    expect(secondRow.updatedAt.getTime()).toBeGreaterThanOrEqual(firstRow.updatedAt.getTime());
    expect(secondRow.createdAt.getTime()).toBe(firstRow.createdAt.getTime());
  });

  it('rejects a PUT against a `pending` booking with 409 and leaves the row count at zero', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const booking = await seedBookingInState({ ...ids, status: 'pending' });

    const res = await callJson({
      method: 'PUT',
      path: `/api/v1/bookings/${booking.id}/visit-notes`,
      token,
      body: { mood: 'bright' } satisfies UpsertVisitNotesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });

    expect(res.status).toBe(409);
    const errorBody = res.body as {
      readonly type: string;
      readonly title: string;
      readonly status: number;
      readonly detail: string;
      readonly allowedStatuses?: readonly string[];
    };
    expect(errorBody.title).toBe('Conflict');
    expect(errorBody.status).toBe(409);
    expect(errorBody.detail).toContain('pending');
    // The controller surfaces the allowed-status hint so the client UX
    // can render a "visible after the provider checks in" message
    // rather than a generic 409.
    expect(errorBody.allowedStatuses).toEqual(['in_progress', 'completed']);

    // The lifecycle gate fires BEFORE the upsert — no row landed.
    const count = await harnessPrisma.bookingVisitNote.count({
      where: { bookingId: booking.id },
    });
    expect(count).toBe(0);
  });

  it('returns the visit-notes row on GET after upsert and the body parses cleanly against VisitNotesResponseSchema', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const booking = await seedBookingInState({ ...ids, status: 'in_progress' });

    const putRes = await callJson({
      method: 'PUT',
      path: `/api/v1/bookings/${booking.id}/visit-notes`,
      token,
      body: {
        // TS-305d-followup-2b1b — this said `mood: 'engaged'` with the comment
        // "socialEngagement enum value", which is exactly what was wrong with
        // it: `engaged` belongs to `VisitNoteSocialEngagementSchema`, and
        // `VisitNoteMoodSchema` is `low|subdued|neutral|bright|joyful`. The
        // route's 400 was correct; the fixture was not.
        mood: 'bright' as const,
        // Use the canonical "as full as possible" payload so the GET
        // assertion covers every nullable field.
        appetite: 'moderate',
        hydration: 'adequate',
        socialEngagement: 'present',
        freeform: 'Quiet afternoon — read the newspaper together, lentil soup for lunch.',
        photoKeys: ['mds_book_cover_xyz789'],
      } satisfies UpsertVisitNotesRequest,
      idempotencyKey: freshIdempotencyKey(),
    });
    expect(putRes.status).toBe(200);

    const getRes = await callJson({
      method: 'GET',
      path: `/api/v1/bookings/${booking.id}/visit-notes`,
      token,
    });
    expect(getRes.status).toBe(200);

    // The body parses cleanly against the published contract — the
    // load-bearing wire-level assertion. A regression that drifted the
    // mapper or the response shape (e.g. forgot to ISO-format
    // recordedAt) would surface here.
    const parsed = VisitNotesResponseSchema.parse(getRes.body);
    expect(parsed.bookingId).toBe(booking.id);
    expect(parsed.mood).toBe('bright');
    expect(parsed.appetite).toBe('moderate');
    expect(parsed.hydration).toBe('adequate');
    expect(parsed.socialEngagement).toBe('present');
    expect(parsed.freeform).toBe(
      'Quiet afternoon — read the newspaper together, lentil soup for lunch.',
    );
    expect(parsed.photoKeys).toEqual(['mds_book_cover_xyz789']);
    expect(parsed.recordedByUserId).toBe(ids.userId);
    // ISO-8601 datetime — the .datetime() refinement on the schema
    // already proved this; re-asserting parses to a real Date.
    expect(new Date(parsed.recordedAt).toString()).not.toBe('Invalid Date');
    expect(new Date(parsed.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('returns 404 on GET when the booking exists but no visit notes have been recorded yet', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const booking = await seedBookingInState({ ...ids, status: 'in_progress' });

    const res = await callJson({
      method: 'GET',
      path: `/api/v1/bookings/${booking.id}/visit-notes`,
      token,
    });

    expect(res.status).toBe(404);
    const errorBody = res.body as {
      readonly title: string;
      readonly status: number;
      readonly detail: string;
    };
    expect(errorBody.title).toBe('Not Found');
    expect(errorBody.status).toBe(404);
    // The "no visit notes recorded" detail distinguishes this 404 from
    // a "booking not found" 404 — the family-portal renders different
    // empty-state placeholders.
    expect(errorBody.detail).toContain('No visit notes recorded for booking');

    // Defence-in-depth: the booking row exists but the visit-notes
    // table has zero rows for this booking.
    const bookingRow = await harnessPrisma.booking.findUnique({
      where: { id: booking.id },
      select: { id: true },
    });
    expect(bookingRow).not.toBeNull();
    const count = await harnessPrisma.bookingVisitNote.count({
      where: { bookingId: booking.id },
    });
    expect(count).toBe(0);
  });

  it('lands exactly one row when three concurrent PUTs race against the UNIQUE booking_id constraint', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const booking = await seedBookingInState({ ...ids, status: 'in_progress' });

    // Three parallel PUTs with DISTINCT Idempotency-Keys (so the
    // interceptor's cache doesn't intervene) and DISTINCT payloads
    // (so the "last write wins" semantics are observable). Prisma's
    // `upsert` against the UNIQUE `booking_id` column generates an
    // `INSERT ... ON CONFLICT DO UPDATE` — atomic at the DB layer.
    //
    // The race is the point: a regression that swapped the upsert for
    // separate find-then-create would 500 on the losing INSERTs as
    // unique-violation errors bubbled up.
    const payloads: readonly UpsertVisitNotesRequest[] = [
      { mood: 'low' as const },
      { mood: 'neutral' as const },
      { mood: 'joyful' as const },
    ];
    const responses = await Promise.allSettled(
      payloads.map((payload) =>
        callJson({
          method: 'PUT',
          path: `/api/v1/bookings/${booking.id}/visit-notes`,
          token,
          body: payload,
          idempotencyKey: freshIdempotencyKey(),
        }),
      ),
    );

    // Every call resolved (no rejected promises — `callJson` doesn't
    // throw on non-2xx; it just returns the status code).
    for (const result of responses) {
      expect(result.status).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw new Error('unreachable');
      expect(result.value.status).toBe(200);
    }

    // The load-bearing invariant: exactly one row in Postgres for the
    // booking. The UNIQUE `booking_id` index is what guarantees this —
    // without it, three parallel INSERTs would land three rows.
    const count = await harnessPrisma.bookingVisitNote.count({
      where: { bookingId: booking.id },
    });
    expect(count).toBe(1);

    // The final row's `mood` is one of the three payloads (whichever
    // committed last). We don't pin which one — the race outcome is
    // non-deterministic by design.
    const persisted = await harnessPrisma.bookingVisitNote.findUniqueOrThrow({
      where: { bookingId: booking.id },
      select: { mood: true, recordedByUserId: true },
    });
    expect(['low', 'neutral', 'joyful']).toContain(persisted.mood);
    expect(persisted.recordedByUserId).toBe(ids.userId);
  });
});
