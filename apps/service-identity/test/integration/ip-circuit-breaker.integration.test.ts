/**
 * TS-025-followup-1b — end-to-end IP circuit breaker integration.
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the IP-level credential-stuffing guard
 * (TS-025-followup-1; CLAUDE.md §3.1) over HTTP. The unit-test surface
 * in `ip-circuit-breaker.service.test.ts` covers the service in
 * isolation against a FakeRedis; this test catches the wire-level
 * cases the unit suite cannot reach:
 *
 *   - the controller's `extractClientIp` actually routes through to
 *     `IpCircuitBreakerService.checkBlocked` / `recordFailure`,
 *   - the breaker's Redis `INCR + EXPIRE` pipeline lands real keys
 *     under the CLAUDE.md §3.7-mandated namespaced shape,
 *   - the fixed-window roll fires against real wall-clock + real
 *     Redis TTL semantics (not a FakeRedis short-circuit), and
 *   - the integration boundary between the breaker and the per-user
 *     `LockoutService` doesn't double-count: a tripped breaker
 *     short-circuits BEFORE the user lookup, so the per-user counter
 *     stays still on the blocked path.
 *
 * Load-bearing properties asserted end-to-end:
 *
 *   1. **Threshold honoured against real Redis.** Exactly `THRESHOLD`
 *      bad-password attempts from one IP fill the breaker bucket;
 *      attempt `THRESHOLD + 1` is rejected with the SAME generic 401
 *      that bad-password yields (byte-identical RFC 7807 body —
 *      title / status / detail). The unit suite covers the
 *      decision logic against a Map-backed FakeRedis; this test
 *      proves the live `multi().incr().expire().exec()` pipeline
 *      produces the same observable behaviour against real Redis.
 *
 *   2. **No DB read on the blocked path.** Once the breaker is
 *      tripped, subsequent attempts short-circuit BEFORE the user
 *      lookup in `AuthService.login`. The proof: the per-user
 *      `failed_login_count` does NOT advance across the blocked
 *      attempts (the user lookup is skipped, so the bad-password
 *      branch's `lockout.recordFailure(user.id)` is never reached).
 *      A regression that moved the breaker check downstream of the
 *      user lookup would surface here.
 *
 *   3. **No oracle on the blocked path.** A CORRECT password from a
 *      blocked IP still returns the same generic 401 — no "rate
 *      limited" leak, no Set-Cookie, no enumerable signal. The
 *      blocked-IP 401 is indistinguishable from the bad-password
 *      401 from the perspective of the wire.
 *
 *   4. **No double-count on the blocked path.** Repeated attempts
 *      against a tripped IP do NOT keep incrementing the bucket
 *      (the blocked path doesn't call `recordFailure`). The unit
 *      test proves the SERVICE doesn't double-count when called;
 *      this test proves the AUTH layer doesn't call the service on
 *      the blocked path in the first place.
 *
 *   5. **Per-IP isolation.** A separate IP's first attempt is NOT
 *      blocked even when a sibling IP is fully tripped — the bucket
 *      key includes a per-IP hash so cross-IP keys cannot collide.
 *      Defends against a regression that flattened the bucket-key
 *      shape across IPs (e.g. dropped the `:{ipHash}:` segment).
 *
 *   6. **Window roll releases the bucket.** After the configured
 *      `LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS` window passes, the next
 *      attempt lands in a fresh bucket (`floor(now / window)` ticks
 *      up) so a correct-password login from the previously-blocked
 *      IP succeeds. The fixed-window algorithm is the central
 *      property — without this, a tripped IP would be locked
 *      forever and the breaker would be a denial-of-service vector
 *      rather than a credential-stuffing guard.
 *
 *   7. **CLAUDE.md §3.7 key shape.** Every bucket key that lands in
 *      Redis MUST match `{env}:service-identity:login-ip-rate:{ipHash}:{window}`
 *      — no raw IP, no missing env prefix. A regression that
 *      dropped the env prefix would let staging probes leak into
 *      production buckets when both connect to the same Redis.
 *
 * Why a smaller threshold + shorter window than production. The
 * production defaults are 30 / 300 (CLAUDE.md §3.1). The algorithm is
 * threshold- and window-agnostic — proving the loop at THRESHOLD=5 /
 * WINDOW=5s costs ~10 s of wall-clock (5 bcrypt cost-12 cycles + 1
 * window-roll sleep), where production defaults would cost ~10 min.
 * The unit suite carries identical assertions parameterised at
 * production defaults; this file is about wire integration, not
 * production threshold validation.
 *
 * Why distinct `203.0.113.x` IPs per test. Every integration test in
 * this suite shares one Redis instance (TS-009e-followup-2 shared
 * containers). Sibling files (auth / mfa / rbac / lockout) override
 * `LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW=100000` to keep their loopback
 * bucket out of the way; this file deliberately drives the breaker
 * with `THRESHOLD=5` so cross-file collisions WOULD trip the
 * breaker mid-test. Using IPs in the RFC 5737 documentation /24
 * (`203.0.113.0/24`) — outside any address space the loopback fetch
 * would naturally use — guarantees no sibling file's loopback
 * attempts can interfere with this file's per-IP buckets.
 *
 * Why no supertest. Same as the sibling integration tests — supertest
 * is not on CLAUDE.md §13 approved list. Node 22's native `fetch` +
 * `app.listen(0, '127.0.0.1')` cover the same surface; the
 * `x-forwarded-for` header is the controller's documented IP
 * extraction path (per `extractClientIp` in `auth.controller.ts`).
 *
 * References: PDD §24.1; CLAUDE.md §3.1, §3.7, §9.1;
 * TS-009e-followup-3 / TS-022-followup-5 canonical pattern in
 * `auth.integration.test.ts`; `ip-circuit-breaker.service.ts` for the
 * algorithm under test.
 */

import 'reflect-metadata';

import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplication } from '@nestjs/common';
import { createIsolatedDatabase, type IsolatedDatabaseHandle } from '@taste-and-see/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');

/**
 * Test-only threshold + window. Small enough that the burn loop
 * costs ~1.5 s of bcrypt + the window roll costs ~6 s of real sleep
 * — well under vitest's 60 s testTimeout. Production defaults
 * (30 / 300) are covered by the unit suite.
 */
const BREAKER_THRESHOLD = 5;
const BREAKER_WINDOW_SECONDS = 5;

let database: IsolatedDatabaseHandle;
let app: INestApplication;
let baseUrl: string;
let harnessPrisma: PrismaService;
let harnessRedis: Redis;
/**
 * Bucket-key prefix mirroring `IpCircuitBreakerService.keyPrefix`.
 * Computed once at boot from the env we set below so a regression
 * that changed the shape would surface here as a `keys()` mismatch
 * rather than a passing test.
 */
let keyPrefix: string;

beforeAll(async () => {
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'identity_test_ip_circuit_breaker',
    serviceRoot: SERVICE_ROOT,
  });

  // ── Env wiring ────────────────────────────────────────────────────
  //
  // `app.module.ts` evaluates `loadEnv()` at module-load time, so the
  // env block MUST land before the dynamic AppModule import below.
  // Mirrors the canonical TS-022-followup-5 pattern in
  // `auth.integration.test.ts`.
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
  process.env.REFRESH_COOKIE_SECURE = 'false';
  process.env.JWT_ACCESS_TTL_SECONDS = '120';
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = '5';
  // Override the breaker defaults for fast end-to-end exercise.
  // Production defaults of 30 / 300 are covered by the unit suite.
  process.env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW = String(BREAKER_THRESHOLD);
  process.env.LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS = String(BREAKER_WINDOW_SECONDS);

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
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Harness-only Prisma client. Used solely to flip
  // `pending_verification` → `active` and to read the per-user
  // `failed_login_count` column for the "no DB read on blocked path"
  // assertion. Mirrors the sibling auth integration test's harness
  // pattern.
  harnessPrisma = new PrismaService({ datasourceUrl: database.databaseUrl });
  await harnessPrisma.onModuleInit();

  // Dedicated ioredis client for harness inspection — separate
  // connection from the Nest-managed client so the harness's
  // `keys()` + `get()` reads can't interfere with the breaker's
  // INCR + EXPIRE pipeline timing. Same Redis instance, same DB 0.
  harnessRedis = new Redis(inject('redisUrl'));

  keyPrefix = `${process.env.NODE_ENV}:service-identity:login-ip-rate`;
});

afterAll(async () => {
  if (harnessRedis) {
    await harnessRedis.quit();
  }
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
// HTTP + harness helpers
// ─────────────────────────────────────────────────────────────────────

interface AuthResponse {
  readonly status: number;
  readonly body: unknown;
  readonly setCookies: readonly string[];
}

/**
 * POST a JSON body. Supports an `x-forwarded-for` header so the test
 * can control the IP the breaker sees (the controller's
 * `extractClientIp` prefers `x-forwarded-for` over the socket remote
 * address — see `auth.controller.ts` for the precedence chain).
 */
async function callJson(
  path: string,
  init: { body?: unknown; cookie?: string; forwardedFor?: string } = {},
): Promise<AuthResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.forwardedFor !== undefined) headers['x-forwarded-for'] = init.forwardedFor;

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

let emailSeed = 0;
function uniqueEmail(prefix = 'ipbreaker'): string {
  emailSeed += 1;
  return `${prefix}+${process.pid}+${Date.now()}+${emailSeed}@tastesee.test`;
}

/**
 * Generate a unique source IP for the test case. Uses the RFC 5737
 * documentation /24 (`203.0.113.0/24`) so no sibling integration
 * test's loopback bucket can collide. Each call returns a fresh IP
 * so two cases in the same file also don't share a bucket.
 */
let ipSeed = 100;
function uniqueIp(): string {
  ipSeed += 1;
  return `203.0.113.${ipSeed}`;
}

const VALID_PASSWORD = 'P@ssw0rd-correct-horse-battery-staple';
const BAD_PASSWORD = 'not-the-real-one';

async function activateAccount(email: string): Promise<void> {
  await harnessPrisma.user.update({
    where: { email },
    data: { status: 'active' },
  });
}

async function readFailedLoginCount(email: string): Promise<number> {
  const row = await harnessPrisma.user.findUnique({
    where: { email },
    select: { failedLoginCount: true },
  });
  if (row === null) {
    throw new Error(`harness invariant: user ${email} should exist`);
  }
  return row.failedLoginCount;
}

/**
 * Read the breaker bucket counter for `ip` at the CURRENT window.
 * Mirrors `IpCircuitBreakerService.bucketKey` exactly — keep in
 * sync if the production key shape ever changes. Returns null when
 * the key is absent (a key that's been TTL'd away by Redis between
 * the write and this read, or a key that was never written).
 */
async function readBucketCount(ip: string): Promise<number | null> {
  const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 16);
  const window = Math.floor(Date.now() / 1000 / BREAKER_WINDOW_SECONDS);
  const key = `${keyPrefix}:${ipHash}:${window}`;
  const raw = await harnessRedis.get(key);
  return raw === null ? null : Number(raw);
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('service-identity IP circuit breaker integration (TS-025-followup-1b)', () => {
  it('THRESHOLD bad-password attempts trip the breaker; the next attempt is blocked with a byte-identical 401', async () => {
    const ip = uniqueIp();
    const email = uniqueEmail('block-threshold');
    await callJson('/api/v1/auth/signup', { body: { email, password: VALID_PASSWORD } });
    await activateAccount(email);

    // First bad-pw attempt captures the reference 401 body shape
    // BEFORE the bucket fills, so we can byte-compare against the
    // blocked-path 401 below. Bucket: 0 → 1.
    const referenceBadPw = await callJson('/api/v1/auth/login', {
      body: { email, password: BAD_PASSWORD },
      forwardedFor: ip,
    });
    expect(referenceBadPw.status).toBe(401);
    expect(referenceBadPw.setCookies).toHaveLength(0);

    // Burn (THRESHOLD - 1) more bad-pw attempts to fill the bucket
    // exactly to the threshold. Bucket: 1 → 2 → 3 → 4 → 5.
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) {
      const res = await callJson('/api/v1/auth/login', {
        body: { email, password: BAD_PASSWORD },
        forwardedFor: ip,
      });
      expect(res.status).toBe(401);
    }
    expect(await readBucketCount(ip)).toBe(BREAKER_THRESHOLD);

    // Snapshot the per-user counter pre-block. The next attempt's
    // post-state read must MATCH this — no DB write means the
    // breaker short-circuited before the user lookup.
    const failedCountBeforeBlock = await readFailedLoginCount(email);

    // Attempt (THRESHOLD + 1): breaker is tripped, request short-
    // circuits before the user lookup. Body MUST be byte-identical
    // to the reference bad-password 401 (no rate-limited oracle).
    const blocked = await callJson('/api/v1/auth/login', {
      body: { email, password: BAD_PASSWORD },
      forwardedFor: ip,
    });
    expect(blocked.status).toBe(401);
    expect(blocked.setCookies).toHaveLength(0);
    const blockedBody = blocked.body as Record<string, unknown>;
    const referenceBody = referenceBadPw.body as Record<string, unknown>;
    expect(blockedBody['title']).toBe(referenceBody['title']);
    expect(blockedBody['status']).toBe(referenceBody['status']);
    expect(blockedBody['detail']).toBe(referenceBody['detail']);
    expect(blockedBody['type']).toBe(referenceBody['type']);

    // No DB read on the blocked path: per-user counter unchanged.
    expect(await readFailedLoginCount(email)).toBe(failedCountBeforeBlock);

    // No double-count on the blocked path: the bucket counter MUST
    // stay at THRESHOLD even after the blocked attempt. The auth
    // service does not call `recordFailure` on the breaker short-
    // circuit path — a regression that called it would push the
    // bucket to THRESHOLD + 1 here.
    expect(await readBucketCount(ip)).toBe(BREAKER_THRESHOLD);

    // Same generic 401 with the CORRECT password from a blocked IP
    // — no oracle for "this email has valid credentials". The user
    // lookup is skipped so the lockout gate is never consulted; the
    // breaker is the only gate that fires.
    const blockedWithCorrectPw = await callJson('/api/v1/auth/login', {
      body: { email, password: VALID_PASSWORD },
      forwardedFor: ip,
    });
    expect(blockedWithCorrectPw.status).toBe(401);
    expect(blockedWithCorrectPw.setCookies).toHaveLength(0);
    // Same byte-identical body shape — defends the no-oracle property
    // against the correct-password path specifically.
    const blockedOkBody = blockedWithCorrectPw.body as Record<string, unknown>;
    expect(blockedOkBody['title']).toBe(referenceBody['title']);
    expect(blockedOkBody['detail']).toBe(referenceBody['detail']);
  });

  it('per-IP isolation: a different IP is not blocked even when a sibling IP is fully tripped', async () => {
    const attackerIp = uniqueIp();
    const innocentIp = uniqueIp();
    // Decoy account that the attacker can burn against without
    // contaminating the innocent user's per-user lockout state.
    const decoyEmail = uniqueEmail('iso-decoy');
    await callJson('/api/v1/auth/signup', {
      body: { email: decoyEmail, password: VALID_PASSWORD },
    });
    await activateAccount(decoyEmail);
    // Innocent account that the innocent IP will log in to.
    const innocentEmail = uniqueEmail('iso-innocent');
    await callJson('/api/v1/auth/signup', {
      body: { email: innocentEmail, password: VALID_PASSWORD },
    });
    await activateAccount(innocentEmail);

    // Trip the attacker IP fully.
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      const res = await callJson('/api/v1/auth/login', {
        body: { email: decoyEmail, password: BAD_PASSWORD },
        forwardedFor: attackerIp,
      });
      expect(res.status).toBe(401);
    }
    expect(await readBucketCount(attackerIp)).toBe(BREAKER_THRESHOLD);

    // Innocent IP's bucket has never been written — a regression
    // that flattened the bucket key across IPs would surface here
    // as a non-null read.
    expect(await readBucketCount(innocentIp)).toBeNull();

    // Correct-password login on the innocent account from the
    // innocent IP MUST succeed. The breaker has nothing to fire on
    // for this IP, and the innocent user has no per-user lockout.
    const ok = await callJson('/api/v1/auth/login', {
      body: { email: innocentEmail, password: VALID_PASSWORD },
      forwardedFor: innocentIp,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ outcome: 'session' });
    expect(ok.setCookies.length).toBeGreaterThan(0);
  });

  it('window roll: after BREAKER_WINDOW_SECONDS the fresh bucket releases the gate', async () => {
    const ip = uniqueIp();
    const decoyEmail = uniqueEmail('roll-decoy');
    await callJson('/api/v1/auth/signup', {
      body: { email: decoyEmail, password: VALID_PASSWORD },
    });
    await activateAccount(decoyEmail);

    // Trip the breaker on the decoy account so the IP is fully
    // saturated for the current window.
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      await callJson('/api/v1/auth/login', {
        body: { email: decoyEmail, password: BAD_PASSWORD },
        forwardedFor: ip,
      });
    }
    expect(await readBucketCount(ip)).toBe(BREAKER_THRESHOLD);

    // Fresh user whose per-user lockout state is clean — so the
    // post-roll login proves the BREAKER released the gate, not
    // some unrelated state on the decoy.
    const freshEmail = uniqueEmail('roll-fresh');
    await callJson('/api/v1/auth/signup', {
      body: { email: freshEmail, password: VALID_PASSWORD },
    });
    await activateAccount(freshEmail);

    // Confirm the IP is currently blocked: a correct-password login
    // for the fresh user from this IP must 401 while the breaker
    // bucket is full. This pins the "pre-roll, gate is closed"
    // state so the post-roll assertion below cannot be satisfied by
    // some other code path that bypasses the breaker entirely.
    const preRoll = await callJson('/api/v1/auth/login', {
      body: { email: freshEmail, password: VALID_PASSWORD },
      forwardedFor: ip,
    });
    expect(preRoll.status).toBe(401);
    expect(preRoll.setCookies).toHaveLength(0);

    // Sleep past the window boundary. Window is in seconds + a
    // comfortable margin so even if the burn loop landed near the
    // boundary, the post-sleep `floor(now / window)` strictly
    // exceeds the burn-time window number.
    await sleep((BREAKER_WINDOW_SECONDS + 1) * 1_000);

    // Fresh window — the new bucket starts at 0, so the breaker's
    // `checkBlocked` reads null and returns false. Correct-password
    // login from the same (previously blocked) IP MUST succeed.
    const postRoll = await callJson('/api/v1/auth/login', {
      body: { email: freshEmail, password: VALID_PASSWORD },
      forwardedFor: ip,
    });
    expect(postRoll.status).toBe(200);
    expect(postRoll.body).toMatchObject({ outcome: 'session' });
    expect(postRoll.setCookies.length).toBeGreaterThan(0);
  });

  it('CLAUDE.md §3.7 — bucket keys carry the env + service + purpose + hashed IP + window; no raw IP', async () => {
    const ip = uniqueIp();
    const email = uniqueEmail('key-shape');
    await callJson('/api/v1/auth/signup', { body: { email, password: VALID_PASSWORD } });
    await activateAccount(email);

    // One bad-pw attempt is sufficient to materialise the key.
    await callJson('/api/v1/auth/login', {
      body: { email, password: BAD_PASSWORD },
      forwardedFor: ip,
    });

    // Read keys for THIS IP's hashed namespace specifically — using
    // a wildcard on the full prefix could pick up sibling-test
    // keys (different IPs in 203.0.113.x) and make the assertion
    // brittle to test ordering. The expected hash is deterministic
    // from the IP, so we can pin the exact key.
    const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 16);
    const keys = await harnessRedis.keys(`${keyPrefix}:${ipHash}:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      // Full shape: {env}:service-identity:login-ip-rate:{16-hex}:{digits}
      expect(key).toMatch(/^test:service-identity:login-ip-rate:[0-9a-f]{16}:\d+$/);
      // The raw IP MUST NOT appear in the key — CLAUDE.md §3.7 +
      // §3.9 (never log PII unredacted; the Redis key surface is
      // visible to ops via MONITOR / SLOWLOG and so is treated as
      // a log surface).
      expect(key).not.toContain(ip);
    }

    // The matching TTL must be set (CLAUDE.md §4.3 — TTL on every
    // Redis key). A regression that dropped the EXPIRE from the
    // recordFailure pipeline would surface here as `ttl === -1`
    // (key persists with no TTL). The breaker writes an EXPIRE of
    // exactly `windowSeconds` so the assertion is bounded above
    // by the configured window.
    expect(keys[0]).toBeDefined();
    const ttl = await harnessRedis.ttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(BREAKER_WINDOW_SECONDS);
  });
});
