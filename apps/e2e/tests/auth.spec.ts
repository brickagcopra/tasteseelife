import {
  LoginResponseSchema,
  MeResponseSchema,
  RefreshResponseSchema,
  SignupResponseSchema,
} from '@taste-and-see/contracts';
import { expect, test } from '@playwright/test';

import {
  REFRESH_COOKIE_NAME,
  gateway,
  readSetCookie,
  readSetCookieAttributes,
} from '../src/gateway-client';
import { registerVerifiedUser, verifyEmail } from '../src/auth-flows';
import { uniqueEmail } from '../src/actors';

/**
 * The authentication spine, end to end through the api-gateway (TS-505,
 * CLAUDE.md §3.1 / §9.1).
 *
 * Every step of the money path that follows starts with a real session, so
 * this file is the foundation the rest of the suite stands on. It is also the
 * only place the platform's session security properties are asserted against
 * a running gateway *and* a running identity service together: the unit suites
 * on each side can both be green while the pair disagrees about cookie names,
 * token audiences, or the shape of a 401.
 *
 * The properties worth having a running fleet to assert:
 *
 *   - a password never crosses back over the wire, in any response;
 *   - the access token minted by service-identity is one the *gateway*
 *     accepts — two processes, one shared secret, no shared code path;
 *   - the refresh cookie is HttpOnly and rotates on every use;
 *   - presenting a superseded refresh cookie revokes the entire session
 *     family (§3.1 reuse detection), so a stolen cookie is worth one use and
 *     costs the thief the session.
 */

const PASSWORD = 'correct-horse-battery-staple';

test.describe('auth spine', () => {
  test('signs up, verifies, logs in, and reaches an authenticated surface', async () => {
    const email = uniqueEmail('signup');

    const signup = await gateway('/api/v1/auth/signup', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });

    expect(signup.status, signup.text).toBe(201);
    const created = SignupResponseSchema.parse(signup.body);
    expect(created.email).toBe(email.toLowerCase());
    // Signup lands in `pending_verification`, not `active` — and until TS-510
    // there was no way out of it, which is the defect this suite found on its
    // second run. The assertion is on the exact status rather than "not
    // active" so a future change that skips verification is a red test and a
    // decision, not a silent loosening of the onboarding gate.
    expect(created.status).toBe('pending_verification');
    // Signup is a resource creation, not a session (auth.schema.ts is explicit
    // about this). A token here would mean the gateway had started logging
    // users in as a side effect of registration.
    expect(signup.text).not.toContain('accessToken');
    expect(signup.text).not.toContain(PASSWORD);

    // An unverified account cannot log in, and the refusal is the generic
    // credential 401 — telling the caller "verify your email first" would
    // confirm the address is registered.
    const premature = await gateway('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    expect(premature.status, premature.text).toBe(401);

    await verifyEmail(created.id);

    const login = await gateway('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });

    expect(login.status, login.text).toBe(200);
    const session = LoginResponseSchema.parse(login.body);
    if (session.outcome !== 'session') {
      throw new Error('a fresh account has no MFA method, so login must return a session');
    }
    expect(session.tokenType).toBe('Bearer');
    expect(session.user.id).toBe(created.id);
    // CLAUDE.md §3.1 — access tokens live 15 minutes at most.
    expect(session.expiresIn).toBeLessThanOrEqual(900);

    // The gateway verifies this token itself, with its own copy of the signing
    // secret. A green identity suite proves the token was minted correctly; a
    // 200 here proves the gateway agrees about issuer, audience and algorithm.
    const me = await gateway('/api/v1/me', { accessToken: session.accessToken });
    expect(me.status, me.text).toBe(200);
    const actor = MeResponseSchema.parse(me.body);
    expect(actor.userId).toBe(created.id);
    expect(actor.mfaVerified).toBe(false);
    expect(actor.roles).toEqual([]);
  });

  test('rejects a duplicate registration without confirming the account exists', async () => {
    const email = uniqueEmail('duplicate');

    const first = await gateway('/api/v1/auth/signup', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    expect(first.status, first.text).toBe(201);

    const second = await gateway('/api/v1/auth/signup', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });

    expect(second.status, second.text).toBe(409);
    // The service deliberately does not say "that email is taken" — that
    // string is an account-enumeration oracle (auth.service.ts states the
    // reasoning). Assert the absence, because a well-meaning copy edit is
    // exactly how such a detail line comes back.
    expect(second.text.toLowerCase()).not.toContain('email');
    expect(second.text).not.toContain(email);
  });

  test('rejects a wrong password and an absent token identically to the caller', async () => {
    // Verified, so a 401 here is unambiguously about the password rather than
    // about the account still being unverified.
    const user = await registerVerifiedUser('wrongpass');
    const email = user.email;

    const wrong = await gateway('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password: `${PASSWORD}-nope` },
    });
    expect(wrong.status, wrong.text).toBe(401);
    expect(readSetCookie(wrong, REFRESH_COOKIE_NAME)).toBeUndefined();

    const unknown = await gateway('/api/v1/auth/login', {
      method: 'POST',
      body: { email: uniqueEmail('never-registered'), password: PASSWORD },
    });
    expect(unknown.status, unknown.text).toBe(401);

    const anonymous = await gateway('/api/v1/me');
    expect(anonymous.status, anonymous.text).toBe(401);

    const garbage = await gateway('/api/v1/me', { accessToken: 'not-a-jwt' });
    expect(garbage.status, garbage.text).toBe(401);
  });

  test('rotates the refresh cookie and revokes the family when a used one comes back', async () => {
    const user = await registerVerifiedUser('rotation');
    const email = user.email;

    const login = await gateway('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    expect(login.status, login.text).toBe(200);

    const firstRefreshToken = readSetCookie(login, REFRESH_COOKIE_NAME);
    expect(firstRefreshToken, 'login must mint a refresh cookie').toBeTruthy();

    // CLAUDE.md §3.1 — HttpOnly + SameSite. `Secure` is the one flag the
    // harness turns off (plain HTTP against 127.0.0.1), so it is not asserted
    // here; service-identity's unit suite pins its default to `true`.
    const attributes = readSetCookieAttributes(login, REFRESH_COOKIE_NAME);
    expect(attributes).toContain('httponly');
    expect(attributes.some((attribute) => attribute.startsWith('samesite='))).toBe(true);

    const refreshed = await gateway('/api/v1/auth/refresh', {
      method: 'POST',
      cookies: { [REFRESH_COOKIE_NAME]: firstRefreshToken as string },
    });
    expect(refreshed.status, refreshed.text).toBe(200);
    const rotated = RefreshResponseSchema.parse(refreshed.body);
    expect(rotated.tokenType).toBe('Bearer');

    const secondRefreshToken = readSetCookie(refreshed, REFRESH_COOKIE_NAME);
    expect(secondRefreshToken, 'refresh must rotate the cookie').toBeTruthy();
    expect(secondRefreshToken).not.toBe(firstRefreshToken);

    // The rotated token still works, so rotation has not broken the session.
    const withRotated = await gateway('/api/v1/me', { accessToken: rotated.accessToken });
    expect(withRotated.status, withRotated.text).toBe(200);

    // Now the property that matters: replaying the *superseded* cookie.
    const replay = await gateway('/api/v1/auth/refresh', {
      method: 'POST',
      cookies: { [REFRESH_COOKIE_NAME]: firstRefreshToken as string },
    });
    expect(replay.status, replay.text).toBe(401);

    // …and the replay must have cost the legitimate holder the session too.
    // Revoking only the replayed token would leave the thief's rotated copy
    // live, which is the failure mode reuse detection exists to prevent.
    const afterReuse = await gateway('/api/v1/auth/refresh', {
      method: 'POST',
      cookies: { [REFRESH_COOKIE_NAME]: secondRefreshToken as string },
    });
    expect(afterReuse.status, afterReuse.text).toBe(401);
  });

  test('rejects a malformed signup payload at the gateway, before identity is asked', async () => {
    const tooShort = await gateway('/api/v1/auth/signup', {
      method: 'POST',
      body: { email: uniqueEmail('short'), password: 'short' },
    });
    expect(tooShort.status, tooShort.text).toBe(400);

    // `.strict()` on the contract — an unknown field is a 400, not a silently
    // ignored one. A client sending `role: 'super_admin'` must never be
    // quietly accepted.
    const unknownField = await gateway('/api/v1/auth/signup', {
      method: 'POST',
      body: { email: uniqueEmail('extra'), password: PASSWORD, role: 'super_admin' },
    });
    expect(unknownField.status, unknownField.text).toBe(400);
  });
});
