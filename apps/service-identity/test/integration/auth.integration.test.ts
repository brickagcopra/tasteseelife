/**
 * TS-009e-followup-3 / TS-022-followup-5 — end-to-end auth integration.
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the auth surface over HTTP — proving the
 * wire contract from the controller boundary down to the database
 * and the Idempotency-Key cache (CLAUDE.md §3.1, §3.3).
 *
 * Scope:
 *
 *   1. **Signup → login → refresh → logout** happy path. Verifies
 *      Set-Cookie attribute serialisation, JSON body shapes against
 *      the contract package, and that rotation actually changes the
 *      `tns_refresh` value on the wire.
 *
 *   2. **Reuse-detection invariant** (CLAUDE.md §3.1 / OWASP ASVS
 *      V3.2.4 / `RefreshTokenService.rotate`). A presented refresh
 *      token whose row has already been exchanged once must (a)
 *      return 401 and (b) cause EVERY other token in the same family
 *      to be revoked — including the most-recent rotation. The unit
 *      test in `refresh-token.service.test.ts` covers the SQL; this
 *      test proves the HTTP boundary preserves the invariant under
 *      real cookie parsing + a real Postgres transaction.
 *
 *   3. **Lockout-state oracle defence** (CLAUDE.md §3.1, TS-025).
 *      Bad-password, no-such-user, and inactive-status all collapse
 *      to the same generic 401 body — verified via a single
 *      pending_verification account that we deliberately don't
 *      activate.
 *
 * Why the real AppModule, not a hand-rolled test module? The unit
 * tests already mock every collaborator. The integration gap is
 * wire-level: cookie attribute drift, transaction interleaving
 * under real Postgres, Idempotency-Key replay-cache wiring,
 * RfcProblemFilter shaping. Those only fail when every layer is
 * present.
 *
 * Why not supertest? The library is not on CLAUDE.md §13 approved
 * list. Node 22's native `fetch` plus `app.listen(0, '127.0.0.1')`
 * cover the same surface and avoid another dependency.
 *
 * References: PDD §24.1; CLAUDE.md §3.1, §3.3, §9.1; TS-009e canonical
 * test in `test/integration/wiring.integration.test.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { createIsolatedDatabase, type IsolatedDatabaseHandle } from '@taste-and-see/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');
const REFRESH_COOKIE_NAME = 'tns_refresh';

let database: IsolatedDatabaseHandle;
let app: INestApplication;
let baseUrl: string;

/**
 * Direct Prisma handle used only by the test harness — for one
 * narrow purpose: flipping a signed-up account from
 * `pending_verification` to `active` so it can log in. There is no
 * verification HTTP surface today (TS-021 ships signup only; an
 * email/SMS verify flow lands with a later task), so the harness
 * stands in for that future surface. The handle is NOT used to
 * synthesise any state the production code is responsible for —
 * every other write in this file goes through the real HTTP
 * endpoints.
 *
 * Statically imported from `src/prisma/prisma.service.ts` rather
 * than via the `@prisma/client` namespace — same shape, same client,
 * with proper type inference for `user.update` / `refreshToken.findMany`
 * without crossing the namespace-value-side resolution issue
 * documented in TS-021-followup-2.
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The shared Redis
  // URL is read directly from the globalSetup-provided value. The
  // CREATE DATABASE + `prisma migrate deploy` invocation that used to
  // live verbatim in this file now lives in
  // `packages/testing/src/integration/isolated-database.ts` — single
  // source of truth.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'identity_test_auth',
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
  // secrets, and the schema's `min(32)` / "base64 32-byte" floors
  // would reject placeholder values anyway.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = database.databaseUrl;
  process.env.REDIS_URL = inject('redisUrl');
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64');
  process.env.MFA_TOTP_ENC_KEY = randomBytes(32).toString('base64');
  process.env.MFA_CHALLENGE_SECRET = randomBytes(48).toString('base64');
  // Non-empty placeholders — Stripe is never actually called in this
  // test (we hit no KYC endpoint). The schema's `min(20)` / URL
  // validation is the only contract here.
  process.env.STRIPE_SECRET_KEY = `sk_test_${randomBytes(16).toString('hex')}`;
  process.env.STRIPE_IDENTITY_RETURN_URL = 'https://example.test/kyc/return';
  process.env.KYC_PAYLOAD_ENC_KEY = randomBytes(32).toString('base64');
  process.env.KYC_WEBHOOK_INTERNAL_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_RECIPIENT_CONTACTS_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_PRIVACY_EXPORT_API_KEY = randomBytes(32).toString('base64');
  // HTTP, not HTTPS — refresh cookie must work over plain HTTP for
  // the test to round-trip through `127.0.0.1`. Production sets this
  // to `true` (or omits it) — verified by the `env.test.ts` defaults.
  process.env.REFRESH_COOKIE_SECURE = 'false';
  // Short access-token TTL so a future test can assert the
  // `expiresIn` value without depending on the 900s default — and
  // the same number doesn't accidentally line up with another
  // off-by-one.
  process.env.JWT_ACCESS_TTL_SECONDS = '120';
  // Lower idempotency in-flight TTL so a slow assertion never wedges
  // the cache slot for the default 60s.
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = '5';
  // TS-025-followup-1 — the integration suite shares one Redis
  // instance across every test file (per the globalSetup pattern),
  // and the IP circuit breaker counter is bucketed per source IP
  // per fixed-window. Loopback fetch means every integration test
  // hits the breaker against the same `127.0.0.1` bucket; without
  // a per-suite override the breaker would trip mid-suite once
  // cumulative bad-login attempts cross the 30 default. Bump the
  // threshold high enough that no realistic suite hits it. Sibling
  // integration tests carry the same override.
  process.env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW = '100000';

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
  // here we want IPv4 loopback so `fetch(baseUrl)` reliably
  // resolves across Linux / macOS / Windows CI runners without
  // pulling in the dual-stack resolver's edge cases.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  // Some Nest builds report `http://[::1]:NNNN` even when listening
  // on 127.0.0.1 — normalise so fetch always sees an IPv4 host.
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client. Used solely to flip a signed-up
  // account to `active`. The production AppModule's PrismaService is
  // running inside Nest with its own connection — this is a separate
  // process-local client with no DI overlap.
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
// HTTP + cookie helpers. Deliberately minimal — every call shapes its
// own headers and the helper returns enough of the Response that
// individual tests can assert on status, JSON body, and Set-Cookie
// without re-parsing the same boilerplate.
// ─────────────────────────────────────────────────────────────────────

interface AuthResponse {
  readonly status: number;
  readonly body: unknown;
  readonly setCookies: readonly string[];
}

async function callJson(
  path: string,
  init: { body?: unknown; cookie?: string; idempotencyKey?: string } = {},
): Promise<AuthResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  // 204 has no body; reading it as JSON would throw — read text first.
  const raw = await response.text();
  let body: unknown = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  // Node 22's fetch surfaces multi-valued Set-Cookie via the dedicated
  // `getSetCookie()` accessor — a single `headers.get('set-cookie')`
  // call concatenates multiple cookies into one comma-joined string
  // that's ambiguous to re-split (cookie attributes can contain `,`
  // in Expires dates). Use the accessor for fidelity.
  const setCookies = response.headers.getSetCookie();
  return { status: response.status, body, setCookies };
}

/**
 * Extract the `tns_refresh=VALUE` substring from the Set-Cookie list
 * that the controller emits. Returns null when no refresh-cookie
 * directive is present (e.g. the controller cleared the cookie on
 * the 401 path).
 *
 * The returned `value` is empty (`""`) on a clear-cookie directive
 * (`tns_refresh=; Expires=Thu, 01 Jan 1970 ...`). Callers that need
 * to distinguish "set a fresh cookie" from "clear the cookie"
 * inspect `clear` rather than the value alone.
 */
function extractRefreshCookie(setCookies: readonly string[]): {
  readonly raw: string;
  readonly value: string;
  readonly clear: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: string;
  readonly path: string;
} | null {
  for (const header of setCookies) {
    const firstSemi = header.indexOf(';');
    const pair = firstSemi === -1 ? header : header.slice(0, firstSemi);
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== REFRESH_COOKIE_NAME) continue;
    const value = pair.slice(eq + 1);

    const attrs = header
      .slice(firstSemi === -1 ? header.length : firstSemi + 1)
      .split(/;\s*/)
      .filter((a) => a.length > 0);
    const flags = new Set(attrs.map((a) => a.toLowerCase()));
    const valueMap: Record<string, string> = {};
    for (const a of attrs) {
      const e = a.indexOf('=');
      if (e > 0) valueMap[a.slice(0, e).toLowerCase()] = a.slice(e + 1);
    }

    // A clear-cookie directive is emitted by `response.clearCookie`,
    // which express renders as an empty value + a past `Expires`.
    // Either signal is sufficient — match on both so a future
    // express version that omits one side still flags the clear.
    const clear =
      value === '' ||
      (valueMap['expires'] !== undefined && new Date(valueMap['expires']).getTime() < Date.now());

    return {
      raw: `${REFRESH_COOKIE_NAME}=${value}`,
      value,
      clear,
      httpOnly: flags.has('httponly'),
      sameSite: valueMap['samesite'] ?? '',
      path: valueMap['path'] ?? '',
    };
  }
  return null;
}

/**
 * Generate a per-test email that won't collide with sibling tests
 * across the same Postgres container. The PID-suffixed seed is
 * what defeats accidental dedup if a future runner re-uses email
 * fragments across describe blocks.
 */
let emailSeed = 0;
function uniqueEmail(prefix = 'user'): string {
  emailSeed += 1;
  return `${prefix}+${process.pid}+${Date.now()}+${emailSeed}@tastesee.test`;
}

const VALID_PASSWORD = 'P@ssw0rd-correct-horse-battery-staple';

/**
 * Activate a freshly-signed-up account. Stands in for the future
 * email-verification surface (no such endpoint exists today —
 * TS-021 deliberately ships signup only). The harness write is the
 * minimum needed to exercise login on the active-status branch.
 */
async function activateAccount(email: string): Promise<void> {
  await harnessPrisma.user.update({
    where: { email },
    data: { status: 'active' },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('service-identity auth integration (TS-022-followup-5)', () => {
  describe('signup', () => {
    it('returns 201 + a contract-shaped user', async () => {
      const email = uniqueEmail('signup-happy');
      const res = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        email,
        status: 'pending_verification',
        phone: null,
      });
      const body = res.body as { id: string; createdAt: string };
      expect(body.id).toMatch(/^[a-z0-9]+$/); // CUID-ish
      // ISO-8601 sanity — the contract enforces `.datetime()` so a
      // raw Date.toString() leak would surface here.
      expect(() => new Date(body.createdAt).toISOString()).not.toThrow();
      expect(res.setCookies).toHaveLength(0);
    });

    it('returns 409 on duplicate email (P2002 unique-constraint mapping)', async () => {
      const email = uniqueEmail('signup-dupe');
      const first = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(first.status).toBe(201);

      const second = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(second.status).toBe(409);
      // RFC 7807 shape — title + detail + status. The detail is
      // deliberately generic (no "email already exists" enumeration
      // signal — same defence as the login flow).
      expect(second.body).toMatchObject({
        status: 409,
        title: 'Conflict',
      });
    });

    it('rejects unknown fields at the contract boundary (.strict())', async () => {
      const email = uniqueEmail('signup-strict');
      const res = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD, rememberMe: true },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('login', () => {
    it('on a pending_verification account → generic 401', async () => {
      const email = uniqueEmail('login-pending');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      // Deliberately NOT activated — login must refuse even with the
      // correct password.
      const res = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ status: 401, title: 'Unauthorized' });
      expect(res.setCookies).toHaveLength(0);
    });

    it('on an unknown email → generic 401 (no enumeration)', async () => {
      const res = await callJson('/api/v1/auth/login', {
        body: { email: uniqueEmail('login-nobody'), password: VALID_PASSWORD },
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ status: 401, title: 'Unauthorized' });
    });

    it('on an active account with wrong password → 401', async () => {
      const email = uniqueEmail('login-badpw');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      const res = await callJson('/api/v1/auth/login', {
        body: { email, password: 'not-the-real-one' },
      });
      expect(res.status).toBe(401);
      expect(res.setCookies).toHaveLength(0);
    });

    it('on an active account with right password → 200 + session + cookie', async () => {
      const email = uniqueEmail('login-happy');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      const res = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(res.status).toBe(200);

      // Body shape — LoginSessionResponse (outcome=session). The
      // contract carries `accessToken`, `tokenType: 'Bearer'`,
      // `expiresIn`, and a minimal `user` summary.
      expect(res.body).toMatchObject({
        outcome: 'session',
        tokenType: 'Bearer',
        user: { email, status: 'active' },
      });
      const body = res.body as { accessToken: string; expiresIn: number };
      expect(body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // JWT shape
      // We pinned JWT_ACCESS_TTL_SECONDS=120 above — verifies the
      // env actually reached the token service via DI.
      expect(body.expiresIn).toBe(120);

      // Refresh cookie attributes — CLAUDE.md §3.1 enforces
      // HttpOnly + SameSite=Lax + scoped path. Secure is false here
      // because REFRESH_COOKIE_SECURE=false in this env.
      const cookie = extractRefreshCookie(res.setCookies);
      expect(cookie).not.toBeNull();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite.toLowerCase()).toBe('lax');
      expect(cookie?.path).toBe('/api/v1/auth');
      expect(cookie?.clear).toBe(false);
      expect(cookie?.value.length).toBeGreaterThan(0);
    });
  });

  describe('refresh rotation + reuse detection', () => {
    /**
     * The canonical CLAUDE.md §3.1 invariant captured end-to-end:
     *
     *   login   → T1
     *   refresh → T2 (T1 rotated)
     *   refresh with T1 (replay) → 401 + family revoked
     *   refresh with T2 (the "winner")   → 401 (family revoked above)
     *
     * The replay on T1 is what an attacker holding a stolen token
     * looks like. The platform doesn't know if the legitimate user
     * or the attacker won the race, so the safe default is to revoke
     * the whole family — which means the legitimate user's T2 also
     * stops working until they re-authenticate.
     */
    it('rotates on refresh and revokes the family on replay of an already-rotated token', async () => {
      const email = uniqueEmail('refresh-reuse');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      const login = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(login.status).toBe(200);
      const cookie1 = extractRefreshCookie(login.setCookies);
      expect(cookie1?.value.length).toBeGreaterThan(0);

      // First refresh rotates T1 → T2.
      const refresh1 = await callJson('/api/v1/auth/refresh', {
        cookie: cookie1!.raw,
      });
      expect(refresh1.status).toBe(200);
      const cookie2 = extractRefreshCookie(refresh1.setCookies);
      expect(cookie2).not.toBeNull();
      expect(cookie2!.value.length).toBeGreaterThan(0);
      // The rotated value MUST differ from the original — that's
      // the whole point of rotation. If they were equal we'd be
      // shipping a non-rotating refresh (CLAUDE.md §17.4 territory).
      expect(cookie2!.value).not.toBe(cookie1!.value);

      // Replay of T1 — the row already has `rotatedAt != null`, so
      // `RefreshTokenService.rotate` returns `reason: 'reused'` and
      // the whole family is revoked in the same transaction.
      const replay = await callJson('/api/v1/auth/refresh', {
        cookie: cookie1!.raw,
      });
      expect(replay.status).toBe(401);
      // 401 path clears the cookie — defence so a stale credential
      // doesn't keep hanging around in the browser jar.
      const clearedOnReplay = extractRefreshCookie(replay.setCookies);
      expect(clearedOnReplay?.clear).toBe(true);

      // T2 now fails too — the family was revoked by the replay
      // above. This is the load-bearing assertion: WITHOUT
      // family-revocation, T2 would still work and an attacker who
      // had T1 (but not T2) would just re-auth against the
      // legitimate user. The unit test asserts the SQL; this test
      // asserts the HTTP layer didn't fan-out around the contract.
      const t2Replay = await callJson('/api/v1/auth/refresh', {
        cookie: cookie2!.raw,
      });
      expect(t2Replay.status).toBe(401);

      // Optional: cross-check the DB. Every row in the family
      // should be revoked. We look up by user id via the harness
      // Prisma. Bounded to a small N — only T1's row + T2's row
      // exist in the family.
      const userRow = await harnessPrisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      // Defensive null check (vitest's `expect(...).not.toBeNull()`
      // doesn't narrow the type at compile time). Throwing fails the
      // test with a clearer stack than the downstream NPE would.
      if (userRow === null) throw new Error(`harness invariant: user ${email} should exist`);
      const tokens = await harnessPrisma.refreshToken.findMany({
        where: { userId: userRow.id },
        select: { id: true, revokedAt: true, rotatedAt: true },
      });
      expect(tokens.length).toBeGreaterThanOrEqual(2);
      for (const t of tokens) {
        expect(t.revokedAt).not.toBeNull();
      }
    });

    it('returns 401 for a refresh with no cookie', async () => {
      const res = await callJson('/api/v1/auth/refresh', {});
      expect(res.status).toBe(401);
    });

    it('returns 401 for a refresh with an unknown cookie value', async () => {
      const res = await callJson('/api/v1/auth/refresh', {
        cookie: `${REFRESH_COOKIE_NAME}=not-a-real-token-${randomBytes(16).toString('hex')}`,
      });
      expect(res.status).toBe(401);
    });
  });

  describe('logout', () => {
    it('revokes the presented family + clears the cookie', async () => {
      const email = uniqueEmail('logout-happy');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);

      const login = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      const cookie = extractRefreshCookie(login.setCookies);
      expect(cookie?.value.length).toBeGreaterThan(0);

      const logout = await callJson('/api/v1/auth/logout', {
        cookie: cookie!.raw,
      });
      expect(logout.status).toBe(204);
      const cleared = extractRefreshCookie(logout.setCookies);
      expect(cleared?.clear).toBe(true);

      // Post-logout, the same refresh value must no longer work.
      // Logout does NOT trigger reuse-detection (CLAUDE.md spirit —
      // user's intent was "end session", not "report theft"), but
      // the family IS revoked, so /refresh returns 401.
      const afterLogout = await callJson('/api/v1/auth/refresh', {
        cookie: cookie!.raw,
      });
      expect(afterLogout.status).toBe(401);
    });

    it('returns 204 when no cookie is presented (idempotent)', async () => {
      const res = await callJson('/api/v1/auth/logout', {});
      expect(res.status).toBe(204);
    });

    it('returns 204 when an unknown cookie is presented (no enumeration)', async () => {
      const res = await callJson('/api/v1/auth/logout', {
        cookie: `${REFRESH_COOKIE_NAME}=not-a-real-token-${randomBytes(16).toString('hex')}`,
      });
      expect(res.status).toBe(204);
    });
  });

  describe('signup idempotency cache (TS-044-followup-2 wiring)', () => {
    /**
     * The signup endpoint is the only `@Idempotent()`-decorated
     * controller method in service-identity today. A second POST
     * with the SAME body AND the SAME Idempotency-Key MUST replay
     * the cached 201 instead of re-hitting the handler (which
     * would surface as a confusing 409 from the unique-email
     * constraint). This test proves the Redis-backed cache is
     * actually wired into the AppModule, not just declared.
     */
    it('replays the cached response for a same-body retry under the same Idempotency-Key', async () => {
      const email = uniqueEmail('idem-replay');
      const key = `idem-${randomBytes(16).toString('hex')}`;

      const first = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
        idempotencyKey: key,
      });
      expect(first.status).toBe(201);
      const firstId = (first.body as { id: string }).id;

      // Same key, same body — replay should return the EXACT same
      // 201 response (including the same row id). Without the
      // cache, the natural unique-email constraint would surface
      // as a 409 instead.
      const replay = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
        idempotencyKey: key,
      });
      expect(replay.status).toBe(201);
      expect((replay.body as { id: string }).id).toBe(firstId);
    });

    it('rejects a same-key + different-body retry as a conflict', async () => {
      const key = `idem-${randomBytes(16).toString('hex')}`;
      const first = await callJson('/api/v1/auth/signup', {
        body: { email: uniqueEmail('idem-diff-1'), password: VALID_PASSWORD },
        idempotencyKey: key,
      });
      expect(first.status).toBe(201);

      // Same Idempotency-Key, different body — the cache should
      // see the body-hash mismatch and reject as 409 (NOT replay,
      // because we'd be lying about what the original request was).
      const conflict = await callJson('/api/v1/auth/signup', {
        body: { email: uniqueEmail('idem-diff-2'), password: VALID_PASSWORD },
        idempotencyKey: key,
      });
      expect(conflict.status).toBe(409);
    });
  });
});
