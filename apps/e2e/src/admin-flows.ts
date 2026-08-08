import {
  LoginResponseSchema,
  LoginSessionResponseSchema,
  MfaConfirmResponseSchema,
  MfaEnrollResponseSchema,
} from '@taste-and-see/contracts';

import { uniqueEmail } from './actors';
import { DEFAULT_PASSWORD, signUp, verifyEmail } from './auth-flows';
import { FLEET_TOTP_PERIOD_SECONDS } from './fleet';
import {
  gateway,
  REFRESH_COOKIE_NAME,
  readSetCookie,
  type GatewayResponse,
} from './gateway-client';
import { harnessPrisma } from './harness-db';
import { secondsUntilNextStep, totpCode } from './totp';

/**
 * Minting a staff account (TS-505d1).
 *
 * **Why this is a harness capability and not four lines in a spec.** Every one
 * of the platform's admin surfaces sits behind `SuperAdminRoleGuard`, and
 * until now the suite had never held a token that satisfied it — so not one of
 * them had ever been reached by a running process. The sequence below is the
 * same for all of them, and it is longer than it looks because two platform
 * rules interlock:
 *
 *   - CLAUDE.md §3.1 makes MFA mandatory for staff, and `AuthService` enforces
 *     it at *login*: a user holding any admin role with `mfaEnabled: false` is
 *     refused a session outright.
 *   - Enrolling a factor requires a session.
 *
 * So the order is not a preference. **Enrol first, grant second.** Granting
 * `super_admin` to an account with no factor produces an account that can
 * never log in again — which is the correct product behaviour and a permanent
 * dead end for a test that gets the order wrong.
 *
 * **Why the grant is a database write.** `POST /api/v1/rbac/.../grant` is
 * gated on `rbac:write`, which only a staff account holds, so the *first*
 * `super_admin` cannot come from the HTTP surface by construction. The
 * alternative is a bootstrap route that escalates privilege on request,
 * shipped to production to satisfy a test. See `harness-db.ts`.
 */

/** Scope every harness grant is issued at. `super_admin` is global by rule. */
const GLOBAL_SCOPE = 'global' as const;

export interface AdminUser {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  /** Session minted *after* the role grant, so its `roles[]` claim carries it. */
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Kept so a spec can mint a further code (re-login, step-up, logout tests). */
  readonly totpSecret: string;
}

/**
 * Sign up → verify → enrol TOTP → grant `super_admin` → log in through the
 * challenge. Returns a session that satisfies the admin gate at the edge and
 * at every downstream.
 */
export async function registerAdminUser(label = 'admin'): Promise<AdminUser> {
  const email = uniqueEmail(label);
  const created = await signUp(email, DEFAULT_PASSWORD);
  await verifyEmail(created.id);

  const preGrantSession = await loginExpectingSession(email);
  const totpSecret = await enrolTotpFactor(preGrantSession.accessToken);

  await grantSystemRole(created.id, 'super_admin');

  const session = await loginWithTotp(email, totpSecret);

  return {
    userId: created.id,
    email,
    password: DEFAULT_PASSWORD,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    totpSecret,
  };
}

/**
 * `POST /auth/mfa/totp/enroll` then `/confirm`, returning the shared secret.
 *
 * The confirm step is where the harness's independent RFC 6238 implementation
 * is checked against the server's: a wrong code is a 401 here, before any
 * admin assertion is reached, so a broken generator names itself.
 */
export async function enrolTotpFactor(accessToken: string): Promise<string> {
  const enrolled = await gateway('/api/v1/auth/mfa/totp/enroll', {
    method: 'POST',
    accessToken,
    body: { label: 'e2e-harness' },
  });
  expectStatus(enrolled, 201, 'mfa/totp/enroll');
  const { methodId, secretBase32 } = MfaEnrollResponseSchema.parse(enrolled.body);

  const confirmed = await gateway('/api/v1/auth/mfa/totp/confirm', {
    method: 'POST',
    accessToken,
    body: { methodId, code: await freshTotpCode(secretBase32) },
  });
  expectStatus(confirmed, 200, 'mfa/totp/confirm');
  MfaConfirmResponseSchema.parse(confirmed.body);

  return secretBase32;
}

/**
 * Insert an active `identity.user_roles` row at global scope.
 *
 * Written through the generated client rather than raw SQL so a column rename
 * in the migration is a type error here rather than a runtime failure inside a
 * spec that is about something else. `grantedByUserId` stays null, which is
 * what the schema documents for a system-issued grant.
 */
export async function grantSystemRole(userId: string, roleName: string): Promise<void> {
  const prisma = harnessPrisma();
  const role = await prisma.role.findUnique({ where: { name: roleName }, select: { id: true } });
  if (role === null) {
    throw new Error(
      `Role '${roleName}' is not in identity.roles — the RBAC catalog seed did not run. ` +
        `Check the seed step in global setup (apps/e2e/src/database.ts).`,
    );
  }

  await prisma.userRole.create({
    data: { userId, roleId: role.id, scopeType: GLOBAL_SCOPE, scopeId: null },
  });
}

/**
 * Log in an account that holds a confirmed TOTP factor: assert the challenge,
 * then spend a fresh code on `POST /auth/mfa/verify`.
 *
 * The challenge branch is asserted rather than tolerated. A login that
 * returned a session directly would mean the staff-MFA gate had stopped
 * firing — a security regression this is the only running test able to see.
 */
export async function loginWithTotp(
  email: string,
  totpSecret: string,
  password: string = DEFAULT_PASSWORD,
): Promise<{ readonly accessToken: string; readonly refreshToken: string }> {
  const login = await gateway('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  expectStatus(login, 200, 'login (expecting an MFA challenge)');

  const parsed = LoginResponseSchema.parse(login.body);
  if (parsed.outcome !== 'challenge') {
    throw new Error(
      'login returned a session for an account with a confirmed TOTP factor — ' +
        'the staff MFA gate (CLAUDE.md §3.1) is not firing.',
    );
  }

  const verified = await gateway('/api/v1/auth/mfa/verify', {
    method: 'POST',
    body: { challengeToken: parsed.challengeToken, code: await freshTotpCode(totpSecret) },
  });
  expectStatus(verified, 200, 'mfa/verify');

  const session = LoginSessionResponseSchema.parse(verified.body);
  return { accessToken: session.accessToken, refreshToken: requireRefreshCookie(verified) };
}

/** `POST /auth/login` asserting a plain session — used before the role grant. */
async function loginExpectingSession(
  email: string,
  password: string = DEFAULT_PASSWORD,
): Promise<{ readonly accessToken: string }> {
  const response = await gateway('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  expectStatus(response, 200, 'login');
  const parsed = LoginResponseSchema.parse(response.body);
  if (parsed.outcome !== 'session') {
    throw new Error('login returned an MFA challenge before any factor was enrolled');
  }
  return { accessToken: parsed.accessToken };
}

/**
 * A code the server has not already accepted.
 *
 * `mfa_methods.last_used_step` is a replay watermark: the same 6-digit code
 * presented twice is refused the second time, and enrolment and login are
 * comfortably less than 30 seconds apart. Waiting out the step boundary is
 * the protocol's own answer, not a retry — the wait is bounded by the period
 * and a code minted after it is guaranteed to be a new step.
 */
async function freshTotpCode(secretBase32: string): Promise<string> {
  const periodSeconds = FLEET_TOTP_PERIOD_SECONDS;

  const code = totpCode(secretBase32, { periodSeconds });
  if (lastIssuedCode === code) {
    await delay(Math.ceil(secondsUntilNextStep({ periodSeconds }) * 1000) + 250);
    const next = totpCode(secretBase32, { periodSeconds });
    lastIssuedCode = next;
    return next;
  }
  lastIssuedCode = code;
  return code;
}

/**
 * The last code this harness handed out, across every account.
 *
 * Deliberately not per-secret. Codes are only reused within a step, and one
 * module-level value keeps the guard correct for the common case (one account
 * enrolling then logging in) without pretending to track server-side state the
 * harness does not own.
 */
let lastIssuedCode: string | undefined;

function requireRefreshCookie(response: GatewayResponse): string {
  const value = readSetCookie(response, REFRESH_COOKIE_NAME);
  if (value === undefined || value === null) {
    throw new Error('mfa/verify did not set a refresh cookie');
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function expectStatus(response: GatewayResponse, expected: number, surface: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${surface} returned ${String(response.status)}, expected ${String(expected)}: ${response.text.slice(0, 800)}`,
    );
  }
}
