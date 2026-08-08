/**
 * TS-025-followup-4 — end-to-end lockout integration.
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and replays the per-user failed-login lockout schedule
 * (TS-025; CLAUDE.md §3.1) against a real database. The unit-test
 * surface in `lockout.service.test.ts` covers the pure schedule
 * function plus the service's transaction semantics against a
 * FakePrisma; this test catches the wire-level cases the unit suite
 * cannot reach.
 *
 * Load-bearing properties asserted end-to-end:
 *
 *   1. **Schedule lands against real Postgres.** Three bad-password
 *      attempts increment `failed_login_count` to 3 AND stamp
 *      `locked_until` to ~now+60s (count 3 → 1m per the schedule). A
 *      DB cross-check via the harness Prisma verifies both columns
 *      reached their expected post-state — without that, a regression
 *      that silently dropped the `lockedUntil` write but kept the
 *      counter increment would slip through every HTTP-only check
 *      (the response shape is identical between locked and bad-
 *      password 401s by design).
 *
 *   2. **Lockout-state oracle defence.** A CORRECT password presented
 *      during the lock window returns the same generic 401 as a bad
 *      password — same RFC 7807 body shape, same `Unauthorized`
 *      title. Without this collapse, a response-time / response-shape
 *      divergence would expose whether an account is in the locked
 *      state (a free oracle for "this email is real AND the attacker
 *      has already burned through 3 attempts"). The auth integration
 *      test covers the bad-password 401 shape; this test proves the
 *      lockout branch collapses onto the same shape.
 *
 *   3. **Anti-shrinkage on escalation.** A 4th failed attempt while
 *      the count-3 lock is still active extends the lock to ~now+120s
 *      (count 4 → 2m). The unit test asserts the in-memory pick-
 *      later-of-(existing, candidate) logic against FakePrisma; this
 *      test asserts the same invariant against Postgres' real read-
 *      then-write transaction semantics. A regression in the
 *      `$transaction` callback that read a stale count (e.g. swapped
 *      to a `findUnique` outside the transaction) would let the
 *      slower-to-commit update write `now+60s` over `now+120s` — a
 *      strict lock-weakening that this assertion catches.
 *
 *   4. **Successful login after expiry clears the counter.** Once the
 *      lock window has passed (simulated by writing `locked_until`
 *      to a past instant via the harness — the alternative is to
 *      wait the actual 60s which would make the suite intolerably
 *      slow), a correct password issues a session AND resets
 *      `failed_login_count` to 0, `last_failed_login_at` to null,
 *      and `locked_until` to null. The recordSuccess path is the
 *      garbage-collection mechanism for the policy state; if it
 *      regressed, a user who briefly locked themselves out would
 *      carry the count forward indefinitely and re-lock on a much
 *      faster cadence after each subsequent typo.
 *
 *   5. **Grace threshold honoured.** Two failed attempts in a row do
 *      NOT set `lockedUntil`. The schedule's grace window (counts ≤
 *      2 → no lock) exists so the first password typo from the
 *      legitimate user doesn't put them in a one-minute time-out;
 *      asserting it explicitly defends against a refactor that
 *      "simplified" the schedule by always locking from count 1.
 *
 * Why a dedicated test file rather than extending
 * `auth.integration.test.ts`. The auth integration test deliberately
 * scoped lockout out (its bad-password tests run against fresh
 * accounts that never accumulate enough failures to lock). Adding
 * lockout-schedule and DB-state assertions on top would balloon a
 * single file past its concerns. Per-file Testcontainers lifecycle
 * also means a regression in the lockout surface fails one file's
 * container lifecycle without slowing the sibling auth tests' path.
 * The split matches the canonical pattern established by the rbac
 * and mfa integration tests.
 *
 * Why no supertest. Same as the sibling integration tests — supertest
 * is not on CLAUDE.md §13 approved list. Node 22's native `fetch` +
 * `app.listen(0, '127.0.0.1')` cover the same surface.
 *
 * Why the harness writes `lockedUntil` to a past instant rather than
 * waiting 60s. Each lockout test would otherwise need to either
 * (a) wait wall-clock-real 60+ seconds, (b) run vitest with fake
 * timers (which can't fake Postgres' `now()` and would not actually
 * advance the lock-expiry semantics), or (c) reduce the schedule
 * constants via env (which would test a degraded shape rather than
 * the production schedule). Writing the column directly via the
 * harness Prisma — the same pattern the auth integration test uses
 * for account activation — exercises the production decision logic
 * (`isLocked` reads `lockedUntil > now`) without the wall-clock
 * cost, and preserves the production-equivalent schedule under test.
 *
 * References: PDD §24.1; CLAUDE.md §3.1, §9.1; TS-022-followup-5
 * canonical pattern in `test/integration/auth.integration.test.ts`;
 * `apps/service-identity/src/modules/auth/services/lockout.service.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { createIsolatedDatabase, type IsolatedDatabaseHandle } from '@taste-and-see/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');

let database: IsolatedDatabaseHandle;
let app: INestApplication;
let baseUrl: string;
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The shared Redis
  // URL is read directly from the globalSetup-provided value.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'identity_test_lockout',
    serviceRoot: SERVICE_ROOT,
  });

  // ── Env wiring ────────────────────────────────────────────────────
  //
  // `app.module.ts` evaluates `loadEnv()` at module-load time, so the
  // env block MUST land before the dynamic AppModule import below.
  // Mirrors the sibling integration tests deliberately — same load-
  // order contract.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = database.databaseUrl;
  process.env.REDIS_URL = inject('redisUrl');
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64');
  process.env.MFA_TOTP_ENC_KEY = randomBytes(32).toString('base64');
  process.env.MFA_CHALLENGE_SECRET = randomBytes(48).toString('base64');
  process.env.STRIPE_SECRET_KEY = `sk_test_${randomBytes(16).toString('hex')}`;
  process.env.STRIPE_IDENTITY_RETURN_URL = 'https://example.test/kyc/return';
  process.env.KYC_PAYLOAD_ENC_KEY = randomBytes(32).toString('base64');
  process.env.KYC_WEBHOOK_INTERNAL_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_RECIPIENT_CONTACTS_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_PRIVACY_EXPORT_API_KEY = randomBytes(32).toString('base64');
  // HTTP-friendly cookie attribute for the loopback round-trip — same
  // posture as the sibling integration tests.
  process.env.REFRESH_COOKIE_SECURE = 'false';
  // Short access-token TTL so a future `expiresIn` assertion stays
  // deterministic; not load-bearing for the lockout surface but
  // matches the sibling tests' shape.
  process.env.JWT_ACCESS_TTL_SECONDS = '120';
  // Lower idempotency in-flight TTL so a slow assertion never wedges
  // the cache slot for the default 60s.
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = '5';
  // TS-025-followup-1 — this suite deliberately drives many bad-
  // password attempts to exercise the per-user lockout schedule. The
  // IP-level circuit breaker shares one Redis bucket per loopback IP
  // across the integration suite; without an override the breaker
  // would trip mid-test and the bad-password attempts would all
  // short-circuit on the breaker (returning the same generic 401)
  // before the per-user counter increments. Bumping the threshold
  // high keeps the breaker out of the way of the schedule under test
  // — TS-025-followup-1 has its own unit-test coverage for the
  // breaker semantics. Sibling integration tests carry the same
  // override.
  process.env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW = '100000';

  // TS-506-followup-3b — this fixture is a copy of the app's env contract that
  // nothing covered, and it had fallen behind the schema. The suite was dying
  // inside `loadEnv` before its first assertion, and because the integration
  // lane is not part of `turbo run test` nothing said so.
  // `packages/testing/src/boot/integration-fixture-env.test.ts` now guards it.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new RfcProblemFilter());
  // Bind to IPv4 loopback explicitly so `fetch(baseUrl)` resolves
  // consistently across Linux / macOS / Windows CI runners — sibling
  // tests do the same.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client. Two narrow uses in this file: flip a
  // freshly-signed-up account to `active` (no email-verification
  // surface yet) and inspect / mutate the lockout columns directly
  // (read for post-state assertions, write for the "simulate lock
  // expiry without wall-clock waiting" pattern). Every other state
  // write goes through the real HTTP endpoints.
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
// HTTP helpers. Mirror the auth + MFA + RBAC integration test shape —
// minimal `fetch` wrapper that surfaces status + body + Set-Cookie.
// ─────────────────────────────────────────────────────────────────────

interface AuthResponse {
  readonly status: number;
  readonly body: unknown;
  readonly setCookies: readonly string[];
}

async function callJson(
  path: string,
  init: { body?: unknown; cookie?: string } = {},
): Promise<AuthResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
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

  const setCookies = response.headers.getSetCookie();
  return { status: response.status, body, setCookies };
}

/**
 * Generate a per-test email that won't collide with sibling tests
 * across the same Postgres container. Each lockout test starts from
 * a clean account so the schedule expectations are deterministic
 * (no count carried in from a sibling describe block).
 */
let emailSeed = 0;
function uniqueEmail(prefix = 'lockout'): string {
  emailSeed += 1;
  return `${prefix}+${process.pid}+${Date.now()}+${emailSeed}@tastesee.test`;
}

const VALID_PASSWORD = 'P@ssw0rd-correct-horse-battery-staple';
const BAD_PASSWORD = 'not-the-real-one';

/**
 * Activate a freshly-signed-up account. Stands in for the future
 * email-verification surface (no such endpoint exists today).
 * Identical to the auth integration test's helper.
 */
async function activateAccount(email: string): Promise<void> {
  await harnessPrisma.user.update({
    where: { email },
    data: { status: 'active' },
  });
}

/**
 * Read the lockout-relevant columns for a user. The auth flow's
 * lock decisions all derive from these three columns — exposing
 * them as a typed tuple keeps the assertion sites readable without
 * a per-test re-implementation of the select.
 */
async function readLockoutColumns(email: string): Promise<{
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: Date | null;
  readonly lockedUntil: Date | null;
}> {
  const row = await harnessPrisma.user.findUnique({
    where: { email },
    select: {
      failedLoginCount: true,
      lastFailedLoginAt: true,
      lockedUntil: true,
    },
  });
  if (row === null) {
    throw new Error(`harness invariant: user ${email} should exist`);
  }
  return row;
}

/**
 * Simulate the wall-clock passage past `lockedUntil`. Writes
 * `lockedUntil` to one minute in the past so the production
 * `LockoutService.isLocked` read (`lockedUntil > now`) returns
 * false. The counter is deliberately left intact — the production
 * code's `recordSuccess` is what clears it, and the test exists to
 * prove that the recordSuccess path runs on the next successful
 * login.
 */
async function expireLockoutWindow(email: string): Promise<void> {
  await harnessPrisma.user.update({
    where: { email },
    data: {
      lockedUntil: new Date(Date.now() - 60_000),
    },
  });
}

/**
 * Drive `count` consecutive bad-password POSTs against /login.
 * Each call hits the real handler — bcrypt cost-12 plus a Postgres
 * round-trip per call — so callers should keep `count` small. The
 * function exists solely as a readability win in the test bodies
 * (the alternative is a `for` loop in every test that needs to
 * trigger the schedule).
 */
async function burnFailures(email: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const res = await callJson('/api/v1/auth/login', {
      body: { email, password: BAD_PASSWORD },
    });
    // Defensive: a regression that changed the failed-login response
    // shape would otherwise surface here as a downstream cascade.
    if (res.status !== 401) {
      throw new Error(`burnFailures expected 401 on attempt ${i + 1}, got ${res.status}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
const TWO_MINUTES_MS = 2 * ONE_MINUTE_MS;
/**
 * Tolerance for lock-deadline assertions. The lock window is
 * computed against the server's `now()` at the moment of the
 * recordFailure write; the test reads `Date.now()` afterwards, so
 * the actual delta will be slightly less than the schedule's raw
 * value. 10 seconds is comfortably wider than the worst-case
 * latency between the recordFailure write and the harness's
 * post-state read (bcrypt cost-12 + a couple of network round-
 * trips ≈ 500ms), while still tight enough to catch a regression
 * that mis-scheduled the lock by a full schedule step.
 */
const LOCK_DEADLINE_TOLERANCE_MS = 10 * ONE_SECOND_MS;

describe('service-identity lockout integration (TS-025-followup-4)', () => {
  describe('schedule against real Postgres', () => {
    it('three failed attempts land a ~60s lock; the users row reflects the schedule', async () => {
      const email = uniqueEmail('three-fail');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      const observedAt = Date.now();
      await burnFailures(email, 3);

      const state = await readLockoutColumns(email);
      expect(state.failedLoginCount).toBe(3);
      expect(state.lastFailedLoginAt).not.toBeNull();
      expect(state.lockedUntil).not.toBeNull();

      // Schedule check: count 3 → 60s from the moment of the
      // recordFailure write. The harness anchors against
      // `observedAt` (captured BEFORE the failures) so the assertion
      // accepts the natural drift between the server clock and the
      // harness clock. The lock MUST be in the future (so the gate
      // would fire on the next login) AND no further than 60s + a
      // tolerance ahead (so the schedule didn't accidentally pick a
      // wider count's lock value).
      const lockMs = state.lockedUntil!.getTime();
      expect(lockMs).toBeGreaterThan(observedAt);
      expect(lockMs).toBeLessThan(observedAt + ONE_MINUTE_MS + LOCK_DEADLINE_TOLERANCE_MS);
      // Lower bound: the lock should be roughly 60s past the
      // recordFailure write, which happened after `observedAt`. The
      // observedAt anchor is conservative — the actual server-side
      // `now()` for the 3rd write is observedAt + (3 bcrypt cycles
      // ≈ 750ms). So the lock must be at least observedAt + 60s -
      // tolerance.
      expect(lockMs).toBeGreaterThan(observedAt + ONE_MINUTE_MS - LOCK_DEADLINE_TOLERANCE_MS);
    });

    it('two failed attempts do NOT lock the account (grace threshold)', async () => {
      const email = uniqueEmail('two-fail-grace');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      await burnFailures(email, 2);

      const state = await readLockoutColumns(email);
      expect(state.failedLoginCount).toBe(2);
      // CLAUDE.md §3.1: the first two failures are tolerated without
      // lock so the legitimate user's password typo doesn't put them
      // in a time-out.
      expect(state.lockedUntil).toBeNull();

      // A correct password during the grace window MUST succeed —
      // the lockout gate has nothing to fire on. The successful
      // login also clears the counter via recordSuccess.
      const ok = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ outcome: 'session' });

      const post = await readLockoutColumns(email);
      expect(post.failedLoginCount).toBe(0);
      expect(post.lastFailedLoginAt).toBeNull();
      expect(post.lockedUntil).toBeNull();
    });

    it('a correct password during the lock window returns the same generic 401 as bad-password (oracle defence)', async () => {
      const email = uniqueEmail('oracle-defence');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      await burnFailures(email, 3);

      // The lock is now active (count 3 → 1m). Presenting the
      // CORRECT password MUST still return 401 — the lockout gate
      // fires after credentials are verified. The body shape MUST
      // match the bad-password 401 exactly (same title, same
      // generic detail, no "you are locked out" leak).
      const locked = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(locked.status).toBe(401);
      expect(locked.body).toMatchObject({
        status: 401,
        title: 'Unauthorized',
      });
      // No session cookie on the locked path — defence against a
      // regression that returned 401 but still set a cookie.
      expect(locked.setCookies).toHaveLength(0);

      // Cross-check the body shape against a bad-password 401 from
      // the SAME locked account — the two responses MUST be
      // indistinguishable from the client's perspective. The detail
      // string is the field a client-side timing / probing attacker
      // would diff on, so a divergence there would be the most
      // damaging.
      const wrongPw = await callJson('/api/v1/auth/login', {
        body: { email, password: BAD_PASSWORD },
      });
      expect(wrongPw.status).toBe(locked.status);
      const lockedBody = locked.body as Record<string, unknown>;
      const wrongPwBody = wrongPw.body as Record<string, unknown>;
      expect(wrongPwBody['title']).toBe(lockedBody['title']);
      expect(wrongPwBody['status']).toBe(lockedBody['status']);
      expect(wrongPwBody['detail']).toBe(lockedBody['detail']);
    });

    it('a 4th failure during the count-3 lock window extends the lock to ~2m (anti-shrinkage)', async () => {
      const email = uniqueEmail('extend-lock');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      // Burn 3 bad-pw attempts to land the count-3 lock (~60s).
      await burnFailures(email, 3);
      const afterThree = await readLockoutColumns(email);
      expect(afterThree.failedLoginCount).toBe(3);
      const initialLockMs = afterThree.lockedUntil!.getTime();

      // 4th bad-pw attempt — recordFailure runs on the bad-password
      // branch even when the lock is already active (the lockout
      // gate is downstream of the credential check, but the
      // recordFailure on the bad-pw branch runs regardless of any
      // pre-existing lock; the schedule's anti-shrinkage rule picks
      // the later of the existing lock and the newly-computed one).
      const observedBeforeFourth = Date.now();
      await burnFailures(email, 1);

      const afterFour = await readLockoutColumns(email);
      expect(afterFour.failedLoginCount).toBe(4);
      const extendedLockMs = afterFour.lockedUntil!.getTime();

      // Anti-shrinkage invariant: the new lock CANNOT be earlier
      // than the previous lock. The schedule's count-4 lock (2m
      // from `now()` of the 4th write) is strictly later than the
      // count-3 lock (1m from `now()` of the 3rd write, which was
      // earlier in wall-clock time), so the chooseLaterLock pick
      // is the count-4 candidate.
      expect(extendedLockMs).toBeGreaterThan(initialLockMs);

      // Schedule check: count 4 → 120s from the moment of the 4th
      // recordFailure write. Anchor on observedBeforeFourth for the
      // same reason as the count-3 test — accepts natural latency
      // drift between the harness clock and the server clock.
      expect(extendedLockMs).toBeLessThan(
        observedBeforeFourth + TWO_MINUTES_MS + LOCK_DEADLINE_TOLERANCE_MS,
      );
      expect(extendedLockMs).toBeGreaterThan(
        observedBeforeFourth + TWO_MINUTES_MS - LOCK_DEADLINE_TOLERANCE_MS,
      );
    });

    it('lock expires → fresh correct password issues a session AND clears the counter', async () => {
      const email = uniqueEmail('post-expiry-clear');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      await burnFailures(email, 3);
      // Confirm the pre-state — count 3, lock in the future.
      const locked = await readLockoutColumns(email);
      expect(locked.failedLoginCount).toBe(3);
      expect(locked.lockedUntil).not.toBeNull();
      expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Simulate the lock expiring (the alternative — waiting the
      // wall-clock 60s — would slow the suite intolerably). The
      // counter is left intact; the recordSuccess path on the next
      // successful login is what's under test.
      await expireLockoutWindow(email);

      const ok = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ outcome: 'session' });

      const cleared = await readLockoutColumns(email);
      // recordSuccess clears all three lockout-policy columns in a
      // single UPDATE — atomic per Postgres, so the cleared state
      // must be consistent. A regression that cleared only some of
      // the columns would surface here.
      expect(cleared.failedLoginCount).toBe(0);
      expect(cleared.lastFailedLoginAt).toBeNull();
      expect(cleared.lockedUntil).toBeNull();
    });

    it('isLocked is the gate: writing lockedUntil to a past instant releases the gate without a counter reset', async () => {
      // Defends the LockoutService class-header invariant: "Lock
      // expiry. We deliberately do NOT auto-clear an expired
      // `lockedUntil` on read." The release path is the time-based
      // comparison in `isLocked`, NOT a database side-effect. The
      // counter is cleared only on a successful login via
      // recordSuccess. This test pins the contract: a manually-
      // expired lock releases the gate even with the counter still
      // at 3, and the next successful login is what clears the
      // counter.
      const email = uniqueEmail('gate-not-side-effect');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      await burnFailures(email, 3);
      // Manually expire the lock. The counter stays at 3 — proving
      // the gate is a pure comparison, not a counter-derived
      // computation.
      await expireLockoutWindow(email);
      const preLogin = await readLockoutColumns(email);
      expect(preLogin.failedLoginCount).toBe(3);
      expect(preLogin.lockedUntil!.getTime()).toBeLessThan(Date.now());

      // Bad-pw during the released-but-not-yet-cleared window:
      // recordFailure runs against the EXISTING counter of 3, so it
      // increments to 4 AND writes a count-4 lock (2m). The
      // schedule's anti-shrinkage rule picks the later of the
      // expired lock (in the past) and the count-4 lock candidate
      // (now+2m), so the new lock is now+2m.
      const observedAt = Date.now();
      await burnFailures(email, 1);

      const post = await readLockoutColumns(email);
      expect(post.failedLoginCount).toBe(4);
      expect(post.lockedUntil!.getTime()).toBeGreaterThan(observedAt);
      // Count-4 schedule → 2m from `now()` of the 4th failure.
      expect(post.lockedUntil!.getTime()).toBeLessThan(
        observedAt + TWO_MINUTES_MS + LOCK_DEADLINE_TOLERANCE_MS,
      );
    });
  });
});
