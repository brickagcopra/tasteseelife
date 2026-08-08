/**
 * TS-061-followup-4 — end-to-end booking-recurrence integration.
 *
 * Boots the production `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the recurrence surface over HTTP — proving
 * the wire contract from the controller boundary down to the Prisma
 * `$transaction`, the `booking_recurrence` row, the per-occurrence
 * `bookings` rows, the outbox-event-per-child invariant, the
 * `bookings_series_index_unique_idx` DB-level UNIQUE constraint, and
 * the `Idempotency-Key` replay cache (CLAUDE.md §3.3 / §17.5; PDD
 * §7.3 / §9.2 / §24.1).
 *
 * Scope (the four acceptance bullets from
 * `Pending_tasks.md` for TS-061-followup-4):
 *
 *   1. **POST happy path** — a `FREQ=WEEKLY;COUNT=4` series lands four
 *      `bookings` rows + one `booking_recurrence` row inside a single
 *      Prisma `$transaction`. Every child carries the same `seriesId`,
 *      monotonically increasing `seriesIndex` (0..3), the same money
 *      shape (`basePrice` / `commissionRate` / `commissionAmount` /
 *      `finalPrice`), and the same provider/household/senior triplet.
 *      `scheduledStart` advances by exactly 7 days per occurrence.
 *
 *   2. **Outbox emission** — four `booking.created` rows land in
 *      `booking.outbox_events`, all undispatched (`dispatched_at IS
 *      NULL`), each carrying a deterministic `eventId` matching the
 *      paired booking row's `id`. Defends against a regression that
 *      moved the outbox write out of the transaction (consumers would
 *      see partial series).
 *
 *   3. **DB-level UNIQUE rejection** — a manual `INSERT` against
 *      `booking.bookings` with the same `(seriesId, seriesIndex)` as
 *      an existing row throws a UNIQUE-violation error. The service
 *      guarantees uniqueness at the transaction layer; the DB index
 *      is belt-and-braces (PDD §9.2 atomic explode invariant).
 *
 *   4. **Idempotency-Key replay** — POSTing the same series with the
 *      same `Idempotency-Key` returns the same body (byte-equal
 *      `recurrence.seriesId`) and DOES NOT re-explode (the bookings
 *      table still holds exactly 4 rows, not 8). The unit suite covers
 *      the in-memory cache against a fake; this proves the live Redis-
 *      backed `@taste-and-see/nest-idempotency` interceptor wires up.
 *
 * **Why the real `AppModule`, not a hand-rolled test module?** The
 * unit tests (`recurrence.service.test.ts` + `recurrence.controller.test.ts`)
 * already cover the service + controller in isolation against a fake
 * Prisma + fake Outbox. The integration gap is wire-level: the live
 * Prisma `$transaction` against Postgres' MVCC isolation, the
 * `booking_recurrence` table's actual UNIQUE / CHECK constraints (the
 * three CHECKs in the TS-061 migration: termination, occurrence_count,
 * count bounds), the `bookings_series_index_unique_idx` UNIQUE
 * constraint at the DB layer, the `OutboxService.append` against the
 * real `booking.outbox_events` table, and the `@Idempotent()`
 * interceptor against the live Redis. Those only fail when every
 * layer is present.
 *
 * **Why not supertest?** The library is not on CLAUDE.md §13 approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency. Mirrors the
 * canonical shape established by
 * `apps/service-identity/test/integration/auth.integration.test.ts` +
 * `apps/service-household/test/integration/intake.integration.test.ts`.
 *
 * References: PDD §7.3, §9.2, §24.1; CLAUDE.md §3.2, §3.3, §5.3,
 * §9.1, §17.5; TS-009e canonical test in
 * `apps/service-identity/test/integration/auth.integration.test.ts`;
 * TS-031-followup-5 / TS-032-followup-4 / TS-033-followup-7 canonical
 * service-household harness.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type {
  CreateRecurringBookingRequest,
  CreateRecurringBookingResponse,
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
 * purposes: (1) reading raw `booking.bookings` / `booking.booking_recurrence`
 * / `booking.outbox_events` rows to assert the transactional explode
 * invariants, and (2) issuing the manual INSERT that probes the
 * `bookings_series_index_unique_idx` UNIQUE rejection branch (the
 * production code path can't trigger the constraint because the
 * service guarantees uniqueness inside the `$transaction`). The harness
 * Prisma is a SEPARATE process-local client constructed via
 * `new PrismaService({ datasourceUrl })` and never goes through the
 * DI-managed `wrapWithTenantScope` Proxy — so test reads/writes
 * deliberately bypass the tenant-scope gate (the production HTTP path
 * exercises the gate via the real `AppModule`).
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The shared Redis
  // URL is read directly from the globalSetup-provided value.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'booking_test_recurrence',
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
  // secrets, and the env schema's `min(32)` floor would reject
  // placeholder values anyway.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = database.databaseUrl;
  process.env.REDIS_URL = inject('redisUrl');
  jwtAccessSecret = randomBytes(48).toString('base64');
  process.env.JWT_ACCESS_SECRET = jwtAccessSecret;
  process.env.JWT_ISSUER = JWT_ISSUER;
  process.env.JWT_AUDIENCE = JWT_AUDIENCE;
  // Tier-gating dispatch shared-secret — never invoked from this test
  // file (POST /api/v1/bookings/recurring sits behind AccessTokenGuard,
  // not the internal shared-secret pinning), but the env schema's
  // `min(32)` floor requires a real value at boot.
  process.env.BOOKING_TIER_DISPATCH_API_KEY = randomBytes(32).toString('hex');
  // Wellness-summary internal shared-secret (TS-235) — never invoked
  // from this test file, but the env schema's `min(32)` floor requires a
  // real value at boot.
  process.env.BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY = randomBytes(32).toString('hex');
  // Default `advisory` mode: the recurrence path doesn't consult the
  // tier-gating cache (only the per-occurrence `POST /api/v1/bookings`
  // path does), so the mode is irrelevant here. Default is fine.
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
  // here we want IPv4 loopback so `fetch(baseUrl)` reliably resolves
  // across Linux / macOS / Windows CI runners without pulling in the
  // dual-stack resolver's edge cases.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client. Used solely to read raw rows + issue
  // the manual UNIQUE-violation probe. Separate process-local client
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
// HTTP + token helpers.
// ─────────────────────────────────────────────────────────────────────

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function callJson(args: {
  readonly method: 'GET' | 'POST';
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

/**
 * Build a canonical `CreateRecurringBookingRequest` with sensible
 * defaults. Callers may override any field via the `overrides` arg.
 * The anchor scheduling is a Tuesday at 18:00 UTC so the weekly
 * cadence reads naturally in the assertions ("every Tuesday at 6pm").
 *
 * Soft FKs (`householdId` / `seniorId` / `providerId`) are stable
 * across calls so a per-test override can hold them constant for
 * cross-row assertions.
 */
function buildRecurringRequest(overrides: {
  readonly householdId: string;
  readonly seniorId: string;
  readonly providerId: string;
  readonly rrule?: string;
}): CreateRecurringBookingRequest {
  return {
    householdId: overrides.householdId,
    seniorId: overrides.seniorId,
    providerId: overrides.providerId,
    serviceKind: 'companion_dining',
    // Tuesday 2026-06-09 18:00 UTC anchor — first occurrence.
    scheduledStart: '2026-06-09T18:00:00.000Z',
    scheduledEnd: '2026-06-09T20:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 15_000, // $150.00
    commissionRateBps: 2_000, // 20%
    bookingNotes: 'Door code 1234; allergic to cashew.',
    recurrence: {
      rrule: overrides.rrule ?? 'FREQ=WEEKLY;COUNT=4',
    },
  };
}

function freshIdempotencyKey(): string {
  return `rec-${randomBytes(8).toString('hex')}`;
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

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/bookings/recurring against real Postgres', () => {
  it('explodes a 4-occurrence weekly series into 4 bookings + 1 recurrence row inside one transaction', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const body = buildRecurringRequest(ids);

    const res = await callJson({
      method: 'POST',
      path: '/api/v1/bookings/recurring',
      token,
      body,
      idempotencyKey: freshIdempotencyKey(),
    });

    expect(res.status).toBe(201);
    const respBody = res.body as CreateRecurringBookingResponse;

    // ── Recurrence row shape ─────────────────────────────────────────
    expect(typeof respBody.recurrence.seriesId).toBe('string');
    expect(respBody.recurrence.seriesId.startsWith('srs_')).toBe(true);
    expect(respBody.recurrence.rrule).toBe('FREQ=WEEKLY;COUNT=4');
    expect(respBody.recurrence.endDate).toBeNull();
    expect(respBody.recurrence.count).toBe(4);
    expect(respBody.recurrence.occurrenceCount).toBe(4);

    // ── Child bookings shape ─────────────────────────────────────────
    expect(respBody.bookings).toHaveLength(4);
    for (let i = 0; i < respBody.bookings.length; i += 1) {
      const child = respBody.bookings[i];
      if (child === undefined) throw new Error('unreachable');
      expect(child.householdId).toBe(ids.householdId);
      expect(child.seniorId).toBe(ids.seniorId);
      expect(child.providerId).toBe(ids.providerId);
      expect(child.serviceKind).toBe('companion_dining');
      expect(child.status).toBe('pending');
      expect(child.currency).toBe('USD');
      expect(child.basePriceMinor).toBe(15_000);
      expect(child.commissionRateBps).toBe(2_000);
      expect(child.commissionAmountMinor).toBe(3_000); // $30 = 20% of $150
      expect(child.finalPriceMinor).toBe(15_000);
      expect(child.bookingNotes).toBe('Door code 1234; allergic to cashew.');
    }

    // Each occurrence advances by exactly 7 days from the anchor.
    const expectedStarts = [
      '2026-06-09T18:00:00.000Z',
      '2026-06-16T18:00:00.000Z',
      '2026-06-23T18:00:00.000Z',
      '2026-06-30T18:00:00.000Z',
    ];
    for (let i = 0; i < expectedStarts.length; i += 1) {
      expect(respBody.bookings[i]?.scheduledStart).toBe(expectedStarts[i]);
    }

    // ── DB-level read-back: the rows actually landed in Postgres ────
    const seriesId = respBody.recurrence.seriesId;
    const persistedRecurrence = await harnessPrisma.bookingRecurrence.findUniqueOrThrow({
      where: { seriesId },
      select: {
        seriesId: true,
        rrule: true,
        endDate: true,
        count: true,
        occurrenceCount: true,
        householdId: true,
        seniorId: true,
        providerId: true,
      },
    });
    expect(persistedRecurrence.rrule).toBe('FREQ=WEEKLY;COUNT=4');
    expect(persistedRecurrence.endDate).toBeNull();
    expect(persistedRecurrence.count).toBe(4);
    expect(persistedRecurrence.occurrenceCount).toBe(4);
    expect(persistedRecurrence.householdId).toBe(ids.householdId);
    expect(persistedRecurrence.seniorId).toBe(ids.seniorId);
    expect(persistedRecurrence.providerId).toBe(ids.providerId);

    const persistedBookings = await harnessPrisma.booking.findMany({
      where: { seriesId },
      orderBy: { seriesIndex: 'asc' },
      select: {
        id: true,
        seriesId: true,
        seriesIndex: true,
        scheduledStart: true,
        status: true,
      },
    });
    expect(persistedBookings).toHaveLength(4);
    for (let i = 0; i < persistedBookings.length; i += 1) {
      const row = persistedBookings[i];
      if (row === undefined) throw new Error('unreachable');
      expect(row.seriesId).toBe(seriesId);
      expect(row.seriesIndex).toBe(i);
      expect(row.status).toBe('pending');
      expect(row.scheduledStart.toISOString()).toBe(expectedStarts[i]);
    }
  });

  it('lands one undispatched booking.created outbox row per materialised child, inside the same transaction', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });

    const res = await callJson({
      method: 'POST',
      path: '/api/v1/bookings/recurring',
      token,
      body: buildRecurringRequest(ids),
      idempotencyKey: freshIdempotencyKey(),
    });

    expect(res.status).toBe(201);
    const respBody = res.body as CreateRecurringBookingResponse;
    const childIds = respBody.bookings.map((b) => b.id);
    expect(childIds).toHaveLength(4);

    // Each child's booking.created outbox row should be undispatched
    // and keyed by `event_id = booking.id` (the recurrence service
    // uses the booking id as the deterministic event id so the
    // outbox event is replay-safe at the consumer boundary).
    const outboxRows = await harnessPrisma.outboxEvent.findMany({
      where: { eventName: 'booking.created', eventId: { in: childIds } },
      select: {
        eventId: true,
        eventName: true,
        dispatchedAt: true,
        producerService: true,
        attempts: true,
        payload: true,
      },
    });

    expect(outboxRows).toHaveLength(4);
    const foundEventIds = outboxRows.map((r) => r.eventId).sort();
    expect(foundEventIds).toEqual([...childIds].sort());
    for (const row of outboxRows) {
      expect(row.eventName).toBe('booking.created');
      expect(row.dispatchedAt).toBeNull();
      expect(row.producerService).toBe('service-booking');
      expect(row.attempts).toBe(0);
      // Payload sanity check — the SDK validated it against the
      // `booking.created` registry schema before insert, but we can
      // still spot-check the shape end-to-end.
      const payload = row.payload as Record<string, unknown>;
      expect(payload.bookingId).toBe(row.eventId);
      expect(payload.householdId).toBe(ids.householdId);
      expect(payload.providerId).toBe(ids.providerId);
      expect(payload.serviceKind).toBe('companion_dining');
      expect(payload.basePriceMinor).toBe(15_000);
      expect(payload.commissionAmountMinor).toBe(3_000);
      expect(payload.finalPriceMinor).toBe(15_000);
    }
  });

  it('rejects a manual duplicate (seriesId, seriesIndex) insert at the DB layer via bookings_series_index_unique_idx', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });

    const res = await callJson({
      method: 'POST',
      path: '/api/v1/bookings/recurring',
      token,
      body: buildRecurringRequest(ids),
      idempotencyKey: freshIdempotencyKey(),
    });

    expect(res.status).toBe(201);
    const respBody = res.body as CreateRecurringBookingResponse;
    const seriesId = respBody.recurrence.seriesId;

    // The service writes seriesIndex=0..3. Attempt to manually insert
    // a new row at seriesIndex=0 (same series) and expect the
    // `bookings_series_index_unique_idx` UNIQUE constraint to reject
    // it. The service guarantees uniqueness at the transaction layer;
    // the DB index is the belt-and-braces guard against a concurrent
    // re-explode racing past the service-side check.
    await expect(
      harnessPrisma.booking.create({
        data: {
          householdId: ids.householdId,
          seniorId: ids.seniorId,
          providerId: ids.providerId,
          serviceKind: 'companion_dining',
          status: 'pending',
          scheduledStart: new Date('2026-06-09T18:00:00.000Z'),
          scheduledEnd: new Date('2026-06-09T20:00:00.000Z'),
          currency: 'USD',
          basePrice: '150.00',
          commissionRate: '0.2000',
          commissionAmount: '30.00',
          finalPrice: '150.00',
          seriesId,
          seriesIndex: 0,
        },
      }),
    ).rejects.toThrow();

    // Defence-in-depth: the bookings row count for this series is
    // still 4 — the rejected insert did not land.
    const count = await harnessPrisma.booking.count({ where: { seriesId } });
    expect(count).toBe(4);
  });

  it('replays the same series body on a duplicate Idempotency-Key — no re-explode, no duplicate bookings rows', async () => {
    const ids = freshSoftFkIds();
    const token = signAccessToken({ userId: ids.userId, householdId: ids.householdId });
    const sharedKey = freshIdempotencyKey();
    const body = buildRecurringRequest(ids);

    const first = await callJson({
      method: 'POST',
      path: '/api/v1/bookings/recurring',
      token,
      body,
      idempotencyKey: sharedKey,
    });
    expect(first.status).toBe(201);
    const firstBody = first.body as CreateRecurringBookingResponse;
    const firstSeriesId = firstBody.recurrence.seriesId;
    const firstChildIds = firstBody.bookings.map((b) => b.id).sort();

    // Replay with the same Idempotency-Key + identical body. The
    // `@Idempotent()` interceptor (backed by the live Redis) should
    // short-circuit BEFORE the service runs, returning the cached
    // response byte-for-byte. The `seriesId` (a fresh CUID generated
    // inside the service) MUST match the first response — proving
    // no re-entry into `RecurrenceService.createRecurringSeries`.
    const second = await callJson({
      method: 'POST',
      path: '/api/v1/bookings/recurring',
      token,
      body,
      idempotencyKey: sharedKey,
    });
    expect(second.status).toBe(201);
    const secondBody = second.body as CreateRecurringBookingResponse;
    expect(secondBody.recurrence.seriesId).toBe(firstSeriesId);
    expect(secondBody.bookings.map((b) => b.id).sort()).toEqual(firstChildIds);

    // Row-count invariant: the bookings table has exactly 4 rows for
    // this household (not 8). A regression that lost the cache would
    // have re-exploded — the service would generate a fresh seriesId
    // and another 4 rows would land. The series-keyed query is the
    // tightest invariant (filtering by householdId would mix in any
    // future household-scoped rows from other tests; the seriesId
    // is a CUID generated fresh per call so collisions are
    // impossible).
    const seriesCount = await harnessPrisma.booking.count({
      where: { seriesId: firstSeriesId },
    });
    expect(seriesCount).toBe(4);

    // And the household-scoped bookings row count is also 4 — no
    // ghost rows from a re-explode under a different seriesId.
    const householdCount = await harnessPrisma.booking.count({
      where: { householdId: ids.householdId },
    });
    expect(householdCount).toBe(4);

    // Recurrence-row invariant: still exactly one row in
    // `booking_recurrence` for this household.
    const recurrenceCount = await harnessPrisma.bookingRecurrence.count({
      where: { householdId: ids.householdId },
    });
    expect(recurrenceCount).toBe(1);
  });
});
