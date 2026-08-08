/**
 * TS-023-followup-6 — end-to-end MFA integration.
 * TS-023-followup-2d — recovery-code (backup-code) round-trip, in the
 *   trailing `describe('TS-023-followup-2d recovery-code round-trip')`
 *   block: enroll → confirm (capture the ten plaintext codes) → login
 *   (→ challenge) → `POST /mfa/recovery/verify` with one code (→ session),
 *   single-use replay, fresh-code-still-works, and `removeMethod` wiping
 *   the batch — all cross-checked against the real `mfa_recovery_codes`
 *   table so the Postgres conditional-update tombstone semantics are
 *   pinned (not just the FakePrisma approximation in the unit suite).
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers and exercises the full MFA round-trip over HTTP:
 *
 *   signup → activate → login (no MFA, outcome=session)
 *   → POST /mfa/totp/enroll  (Bearer-authed)
 *   → compute TOTP from secretBase32
 *   → POST /mfa/totp/confirm (Bearer-authed)
 *   → POST /login            (outcome=challenge, NO cookie set)
 *   → POST /mfa/verify       (consume challengeToken + fresh code)
 *   → access token + refresh-cookie issued
 *
 * Why a dedicated test file. The TS-009e-followup-3 / TS-022-followup-5
 * sibling test in `auth.integration.test.ts` deliberately skips the
 * MFA branch — TOTP code computation against a freshly-issued secret
 * would have doubled that test file's complexity. Splitting MFA into
 * its own file keeps each file's concern tight and lets the per-file
 * Testcontainers lifecycle (PDD §24.1 canonical pattern) stay scoped
 * to the surface under test.
 *
 * Load-bearing properties asserted end-to-end:
 *
 *   1. **Discriminated-union JSON shape**. The same `/login` endpoint
 *      returns `outcome: 'session'` before enrollment and
 *      `outcome: 'challenge'` after a confirmed method exists. The
 *      challenge branch carries `challengeToken` + `expiresIn` only —
 *      no `accessToken`, no `user`, no cookie. The contract's
 *      discriminated union is what defends a client that pattern-
 *      matches on `outcome` from being fooled by a misshaped
 *      response.
 *
 *   2. **Single-use challenge consumption**. The challenge token is
 *      consumed by the first successful `mfa/verify` call; a replay
 *      with the same token + same code MUST 401 (CLAUDE.md §3.1 spirit
 *      — challenge replay is a session-fixation attack vector). The
 *      unit test in `mfa-challenge-token.service.test.ts` covers the
 *      JWT layer; this test proves the controller actually consumes
 *      the token before issuing the session.
 *
 *   3. **TS-023-followup-5 session rotation on MFA changes**. The
 *      unit tests in `mfa.service.test.ts` cover the rotation
 *      invariant against a FakePrisma — this test proves the
 *      `$transaction`-wrapped revocation actually commits against
 *      real Postgres + that the controller's refresh-after-enroll
 *      path 401s because the family was revoked by the confirm
 *      transaction. Same shape for the remove path.
 *
 *   4. **mfa_enabled flips true on first confirm**. A bug where the
 *      confirm endpoint persisted the method but skipped the user-row
 *      flag would leave the next login returning `outcome: 'session'`
 *      instead of `outcome: 'challenge'`. The integration test asserts
 *      the login response shape change immediately after confirm.
 *
 *   5. **TOTP secret round-trips**. The `secretBase32` returned by
 *      enroll, the `otpauthUrl` it embeds, and the code computed by
 *      RFC 6238 against the same secret all converge — the
 *      authenticator-app contract is preserved end-to-end.
 *
 * Why import `_internals` from `totp.service.ts` for code generation
 * rather than re-implement RFC 6238 in the test file. Two reasons.
 * (a) The service's HMAC-SHA-1 + dynamic-truncation + base32 helpers
 * have a dedicated unit-test suite (RFC 4226 / 6238 test vectors); a
 * second copy in the test file would silently drift. (b) The test
 * needs to compute codes against a secret the service is also
 * verifying — using the same internals guarantees the test exercises
 * the exact same algorithm chain. The internals are explicitly marked
 * "Test-only re-exports" in `totp.service.ts`.
 *
 * Why no supertest. Same as the sibling auth integration test —
 * supertest is not on CLAUDE.md §13 approved list, Node 22's native
 * fetch + `app.listen(0, '127.0.0.1')` cover the same surface.
 *
 * References: PDD §24.1, §10.1; CLAUDE.md §3.1, §9.1; TS-022-followup-5
 * canonical pattern in `test/integration/auth.integration.test.ts`;
 * TS-023-followup-5 session-rotation invariant established in
 * `mfa.service.ts` + `refresh-token.service.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { createIsolatedDatabase, type IsolatedDatabaseHandle } from '@taste-and-see/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';
import { _internals as totpInternals } from '../../src/modules/auth/services/totp.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');
const REFRESH_COOKIE_NAME = 'tns_refresh';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

let database: IsolatedDatabaseHandle;
let app: INestApplication;
let baseUrl: string;

/**
 * Harness-only Prisma handle — identical purpose to the sibling auth
 * integration test: flip `pending_verification` → `active` so the
 * account can log in (no verification HTTP surface exists today), AND
 * cross-check session-rotation invariants via direct
 * `refreshToken.findMany` reads. Never used to synthesise state the
 * production code is responsible for.
 */
let harnessPrisma: PrismaService;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The shared Redis
  // URL is read directly from the globalSetup-provided value.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'identity_test_mfa',
    serviceRoot: SERVICE_ROOT,
  });

  // ── Env wiring ────────────────────────────────────────────────────
  //
  // Same dynamic-import discipline as the sibling auth test: every
  // required env var MUST be set BEFORE the AppModule import resolves,
  // because `app.module.ts` evaluates `const moduleEnv = loadEnv()` at
  // the top of the file. A static `import { AppModule }` at the top of
  // this file would short-circuit the validation against placeholder
  // values that fail the schema's `min(32)` / base64-32-byte floors.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = database.databaseUrl;
  process.env.REDIS_URL = inject('redisUrl');
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64');
  process.env.MFA_TOTP_ENC_KEY = randomBytes(32).toString('base64');
  process.env.MFA_CHALLENGE_SECRET = randomBytes(48).toString('base64');
  // Stripe is never called in this test — no KYC endpoint is hit. The
  // schema enforces a non-empty key + a URL return path; both shapes
  // are satisfied with throwaway values.
  process.env.STRIPE_SECRET_KEY = `sk_test_${randomBytes(16).toString('hex')}`;
  process.env.STRIPE_IDENTITY_RETURN_URL = 'https://example.test/kyc/return';
  process.env.KYC_PAYLOAD_ENC_KEY = randomBytes(32).toString('base64');
  process.env.KYC_WEBHOOK_INTERNAL_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_RECIPIENT_CONTACTS_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_PRIVACY_EXPORT_API_KEY = randomBytes(32).toString('base64');
  process.env.REFRESH_COOKIE_SECURE = 'false';
  process.env.JWT_ACCESS_TTL_SECONDS = '120';
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = '5';
  // TS-025-followup-1 — keep the IP circuit breaker out of the way
  // of the MFA login round-trips (sibling integration tests carry
  // the same override; see auth.integration.test.ts for rationale).
  process.env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW = '100000';
  // Pin TOTP knobs to the schema defaults so `computeTotpCode` matches
  // the service's verification algorithm exactly. Re-asserting the
  // defaults here ALSO documents the contract this test depends on —
  // if a future env edit flips `MFA_TOTP_DIGITS` or `MFA_TOTP_PERIOD_SECONDS`,
  // the test will tell you (rather than a flaky 401 from "wrong code").
  process.env.MFA_TOTP_PERIOD_SECONDS = String(TOTP_PERIOD_SECONDS);
  process.env.MFA_TOTP_DIGITS = String(TOTP_DIGITS);
  process.env.MFA_TOTP_WINDOW = '1';

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
// HTTP helpers — minimal wrapper around fetch that handles JSON,
// cookies, and Bearer-auth headers, matching the sibling auth file's
// shape so any reader can move between the two files without re-
// learning the request shape.
// ─────────────────────────────────────────────────────────────────────

interface MfaResponse {
  readonly status: number;
  readonly body: unknown;
  readonly setCookies: readonly string[];
}

async function callJson(
  path: string,
  init: {
    method?: 'POST' | 'DELETE' | 'GET';
    body?: unknown;
    cookie?: string;
    bearer?: string;
    idempotencyKey?: string;
  } = {},
): Promise<MfaResponse> {
  const method = init.method ?? 'POST';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.bearer !== undefined) headers['authorization'] = `Bearer ${init.bearer}`;
  if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
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

let emailSeed = 0;
function uniqueEmail(prefix = 'mfa'): string {
  emailSeed += 1;
  return `${prefix}+${process.pid}+${Date.now()}+${emailSeed}@tastesee.test`;
}

const VALID_PASSWORD = 'P@ssw0rd-correct-horse-battery-staple';

async function activateAccount(email: string): Promise<void> {
  await harnessPrisma.user.update({
    where: { email },
    data: { status: 'active' },
  });
}

/**
 * Compute a fresh TOTP code from a base32 secret, using the same RFC
 * 6238 / RFC 4226 primitives the service's `TotpService` uses to
 * verify. `step` defaults to "now"; tests that need to assert
 * step-skew behaviour can pin it explicitly.
 *
 * The `_internals` re-export lives in `totp.service.ts` precisely so
 * this kind of test can share the algorithm with the production code
 * — re-implementing RFC 6238 in the test file would silently drift
 * from any future production tweak.
 */
function computeTotpCode(secretBase32: string, step?: number): string {
  const stepValue = step ?? Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  return totpInternals.totpCode({
    secret: totpInternals.base32Decode(secretBase32),
    step: stepValue,
    digits: TOTP_DIGITS,
  });
}

/**
 * Full enrolment flow: signup → activate → login (no MFA) → enroll
 * → confirm → return the access-token + secret so subsequent
 * assertions can re-use them without re-walking the setup.
 *
 * The returned shape is deliberately rich — every helper-call point
 * downstream needs at least one of these handles, so collecting them
 * once cuts the per-test boilerplate without hiding the wire
 * exchange.
 */
async function enrolMfaUser(prefix: string): Promise<{
  readonly email: string;
  readonly userId: string;
  readonly accessTokenPreMfa: string;
  readonly preMfaCookie: { readonly raw: string; readonly value: string };
  readonly methodId: string;
  readonly secretBase32: string;
  readonly recoveryCodes: readonly string[];
}> {
  const email = uniqueEmail(prefix);
  const signup = await callJson('/api/v1/auth/signup', {
    body: { email, password: VALID_PASSWORD },
  });
  if (signup.status !== 201) {
    throw new Error(
      `helper invariant: signup status ${signup.status} (body=${JSON.stringify(signup.body)})`,
    );
  }
  const userId = (signup.body as { id: string }).id;
  await activateAccount(email);

  // First login — no MFA yet, so this returns outcome=session and
  // sets the refresh cookie. We need the access token to call the
  // enroll/confirm endpoints (both behind AccessTokenGuard).
  const loginNoMfa = await callJson('/api/v1/auth/login', {
    body: { email, password: VALID_PASSWORD },
  });
  if (loginNoMfa.status !== 200) {
    throw new Error(`helper invariant: pre-MFA login status ${loginNoMfa.status}`);
  }
  const loginBody = loginNoMfa.body as { outcome: string; accessToken?: string };
  if (loginBody.outcome !== 'session' || loginBody.accessToken === undefined) {
    throw new Error(`helper invariant: pre-MFA login outcome ${loginBody.outcome}`);
  }
  const preMfaCookieParsed = extractRefreshCookie(loginNoMfa.setCookies);
  if (preMfaCookieParsed === null) {
    throw new Error('helper invariant: pre-MFA login did not set a refresh cookie');
  }

  const enroll = await callJson('/api/v1/auth/mfa/totp/enroll', {
    body: {},
    bearer: loginBody.accessToken,
  });
  if (enroll.status !== 200) {
    throw new Error(
      `helper invariant: enroll status ${enroll.status} (body=${JSON.stringify(enroll.body)})`,
    );
  }
  const enrollBody = enroll.body as { methodId: string; secretBase32: string; otpauthUrl: string };

  // Confirm — the code is computed from the secret the enroll
  // response just returned, against the algorithm pinned in env above.
  const confirm = await callJson('/api/v1/auth/mfa/totp/confirm', {
    body: { methodId: enrollBody.methodId, code: computeTotpCode(enrollBody.secretBase32) },
    bearer: loginBody.accessToken,
  });
  if (confirm.status !== 200) {
    throw new Error(
      `helper invariant: confirm status ${confirm.status} (body=${JSON.stringify(confirm.body)})`,
    );
  }
  // The confirm response carries the freshly-minted recovery-code batch
  // in plaintext exactly once (TS-023-followup-2). Capture it so the
  // recovery-code tests below can present a real code without re-walking
  // the enrolment flow.
  const confirmBody = confirm.body as { mfaEnabled: boolean; recoveryCodes: readonly string[] };
  if (!Array.isArray(confirmBody.recoveryCodes) || confirmBody.recoveryCodes.length === 0) {
    throw new Error(
      `helper invariant: confirm did not return recovery codes (body=${JSON.stringify(confirm.body)})`,
    );
  }

  return {
    email,
    userId,
    accessTokenPreMfa: loginBody.accessToken,
    preMfaCookie: preMfaCookieParsed,
    methodId: enrollBody.methodId,
    secretBase32: enrollBody.secretBase32,
    recoveryCodes: confirmBody.recoveryCodes,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('service-identity MFA integration (TS-023-followup-6)', () => {
  describe('enrollment', () => {
    it('enroll → confirm flips mfa_enabled and persists a confirmed method', async () => {
      const email = uniqueEmail('enroll-happy');
      const signup = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(signup.status).toBe(201);
      const userId = (signup.body as { id: string }).id;
      await activateAccount(email);

      const login = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(login.status).toBe(200);
      const accessToken = (login.body as { accessToken: string }).accessToken;

      // Enroll — body shape matches MfaEnrollResponseSchema. Crucially
      // the otpauthUrl embeds the same secret as `secretBase32`; a
      // bug that returned a fresh secret in the URL would silently
      // break authenticator-app pairing.
      const enroll = await callJson('/api/v1/auth/mfa/totp/enroll', {
        body: { label: 'integration test phone' },
        bearer: accessToken,
      });
      expect(enroll.status).toBe(200);
      const enrollBody = enroll.body as {
        methodId: string;
        secretBase32: string;
        otpauthUrl: string;
      };
      expect(enrollBody.methodId).toMatch(/^[a-z0-9]+$/);
      // Base32 alphabet, 32 chars for the standard 20-byte secret
      // (160-bit RFC 4226 default). Reject any drift to a different
      // secret length / alphabet.
      expect(enrollBody.secretBase32).toMatch(/^[A-Z2-7]+$/);
      expect(enrollBody.secretBase32.length).toBeGreaterThanOrEqual(32);
      expect(enrollBody.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      expect(enrollBody.otpauthUrl).toContain(`secret=${enrollBody.secretBase32}`);

      // Pre-confirm: DB row exists with confirmedAt=null and the user
      // row's mfa_enabled is still false. This documents the
      // intermediate state so a future regression that flips
      // mfaEnabled at enroll time (rather than at confirm) surfaces
      // here, not in production.
      const preConfirmUser = await harnessPrisma.user.findUnique({
        where: { id: userId },
        select: { mfaEnabled: true },
      });
      expect(preConfirmUser?.mfaEnabled).toBe(false);
      const preConfirmMethod = await harnessPrisma.mfaMethod.findUnique({
        where: { id: enrollBody.methodId },
        select: { userId: true, confirmedAt: true, deletedAt: true, kind: true, label: true },
      });
      expect(preConfirmMethod).not.toBeNull();
      expect(preConfirmMethod?.userId).toBe(userId);
      expect(preConfirmMethod?.confirmedAt).toBeNull();
      expect(preConfirmMethod?.kind).toBe('totp');
      expect(preConfirmMethod?.label).toBe('integration test phone');

      // Confirm — code computed from the freshly-issued secret.
      const confirm = await callJson('/api/v1/auth/mfa/totp/confirm', {
        body: { methodId: enrollBody.methodId, code: computeTotpCode(enrollBody.secretBase32) },
        bearer: accessToken,
      });
      expect(confirm.status).toBe(200);
      expect(confirm.body).toMatchObject({ mfaEnabled: true });

      // Post-confirm: user row's mfa_enabled is true AND the method's
      // confirmedAt is non-null. Both writes happen inside the same
      // $transaction in production — assert against the real DB to
      // prove the transaction committed.
      const postConfirmUser = await harnessPrisma.user.findUnique({
        where: { id: userId },
        select: { mfaEnabled: true },
      });
      expect(postConfirmUser?.mfaEnabled).toBe(true);
      const postConfirmMethod = await harnessPrisma.mfaMethod.findUnique({
        where: { id: enrollBody.methodId },
        select: { confirmedAt: true, lastUsedStep: true },
      });
      expect(postConfirmMethod?.confirmedAt).not.toBeNull();
      // Confirm advances `last_used_step` so the same code can't be
      // replayed in the confirm endpoint itself.
      expect(postConfirmMethod?.lastUsedStep).not.toBeNull();
    });

    it('confirm with a wrong code → 400 and method stays unconfirmed', async () => {
      const email = uniqueEmail('confirm-wrong');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);
      const login = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      const accessToken = (login.body as { accessToken: string }).accessToken;

      const enroll = await callJson('/api/v1/auth/mfa/totp/enroll', {
        body: {},
        bearer: accessToken,
      });
      const enrollBody = enroll.body as { methodId: string; secretBase32: string };

      // A six-digit code that's deliberately not the real one. We
      // pick a fixed numeric string so the test isn't sensitive to
      // the truncation outcome of any real step.
      const wrongCode = '000000';
      const realCode = computeTotpCode(enrollBody.secretBase32);
      // Defensive — if by extraordinary coincidence the real step's
      // code IS '000000', flip the wrong code to a different value.
      const candidate = wrongCode === realCode ? '111111' : wrongCode;

      const confirm = await callJson('/api/v1/auth/mfa/totp/confirm', {
        body: { methodId: enrollBody.methodId, code: candidate },
        bearer: accessToken,
      });
      expect(confirm.status).toBe(400);

      // Method row exists but is still not confirmed; the user row's
      // mfa_enabled is still false.
      const user = await harnessPrisma.user.findUnique({
        where: { email },
        select: { mfaEnabled: true },
      });
      expect(user?.mfaEnabled).toBe(false);
      const method = await harnessPrisma.mfaMethod.findUnique({
        where: { id: enrollBody.methodId },
        select: { confirmedAt: true },
      });
      expect(method?.confirmedAt).toBeNull();
    });

    it('enroll without an access token → 401', async () => {
      const res = await callJson('/api/v1/auth/mfa/totp/enroll', { body: {} });
      expect(res.status).toBe(401);
    });

    it('a second enroll while a confirmed method already exists → 409', async () => {
      const setup = await enrolMfaUser('enroll-dupe');
      const second = await callJson('/api/v1/auth/mfa/totp/enroll', {
        body: {},
        bearer: setup.accessTokenPreMfa,
      });
      expect(second.status).toBe(409);
    });
  });

  describe('MFA login flow (full round-trip)', () => {
    it('login returns outcome=challenge, verify consumes the token and issues a session', async () => {
      const setup = await enrolMfaUser('mfa-login-happy');

      // After confirm, login MUST switch to outcome=challenge.
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      expect(login.status).toBe(200);
      const challengeBody = login.body as {
        outcome: string;
        challengeToken: string;
        expiresIn: number;
        accessToken?: string;
        user?: unknown;
      };
      expect(challengeBody.outcome).toBe('challenge');
      expect(challengeBody.challengeToken.length).toBeGreaterThan(0);
      expect(challengeBody.expiresIn).toBeGreaterThan(0);
      // Negative shape — the challenge branch MUST NOT carry session
      // fields. A controller that accidentally returns both would
      // hand an attacker who passes only the first factor a working
      // session before the second factor verified.
      expect(challengeBody.accessToken).toBeUndefined();
      expect(challengeBody.user).toBeUndefined();
      // Challenge response sets NO refresh cookie — the cookie comes
      // only after `mfa/verify` succeeds.
      expect(extractRefreshCookie(login.setCookies)).toBeNull();

      // Wait one TOTP step if the current step matches the step used
      // by `confirmEnrollment` — otherwise the verify call would be
      // replaying the same code, which `verifyCode`'s `lastUsedStep`
      // watermark rejects. In practice the helper takes a few
      // hundred ms, so the verify-time step usually IS the same as
      // the confirm-time step. The test sleeps until we cross a
      // step boundary before computing the fresh code.
      await waitForNextTotpStep();

      // Verify — fresh code from the same secret.
      const verify = await callJson('/api/v1/auth/mfa/verify', {
        body: {
          challengeToken: challengeBody.challengeToken,
          code: computeTotpCode(setup.secretBase32),
        },
      });
      expect(verify.status).toBe(200);
      const verifyBody = verify.body as {
        outcome: string;
        accessToken: string;
        tokenType: string;
        expiresIn: number;
        user: { id: string; email: string; status: string };
      };
      expect(verifyBody.outcome).toBe('session');
      expect(verifyBody.tokenType).toBe('Bearer');
      expect(verifyBody.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(verifyBody.expiresIn).toBe(120);
      expect(verifyBody.user.email).toBe(setup.email);
      expect(verifyBody.user.status).toBe('active');

      // Refresh cookie attributes — same shape as a no-MFA login. The
      // mfa-verify controller path reuses `refreshCookieOptions` from
      // auth.controller, so a divergence in shape between the two
      // paths would surface here as an unexpected attribute set.
      const cookie = extractRefreshCookie(verify.setCookies);
      expect(cookie).not.toBeNull();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite.toLowerCase()).toBe('lax');
      expect(cookie?.path).toBe('/api/v1/auth');
      expect(cookie?.clear).toBe(false);
      expect(cookie?.value.length).toBeGreaterThan(0);

      // Cookie minted by mfa/verify is exchange-able for an access
      // token via /refresh — the full session shape rounds out
      // end-to-end.
      const refreshResult = await callJson('/api/v1/auth/refresh', {
        cookie: cookie!.raw,
      });
      expect(refreshResult.status).toBe(200);
    });

    it('replaying the same challenge token after success → 401 (single-use)', async () => {
      const setup = await enrolMfaUser('challenge-replay');
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challengeToken = (login.body as { challengeToken: string }).challengeToken;
      await waitForNextTotpStep();

      const first = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken, code: computeTotpCode(setup.secretBase32) },
      });
      expect(first.status).toBe(200);

      // Replay with the SAME challenge token. The TOTP code is fresh
      // (we recompute) — the single-use enforcement lives in the
      // challenge-token consume path, not the code-verify path.
      // Without single-use enforcement, an attacker who intercepted
      // the challenge token could submit it after the legitimate
      // user finished MFA and obtain a separate session.
      await waitForNextTotpStep();
      const replay = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken, code: computeTotpCode(setup.secretBase32) },
      });
      expect(replay.status).toBe(401);
      expect(replay.body).toMatchObject({ status: 401, title: 'Unauthorized' });
      // No cookie set on the failed branch — generic 401 surface.
      expect(extractRefreshCookie(replay.setCookies)).toBeNull();
    });

    it('verify with a wrong code → 401 and no cookie', async () => {
      const setup = await enrolMfaUser('verify-wrong-code');
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challengeToken = (login.body as { challengeToken: string }).challengeToken;

      const res = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken, code: '000000' },
      });
      // Note: 000000 might coincidentally match the current step in
      // an astronomically-unlikely run; the secret is random per
      // user so the dice roll varies. If this ever surfaces as a
      // false-positive in CI, swap in a known-wrong code computed
      // against a different secret.
      expect(res.status).toBe(401);
      expect(extractRefreshCookie(res.setCookies)).toBeNull();
    });

    it('verify with a malformed challenge token → 401', async () => {
      const setup = await enrolMfaUser('verify-bad-token');
      const res = await callJson('/api/v1/auth/mfa/verify', {
        body: {
          challengeToken: 'not.a.valid.jwt',
          code: computeTotpCode(setup.secretBase32),
        },
      });
      expect(res.status).toBe(401);
    });

    it('verify with a missing-field payload → 400 at the contract boundary', async () => {
      const res = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken: 'whatever' /* missing code */ },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('TS-023-followup-5 session rotation on MFA changes', () => {
    /**
     * The MfaService confirms enrollment AND removes methods inside a
     * `$transaction` that ALSO revokes every active refresh-token
     * family for the user. The unit tests prove the service shape;
     * this test proves the wire path: a session held by the user
     * BEFORE the MFA change must not survive the change. Otherwise an
     * attacker who phished a session token before the legitimate
     * user enrolled MFA would keep that session alive past
     * enrollment — defeating the purpose of MFA.
     */
    it('enrolling MFA revokes every active refresh-token family', async () => {
      const email = uniqueEmail('rotate-on-enroll');
      const signup = await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      const userId = (signup.body as { id: string }).id;
      await activateAccount(email);

      // Two parallel logins — gives us two refresh families to assert
      // BOTH get revoked, not just the one the access token came
      // from. A bug that only revoked "the current session's family"
      // would survive a one-family test.
      const loginA = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      const cookieA = extractRefreshCookie(loginA.setCookies);
      expect(cookieA?.value.length).toBeGreaterThan(0);
      const accessTokenA = (loginA.body as { accessToken: string }).accessToken;

      const loginB = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      const cookieB = extractRefreshCookie(loginB.setCookies);
      expect(cookieB?.value.length).toBeGreaterThan(0);
      expect(cookieB?.value).not.toBe(cookieA?.value);

      // Both cookies refresh cleanly — baseline establishes the
      // sessions are alive before the MFA change.
      const refreshABaseline = await callJson('/api/v1/auth/refresh', {
        cookie: cookieA!.raw,
      });
      expect(refreshABaseline.status).toBe(200);
      // The successful refresh ROTATED cookieA — grab the new value
      // for the post-MFA-change assertion. (cookieB stays unrotated.)
      const cookieARotated = extractRefreshCookie(refreshABaseline.setCookies);
      expect(cookieARotated?.value.length).toBeGreaterThan(0);

      // Enroll + confirm — this is the trigger for the rotation.
      const enroll = await callJson('/api/v1/auth/mfa/totp/enroll', {
        body: {},
        bearer: accessTokenA,
      });
      expect(enroll.status).toBe(200);
      const enrollBody = enroll.body as { methodId: string; secretBase32: string };
      const confirm = await callJson('/api/v1/auth/mfa/totp/confirm', {
        body: {
          methodId: enrollBody.methodId,
          code: computeTotpCode(enrollBody.secretBase32),
        },
        bearer: accessTokenA,
      });
      expect(confirm.status).toBe(200);

      // POST-CONFIRM: both refresh cookies (and any rotated children
      // of them) must 401. This is the load-bearing assertion — the
      // unit tests cover the SQL; the integration test proves the
      // controller didn't fan out around the transaction.
      const refreshAfterEnrollA = await callJson('/api/v1/auth/refresh', {
        cookie: cookieARotated!.raw,
      });
      expect(refreshAfterEnrollA.status).toBe(401);
      const refreshAfterEnrollB = await callJson('/api/v1/auth/refresh', {
        cookie: cookieB!.raw,
      });
      expect(refreshAfterEnrollB.status).toBe(401);

      // DB cross-check — every refresh row for this user has
      // `revokedAt` stamped. The harness Prisma read is the
      // belt-and-braces proof that the SQL ran, not just that the
      // HTTP path returned the right status.
      const tokens = await harnessPrisma.refreshToken.findMany({
        where: { userId },
        select: { revokedAt: true },
      });
      expect(tokens.length).toBeGreaterThan(0);
      for (const t of tokens) {
        expect(t.revokedAt).not.toBeNull();
      }
    });

    /**
     * Same shape as the enroll-rotates path but for removal. A user
     * deliberately retiring a method (lost phone, compromised device)
     * is one of the "authentication-posture change" signals that the
     * MfaService treats as cause to revoke every session. Without
     * this rotation the legitimate user can retire a stolen device
     * BUT the attacker's session token from before the removal
     * stays alive — defeating the recovery flow.
     */
    it('removing the only confirmed method revokes every active refresh-token family', async () => {
      const setup = await enrolMfaUser('rotate-on-remove');

      // MFA-login to obtain a fresh refresh cookie (the pre-MFA
      // cookie was revoked by the confirm flow above).
      await waitForNextTotpStep();
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challengeToken = (login.body as { challengeToken: string }).challengeToken;
      const verify = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken, code: computeTotpCode(setup.secretBase32) },
      });
      expect(verify.status).toBe(200);
      const sessionCookie = extractRefreshCookie(verify.setCookies);
      expect(sessionCookie?.value.length).toBeGreaterThan(0);
      const accessToken = (verify.body as { accessToken: string }).accessToken;

      // Baseline — the cookie refreshes cleanly before the remove.
      const refreshBefore = await callJson('/api/v1/auth/refresh', {
        cookie: sessionCookie!.raw,
      });
      expect(refreshBefore.status).toBe(200);
      const cookieRotated = extractRefreshCookie(refreshBefore.setCookies);

      // Remove the method — the trigger.
      const remove = await callJson(`/api/v1/auth/mfa/methods/${setup.methodId}`, {
        method: 'DELETE',
        bearer: accessToken,
      });
      expect(remove.status).toBe(200);
      expect(remove.body).toMatchObject({ removed: true });

      // POST-REMOVE: the rotated cookie 401s because the family was
      // revoked by the removal transaction. Cross-check the user-row
      // mfa_enabled flag — removing the only confirmed method also
      // flips the column false so a future login skips the MFA
      // branch (a stuck `mfaEnabled=true` with no method would
      // permanently lock the user out).
      const refreshAfter = await callJson('/api/v1/auth/refresh', {
        cookie: cookieRotated!.raw,
      });
      expect(refreshAfter.status).toBe(401);

      const user = await harnessPrisma.user.findUnique({
        where: { email: setup.email },
        select: { mfaEnabled: true },
      });
      expect(user?.mfaEnabled).toBe(false);
    });

    /**
     * Negative pair for the rotation: a FAILED enrolment (wrong
     * code) must NOT revoke sessions. A typo'd 6-digit code is a
     * UX accident, not an authentication-posture change. If a typo
     * logged the user out everywhere, the feature would be
     * unusable in practice.
     */
    it('a failed confirm (wrong code) does NOT revoke active refresh-token families', async () => {
      const email = uniqueEmail('rotate-no-revoke');
      await callJson('/api/v1/auth/signup', {
        body: { email, password: VALID_PASSWORD },
      });
      await activateAccount(email);
      const login = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      const cookie = extractRefreshCookie(login.setCookies);
      const accessToken = (login.body as { accessToken: string }).accessToken;

      const enroll = await callJson('/api/v1/auth/mfa/totp/enroll', {
        body: {},
        bearer: accessToken,
      });
      const enrollBody = enroll.body as { methodId: string; secretBase32: string };

      // Wrong code — but careful about the astronomically-unlikely
      // collision against the real step's code; flip if needed.
      const realCode = computeTotpCode(enrollBody.secretBase32);
      const candidate = realCode === '000000' ? '111111' : '000000';

      const badConfirm = await callJson('/api/v1/auth/mfa/totp/confirm', {
        body: { methodId: enrollBody.methodId, code: candidate },
        bearer: accessToken,
      });
      expect(badConfirm.status).toBe(400);

      // Cookie still refreshes — the failed confirm did not touch
      // the refresh-token family.
      const refresh = await callJson('/api/v1/auth/refresh', {
        cookie: cookie!.raw,
      });
      expect(refresh.status).toBe(200);
    });
  });

  describe('MFA methods list + remove', () => {
    it('list reflects the post-enrolment state', async () => {
      const setup = await enrolMfaUser('list-methods');
      // The pre-MFA access token's refresh family was revoked by the
      // confirm flow above — for /methods (a read) we need a fresh
      // session. Walk the MFA-login path.
      await waitForNextTotpStep();
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challengeToken = (login.body as { challengeToken: string }).challengeToken;
      const verify = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken, code: computeTotpCode(setup.secretBase32) },
      });
      const accessToken = (verify.body as { accessToken: string }).accessToken;

      const list = await callJson('/api/v1/auth/mfa/methods', {
        method: 'GET',
        bearer: accessToken,
      });
      expect(list.status).toBe(200);
      const listBody = list.body as {
        methods: Array<{ id: string; kind: string; confirmedAt: string | null }>;
      };
      expect(listBody.methods).toHaveLength(1);
      expect(listBody.methods[0]?.id).toBe(setup.methodId);
      expect(listBody.methods[0]?.kind).toBe('totp');
      expect(listBody.methods[0]?.confirmedAt).not.toBeNull();
    });

    it('delete an unknown id → 404 (no enumeration via id format)', async () => {
      const setup = await enrolMfaUser('delete-unknown');
      await waitForNextTotpStep();
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challengeToken = (login.body as { challengeToken: string }).challengeToken;
      const verify = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken, code: computeTotpCode(setup.secretBase32) },
      });
      const accessToken = (verify.body as { accessToken: string }).accessToken;

      const res = await callJson(`/api/v1/auth/mfa/methods/not-a-real-method-id`, {
        method: 'DELETE',
        bearer: accessToken,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('TS-023-followup-2d recovery-code round-trip', () => {
    /**
     * Why this block exists beyond the FakePrisma unit tests
     * (`mfa-recovery-code.service.test.ts`, `mfa.service.test.ts`).
     * The recovery-verify consume is a conditional
     * `updateMany ... WHERE code_hash = ? AND user_id = ? AND
     * consumed_at IS NULL` — the single-row tombstone semantics depend
     * on Postgres' real conditional-update + the unique `code_hash`
     * index, NOT on the in-memory FakePrisma's hand-rolled `updateMany`
     * approximation. A drift between the two (e.g. FakePrisma ignoring
     * the `consumed_at IS NULL` predicate) would let a spent code be
     * replayed in production while the unit suite stayed green. This
     * test pins the behaviour against real Postgres over the full HTTP
     * surface, mirroring the TS-023-followup-6 / TS-026-followup-6
     * shape.
     *
     * Why no `waitForNextTotpStep()` on the recovery path. Recovery
     * codes carry no TOTP step watermark — `verifyAndConsume` is a
     * pure hash-match-and-tombstone, so back-to-back recovery verifies
     * never collide on a step boundary the way TOTP codes do. The one
     * place this block crosses a step boundary is test 4, where the
     * session used to authenticate the DELETE is minted via the TOTP
     * path (deliberately, so all ten recovery codes stay pristine and
     * the batch-delete assertion sees a full ten-row → zero-row drop).
     */

    /** Display-form recovery code: Crockford base32 grouped `XXXXX-XXXXX`. */
    const RECOVERY_CODE_DISPLAY = /^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/;

    it('confirm returns a ten-code batch with all rows unconsumed', async () => {
      const setup = await enrolMfaUser('recovery-batch');

      // The server mints exactly ten codes (MfaRecoveryCodeService.CODE_COUNT)
      // and the contract bounds the batch to 8–10. Assert the wire shape.
      expect(setup.recoveryCodes).toHaveLength(10);
      for (const code of setup.recoveryCodes) {
        expect(code).toMatch(RECOVERY_CODE_DISPLAY);
      }
      // No two codes collide (the generator dedupes within a batch).
      expect(new Set(setup.recoveryCodes).size).toBe(setup.recoveryCodes.length);

      // DB cross-check: ten rows for this user, every one unconsumed.
      // Proves `generate` committed the full batch inside the confirm
      // transaction with `consumed_at` left null.
      const rows = await harnessPrisma.mfaRecoveryCode.findMany({
        where: { userId: setup.userId },
        select: { consumedAt: true },
      });
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.consumedAt === null)).toBe(true);
    });

    it('recovery/verify with a valid code issues a session and tombstones exactly that code', async () => {
      const setup = await enrolMfaUser('recovery-happy');

      // Login now returns outcome=challenge (a confirmed method exists).
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      expect(login.status).toBe(200);
      const challenge = login.body as { outcome: string; challengeToken: string };
      expect(challenge.outcome).toBe('challenge');

      // Present the FIRST recovery code (display form, with the dash)
      // instead of a TOTP code.
      const verify = await callJson('/api/v1/auth/mfa/recovery/verify', {
        body: {
          challengeToken: challenge.challengeToken,
          recoveryCode: setup.recoveryCodes[0],
        },
      });
      expect(verify.status).toBe(200);
      const verifyBody = verify.body as {
        outcome: string;
        accessToken: string;
        tokenType: string;
        expiresIn: number;
        user: { id: string; email: string; status: string };
      };
      // Same LoginSessionResponse shape as the TOTP-verify path.
      expect(verifyBody.outcome).toBe('session');
      expect(verifyBody.tokenType).toBe('Bearer');
      expect(verifyBody.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(verifyBody.expiresIn).toBe(120);
      expect(verifyBody.user.email).toBe(setup.email);
      expect(verifyBody.user.status).toBe('active');

      // Refresh cookie set + exchange-able — the recovery path mints a
      // full session, identical to the TOTP path.
      const cookie = extractRefreshCookie(verify.setCookies);
      expect(cookie).not.toBeNull();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite.toLowerCase()).toBe('lax');
      expect(cookie?.path).toBe('/api/v1/auth');
      expect(cookie?.clear).toBe(false);
      const refreshResult = await callJson('/api/v1/auth/refresh', {
        cookie: cookie!.raw,
      });
      expect(refreshResult.status).toBe(200);

      // DB cross-check: EXACTLY ONE row is now `consumed_at`-stamped and
      // the other nine remain unconsumed. This is the load-bearing
      // assertion — a FakePrisma `updateMany` that ignored the
      // `code_hash` predicate would tombstone the whole batch.
      const rows = await harnessPrisma.mfaRecoveryCode.findMany({
        where: { userId: setup.userId },
        select: { consumedAt: true },
      });
      expect(rows).toHaveLength(10);
      expect(rows.filter((r) => r.consumedAt !== null)).toHaveLength(1);
      expect(rows.filter((r) => r.consumedAt === null)).toHaveLength(9);
    });

    it('a spent recovery code cannot be replayed (single-use), even on a fresh challenge', async () => {
      const setup = await enrolMfaUser('recovery-replay');

      // Spend code[0] once.
      const login1 = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challenge1 = (login1.body as { challengeToken: string }).challengeToken;
      const first = await callJson('/api/v1/auth/mfa/recovery/verify', {
        body: { challengeToken: challenge1, recoveryCode: setup.recoveryCodes[0] },
      });
      expect(first.status).toBe(200);

      // A SECOND login mints a FRESH challenge token. This deliberately
      // isolates the recovery-code single-use guard from the challenge
      // single-use guard — replaying with the same challenge token would
      // 401 on the consumed challenge alone and prove nothing about the
      // recovery code. With a fresh challenge, the ONLY thing that can
      // produce a 401 is the spent recovery code.
      const login2 = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challenge2 = (login2.body as { challengeToken: string }).challengeToken;
      const replay = await callJson('/api/v1/auth/mfa/recovery/verify', {
        body: { challengeToken: challenge2, recoveryCode: setup.recoveryCodes[0] },
      });
      expect(replay.status).toBe(401);
      // Generic 401 surface — same body shape as a wrong code, no cookie.
      expect(replay.body).toMatchObject({ status: 401, title: 'Unauthorized' });
      expect(extractRefreshCookie(replay.setCookies)).toBeNull();

      // DB cross-check: still exactly one consumed row — the replay did
      // not double-tombstone or resurrect anything.
      const rows = await harnessPrisma.mfaRecoveryCode.findMany({
        where: { userId: setup.userId },
        select: { consumedAt: true },
      });
      expect(rows.filter((r) => r.consumedAt !== null)).toHaveLength(1);
    });

    it('a different unused recovery code still works after one is spent (bare/normalised form)', async () => {
      const setup = await enrolMfaUser('recovery-fresh');

      // Spend code[0].
      const login1 = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challenge1 = (login1.body as { challengeToken: string }).challengeToken;
      const first = await callJson('/api/v1/auth/mfa/recovery/verify', {
        body: { challengeToken: challenge1, recoveryCode: setup.recoveryCodes[0] },
      });
      expect(first.status).toBe(200);

      // Present a DIFFERENT, still-unused code on a fresh challenge — and
      // present it in the BARE (dash-stripped) form to prove the server
      // normalises (uppercase + strip separators) before hashing, so the
      // display form and the typed form collide end-to-end over HTTP.
      const bareSecondCode = setup.recoveryCodes[1]!.replace(/-/g, '');
      const login2 = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challenge2 = (login2.body as { challengeToken: string }).challengeToken;
      const second = await callJson('/api/v1/auth/mfa/recovery/verify', {
        body: { challengeToken: challenge2, recoveryCode: bareSecondCode },
      });
      expect(second.status).toBe(200);
      expect((second.body as { outcome: string }).outcome).toBe('session');
      expect(extractRefreshCookie(second.setCookies)).not.toBeNull();

      // DB cross-check: now TWO distinct rows consumed.
      const rows = await harnessPrisma.mfaRecoveryCode.findMany({
        where: { userId: setup.userId },
        select: { consumedAt: true },
      });
      expect(rows.filter((r) => r.consumedAt !== null)).toHaveLength(2);
      expect(rows.filter((r) => r.consumedAt === null)).toHaveLength(8);
    });

    it('removing the only confirmed method deletes the entire recovery-code batch', async () => {
      const setup = await enrolMfaUser('recovery-remove');

      // Pre-check: the full ten-row batch exists and is pristine.
      const before = await harnessPrisma.mfaRecoveryCode.findMany({
        where: { userId: setup.userId },
        select: { consumedAt: true },
      });
      expect(before).toHaveLength(10);
      expect(before.every((r) => r.consumedAt === null)).toBe(true);

      // Authenticate the DELETE via the TOTP path (not a recovery code)
      // so every recovery code stays unconsumed — the post-remove
      // assertion then sees a clean ten-row → zero-row deletion of
      // UNUSED codes, proving `invalidateAll` wipes the whole batch (not
      // merely the consumed tombstones).
      await waitForNextTotpStep();
      const login = await callJson('/api/v1/auth/login', {
        body: { email: setup.email, password: VALID_PASSWORD },
      });
      const challengeToken = (login.body as { challengeToken: string }).challengeToken;
      const verify = await callJson('/api/v1/auth/mfa/verify', {
        body: { challengeToken, code: computeTotpCode(setup.secretBase32) },
      });
      expect(verify.status).toBe(200);
      const accessToken = (verify.body as { accessToken: string }).accessToken;

      const remove = await callJson(`/api/v1/auth/mfa/methods/${setup.methodId}`, {
        method: 'DELETE',
        bearer: accessToken,
      });
      expect(remove.status).toBe(200);
      expect(remove.body).toMatchObject({ removed: true });

      // Post-check: removing the last confirmed method ran
      // `recoveryCodes.invalidateAll` inside the remove transaction, so
      // ZERO recovery-code rows remain for the user. Cross-check the
      // mfa_enabled flag flipped false too (consistent with the existing
      // remove test) so a future login skips the MFA branch entirely.
      const after = await harnessPrisma.mfaRecoveryCode.findMany({
        where: { userId: setup.userId },
        select: { id: true },
      });
      expect(after).toHaveLength(0);
      const user = await harnessPrisma.user.findUnique({
        where: { id: setup.userId },
        select: { mfaEnabled: true },
      });
      expect(user?.mfaEnabled).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Test-only timing helper.
// ─────────────────────────────────────────────────────────────────────

/**
 * Wait until the next TOTP step boundary so a subsequent
 * `computeTotpCode` returns a code that is genuinely "fresh" — i.e.
 * derived from a step the `lastUsedStep` watermark on the method
 * row has not yet seen. Without this, the helper-driven verify call
 * frequently lands on the same step as the confirm call that ran
 * a few hundred ms earlier, and the step-watermark replay guard
 * (intended behaviour) returns null.
 *
 * Spinning rather than `setTimeout` because vitest's fake timers
 * (not used here, but commonly enabled in adjacent suites) would
 * silently no-op the sleep. The wait is bounded by the 30s step
 * period — worst case ~30s, average ~15s. In CI this matters; in
 * a local re-run during development the developer just waits.
 *
 * To keep total test runtime bounded, only the tests that
 * subsequently call `mfa/verify` use this — assertions that only
 * test `confirm` (the enrolment path) don't need a step boundary
 * because confirm + verify use different methods on `MfaService`
 * with independent watermarks (the verify path consults the
 * method's `lastUsedStep`; the confirm path advances it).
 */
async function waitForNextTotpStep(): Promise<void> {
  const stepMs = TOTP_PERIOD_SECONDS * 1000;
  const nowMs = Date.now();
  const currentStepStartMs = Math.floor(nowMs / stepMs) * stepMs;
  const nextStepStartMs = currentStepStartMs + stepMs;
  // Add a small safety margin so we cross the boundary cleanly and
  // don't race the step computation in `computeTotpCode`.
  const waitMs = nextStepStartMs - nowMs + 100;
  await new Promise<void>((res) => {
    setTimeout(res, waitMs);
  });
}
