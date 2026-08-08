import { expect, test } from '@playwright/test';
import { HOUSEHOLD_SCOPE_HEADER } from '@taste-and-see/contracts';

import { registerAdminUser } from '../src/admin-flows';
import { registerVerifiedUser } from '../src/auth-flows';
import { gateway } from '../src/gateway-client';
import { seedHouseholdWithMember } from '../src/household-flows';
import { idempotencyKey } from '../src/actors';

/**
 * Household tenant scope, end to end (TS-505d2-followup-5).
 *
 * **What had never worked.** `TokenService.signAccessToken` defaults
 * `tenantScope` to `global` and no caller in service-identity has ever passed
 * anything else. Thirteen handlers across service-booking, service-concierge
 * and service-trust-safety read the acting household out of that scope and
 * deliberately refuse a body-supplied id — the asymmetry TS-301a describes as
 * the trust boundary. So the family dashboard, wellness surfaces, concierge
 * and "report a concern" were unreachable by any real user, on a platform
 * where every one of those services' unit suites was green.
 *
 * "Report a concern" is the surface under test because it is the shortest
 * gateway-reachable path that reads the scope, and because CLAUDE.md §12
 * makes welfare concerns first-class — a dead welfare-reporting path is the
 * worst version of this defect.
 *
 * **Why only an E2E can prove it.** The fix is a global `APP_INTERCEPTOR` in
 * the gateway that enriches the request context between the guard phase and
 * the handler, and then a signed trust envelope crossing a process boundary.
 * A unit test constructs the class and calls the method — Nest's interceptor
 * pipeline never runs, and nothing signs or verifies anything. That is the
 * same blind spot that hid the 33 permanently-400 routes (TS-505d-prep) and
 * the consumer that never subscribed (TS-505d2).
 */

const CONCERN = {
  category: 'welfare' as const,
  description: 'Mum seemed unsteady on her feet after the last visit and skipped lunch.',
};

test.describe('household tenant scope', () => {
  test('a family member with one household can file a concern', async () => {
    const user = await registerVerifiedUser('household-scope-single');
    const { householdId } = await seedHouseholdWithMember({ userId: user.userId });

    const response = await gateway('/api/v1/trust-safety/incidents', {
      method: 'POST',
      accessToken: user.accessToken,
      idempotencyKey: idempotencyKey(),
      body: CONCERN,
    });

    // The whole point: no header was sent, no household id was in the body,
    // and the token says `global`. The gateway resolved the scope from the
    // one active membership and signed it downstream.
    expect(response.status, response.text).toBe(201);
    const body = response.body as { receipt: { incidentId: string; category: string } };
    expect(body.receipt.category).toBe('welfare');
    expect(body.receipt.incidentId).toMatch(/\S/);
    // The receipt is deliberately minimal (TS-301a) — no severity, no SLA,
    // no status. Assert that it stays that way rather than only that it
    // arrived.
    expect(Object.keys(body.receipt).sort()).toEqual(['category', 'incidentId', 'openedAt']);

    // **The assertion that matters.** A 201 only proves something happened.
    // Read the incident back through the operator surface — a different
    // route, a different actor, a different permission class — and check it
    // was filed against the household the filer actually belongs to. That
    // is the thing the tenant scope decides, and it is not observable from
    // the receipt (which deliberately carries no household id).
    const operator = await registerAdminUser('household-scope-reader');
    const detail = await gateway(
      `/api/v1/admin/trust-safety/incidents/${body.receipt.incidentId}`,
      { accessToken: operator.accessToken },
    );
    expect(detail.status, detail.text).toBe(200);
    const incident = (detail.body as { incident: { householdId: string | null; source: string } })
      .incident;
    expect(incident.householdId).toBe(householdId);
    // And it is attributed to the family, not to the concierge on-behalf
    // path — the fallback producer TS-505d2-followup-3b recorded and
    // deliberately did not take.
    expect(incident.source).toBe('family');
  });

  test('a user who belongs to no household is refused, and told why', async () => {
    const user = await registerVerifiedUser('household-scope-none');

    const response = await gateway('/api/v1/trust-safety/incidents', {
      method: 'POST',
      accessToken: user.accessToken,
      idempotencyKey: idempotencyKey(),
      body: CONCERN,
    });

    // Unchanged behaviour — this is the pre-existing refusal, and it is
    // correct. What changed is that a family member no longer meets it.
    expect(response.status, response.text).toBe(400);
    const body = response.body as { detail?: string };
    expect(body.detail ?? '').toContain('household members');
  });

  test('a user cannot obtain a scope for a household they do not belong to', async () => {
    // The security property of the whole seam. The header is accepted from a
    // browser precisely because it can only SELECT from a list the gateway
    // fetched for that user id.
    const owner = await registerVerifiedUser('household-scope-owner');
    const intruder = await registerVerifiedUser('household-scope-intruder');
    const { householdId } = await seedHouseholdWithMember({ userId: owner.userId });

    const response = await gateway('/api/v1/trust-safety/incidents', {
      method: 'POST',
      accessToken: intruder.accessToken,
      idempotencyKey: idempotencyKey(),
      headers: { [HOUSEHOLD_SCOPE_HEADER]: householdId },
      body: CONCERN,
    });

    // 403, not "ignore the header and fall through to global". A client that
    // named a household is asking to act in one, and quietly acting
    // elsewhere is worse than a clear refusal.
    expect(response.status, response.text).toBe(403);
  });

  test('a member of two households must name the one they mean', async () => {
    // The adult child paying for two parents. Auto-resolving would pick a
    // household by row order — the one outcome this design refuses.
    const user = await registerVerifiedUser('household-scope-two');
    const first = await seedHouseholdWithMember({ userId: user.userId });
    const second = await seedHouseholdWithMember({ userId: user.userId });

    const ambiguous = await gateway('/api/v1/trust-safety/incidents', {
      method: 'POST',
      accessToken: user.accessToken,
      idempotencyKey: idempotencyKey(),
      body: CONCERN,
    });
    expect(ambiguous.status, ambiguous.text).toBe(400);
    // The refusal names the header, so the client can act on it. Before this
    // task the same 400 said only "household members", which is unhelpful to
    // a user who is one.
    expect((ambiguous.body as { detail?: string }).detail ?? '').toContain(HOUSEHOLD_SCOPE_HEADER);

    for (const household of [first, second]) {
      const named = await gateway('/api/v1/trust-safety/incidents', {
        method: 'POST',
        accessToken: user.accessToken,
        idempotencyKey: idempotencyKey(),
        headers: { [HOUSEHOLD_SCOPE_HEADER]: household.householdId },
        body: CONCERN,
      });
      expect(named.status, named.text).toBe(201);
    }
  });

  test('/me reports which households the actor could act in, not only the one in scope', async () => {
    // The field the family portal renders its picker from
    // (TS-505d2-followup-5a). Without it a two-household member sees a 400
    // telling them to send a header they have no way to construct.
    const user = await registerVerifiedUser('household-scope-me');
    const first = await seedHouseholdWithMember({ userId: user.userId });
    const second = await seedHouseholdWithMember({
      userId: user.userId,
      memberRole: 'family_observer',
    });

    const response = await gateway('/api/v1/me', { accessToken: user.accessToken });
    expect(response.status, response.text).toBe(200);
    const me = response.body as {
      tenantScope: { type: string };
      households: ReadonlyArray<{ householdId: string; memberRole: string }>;
    };

    expect(me.households.map((h) => h.householdId).sort()).toEqual(
      [first.householdId, second.householdId].sort(),
    );
    expect(me.households.find((h) => h.householdId === second.householdId)?.memberRole).toBe(
      'family_observer',
    );
    // Still `global` — two memberships and no header, so the gateway refuses
    // to pick. That is precisely the state `households` exists to resolve.
    expect(me.tenantScope.type).toBe('global');

    // And with the header, the same call reports the chosen household in
    // scope while still listing both as available.
    const chosen = await gateway('/api/v1/me', {
      accessToken: user.accessToken,
      headers: { [HOUSEHOLD_SCOPE_HEADER]: second.householdId },
    });
    expect(chosen.status, chosen.text).toBe(200);
    const scoped = chosen.body as {
      tenantScope: { type: string; householdId?: string };
      households: readonly unknown[];
    };
    expect(scoped.tenantScope).toEqual({
      type: 'household',
      householdId: second.householdId,
    });
    expect(scoped.households).toHaveLength(2);
  });

  test('an actor with no household gets an empty list, not a missing field', async () => {
    // The common case — staff, providers, partner users. A missing field and
    // an empty list are indistinguishable to a client deciding whether to
    // show a picker, so the contract makes it always present.
    const user = await registerVerifiedUser('household-scope-me-none');
    const response = await gateway('/api/v1/me', { accessToken: user.accessToken });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toHaveProperty('households', []);
  });

  test('the scope does not leak into a request that carries no actor', async () => {
    // The interceptor runs globally. A public route must be untouched — and
    // must not start 500-ing because something tried to resolve a scope for
    // an actor that is not there.
    const response = await gateway('/healthz');
    expect(response.status).toBe(200);
  });
});
