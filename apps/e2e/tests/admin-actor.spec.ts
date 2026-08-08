import { expect, test } from '@playwright/test';

import { registerAdminUser } from '../src/admin-flows';
import { registerVerifiedUser } from '../src/auth-flows';
import { gateway } from '../src/gateway-client';

/**
 * The admin actor (TS-505d1; CLAUDE.md §3.1, §3.2).
 *
 * **What had never been tested.** Roughly forty admin surfaces sit behind
 * `SuperAdminRoleGuard`, and until this spec the suite had never held a token
 * that satisfied one — so the whole staff half of the platform had never been
 * exercised by a running process. Every guard, every downstream re-check and
 * every claim that crosses the edge to get there was covered only by unit
 * suites that build their own request object.
 *
 * **Two downstreams, deliberately.** `/admin/users` reaches service-identity,
 * which *minted* the token and could plausibly satisfy the gate from its own
 * database. `/admin/bookings` reaches service-booking, which has no user table
 * and no route back to identity: it can only know the caller is staff from the
 * signed `x-ts-actor-*` envelope the gateway mints. One surface proves the
 * grant took; two prove the roles claim survives the edge — which is the thing
 * TS-140-followup-1a found nobody had ever checked.
 *
 * **The negative cases are the point.** A gate asserted only from the allowed
 * side passes just as happily when it has stopped refusing anyone.
 */
test.describe('admin actor', () => {
  test('a super_admin reaches admin surfaces on two different services', async () => {
    const admin = await registerAdminUser('reaches-surfaces');

    const users = await gateway('/api/v1/admin/users?limit=1', {
      accessToken: admin.accessToken,
    });
    expect(users.status, `admin/users: ${users.text.slice(0, 500)}`).toBe(200);

    const bookings = await gateway('/api/v1/admin/bookings?limit=1', {
      accessToken: admin.accessToken,
    });
    expect(bookings.status, `admin/bookings: ${bookings.text.slice(0, 500)}`).toBe(200);
  });

  test('a verified non-admin is refused with 403, not 401', async () => {
    const customer = await registerVerifiedUser('non-admin');

    const response = await gateway('/api/v1/admin/users?limit=1', {
      accessToken: customer.accessToken,
    });

    // 403 rather than 401 is the assertion: the caller IS authenticated, and a
    // 401 here would tell them their session was the problem and send them
    // round the login loop for a permission they will never have.
    expect(response.status).toBe(403);
  });

  test('an anonymous caller is refused with 401', async () => {
    const response = await gateway('/api/v1/admin/users?limit=1');
    expect(response.status).toBe(401);
  });

  test('granting a staff role forces MFA on the next login', async () => {
    // The staff-MFA rule (CLAUDE.md §3.1) has exactly one observable form:
    // after the grant, password-only login stops minting sessions. This is the
    // only running test able to see that gate stop firing — `registerAdminUser`
    // asserts the same thing internally, so this spec exists to say the
    // property out loud rather than leaving it as a side effect of a helper.
    const admin = await registerAdminUser('mfa-forced');

    const response = await gateway('/api/v1/auth/login', {
      method: 'POST',
      body: { email: admin.email, password: admin.password },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'challenge' });
    expect(response.body).not.toHaveProperty('accessToken');
  });
});
