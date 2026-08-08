import { expect, test } from '@playwright/test';
import {
  FamilyVisitsDashboardResponseSchema,
  FamilyWellnessAnomalyResponseSchema,
  FamilyWellnessTrendsResponseSchema,
} from '@taste-and-see/contracts';

import { registerVerifiedUser } from '../src/auth-flows';
import { createConciergeBooking, setHouseholdTier, setProviderTier } from '../src/booking-flows';
import { gateway } from '../src/gateway-client';
import { requireSeniorId, seedHouseholdWithMember } from '../src/household-flows';
import { providerDocument } from '../src/search-flows';

/**
 * The family's own surfaces (TS-505d2-followup-5b).
 *
 * **These had never been reached by a running process.** All three resolve
 * the acting household from `requestContext.tenantScope`, and until
 * TS-505d2-followup-5 no token carried one — so the family visits dashboard,
 * wellness trends and wellness anomalies returned 400 to every real user
 * while service-booking's 765 unit tests stayed green. That combination
 * (green suites, dead routes) has produced a defect every time this session
 * has looked at it.
 *
 * Two of the three are gateway *aggregators*, and the interesting property
 * is not the numbers: it is that the **consent gate** in front of them
 * actually runs. CLAUDE.md §12 limits a family observer to what the senior
 * has consented to share, and the default is opt-out — so an observer must
 * see `shared: false` on a household whose payer sees the data.
 */

test.describe('family surfaces', () => {
  test('the visits dashboard resolves the household from the token alone', async () => {
    const family = await registerVerifiedUser('dashboard-family');
    const { householdId } = await seedHouseholdWithMember({ userId: family.userId });

    const response = await gateway('/api/v1/bookings/dashboard/me', {
      accessToken: family.accessToken,
    });

    expect(response.status, response.text).toBe(200);
    const dashboard = FamilyVisitsDashboardResponseSchema.parse(response.body);
    // The household id is an OUTPUT here. The caller never sent one — the
    // gateway deliberately does not forward a `householdId` query param
    // (query-string smuggling would reach the downstream otherwise), so this
    // value can only have come from the resolved tenant scope.
    expect(dashboard.householdId).toBe(householdId);
    expect(dashboard.upcoming).toEqual([]);
    expect(dashboard.history).toEqual([]);
  });

  test('a booked visit appears on the dashboard as upcoming', async () => {
    // Without this the first spec proves only that the route answers. This
    // proves it answers about the right household's visits.
    const family = await registerVerifiedUser('dashboard-visit');
    const seeded = await seedHouseholdWithMember({ userId: family.userId, withSenior: true });
    const senior = requireSeniorId(seeded);
    const provider = providerDocument({ tier: 'elite' });

    await setHouseholdTier(seeded.householdId, 'tier_1_essential');
    await setProviderTier(provider.providerId, 'elite');
    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: seeded.householdId,
      seniorId: senior,
      providerId: provider.providerId,
    });

    const response = await gateway('/api/v1/bookings/dashboard/me', {
      accessToken: family.accessToken,
    });
    expect(response.status, response.text).toBe(200);
    const dashboard = FamilyVisitsDashboardResponseSchema.parse(response.body);
    expect(dashboard.upcoming.map((visit) => visit.id)).toContain(booking.id);
  });

  test("another household's dashboard is not reachable by asking for it", async () => {
    // The scope is the only input, so there is no parameter to tamper with —
    // which is the property, and it is worth an explicit spec because the
    // obvious alternative design (a `householdId` query param) would have
    // needed a row-level check the route does not have.
    const outsider = await registerVerifiedUser('dashboard-outsider');
    const neighbour = await registerVerifiedUser('dashboard-neighbour');
    const { householdId } = await seedHouseholdWithMember({ userId: neighbour.userId });

    const response = await gateway(`/api/v1/bookings/dashboard/me?householdId=${householdId}`, {
      accessToken: outsider.accessToken,
    });

    // 400, and the refusal is EARLIER and stronger than "you belong to no
    // household": the gateway's query schema is `.strict()`, so a
    // `householdId` param is an `unrecognized_keys` validation failure before
    // any resolution happens. The param never reaches service-booking at all.
    expect(response.status, response.text).toBe(400);
    const problem = response.body as {
      detail?: string;
      issues?: ReadonlyArray<{ code?: string; keys?: readonly string[] }>;
    };
    expect(problem.issues?.[0]?.code).toBe('unrecognized_keys');
    expect(problem.issues?.[0]?.keys).toEqual(['householdId']);

    // The neighbour's data is what must not come back. (`instance` echoes the
    // caller's own request URI per RFC 7807 — that is their own input coming
    // home, not a disclosure, so the assertion is on the body's payload
    // fields rather than on the raw text.)
    expect(problem).not.toHaveProperty('upcoming');
    expect(problem).not.toHaveProperty('history');
  });

  test('the payer sees wellness trends; an observer sees them withheld', async () => {
    const payer = await registerVerifiedUser('wellness-payer');
    const observer = await registerVerifiedUser('wellness-observer');
    const seeded = await seedHouseholdWithMember({
      userId: payer.userId,
      withSenior: true,
      // Same household — an observer in a different one is a non-member, and
      // the 403 that produces looks exactly like a consent refusal.
      alsoMembers: [{ userId: observer.userId, memberRole: 'family_observer' }],
    });
    const senior = requireSeniorId(seeded);

    const asPayer = await gateway(`/api/v1/seniors/${senior}/wellness-trends`, {
      accessToken: payer.accessToken,
    });
    expect(asPayer.status, asPayer.text).toBe(200);
    // `canManage` — the payer is the account manager and does not need the
    // senior's consent to see their own household's care record.
    expect(FamilyWellnessTrendsResponseSchema.parse(asPayer.body).shared).toBe(true);

    const asObserver = await gateway(`/api/v1/seniors/${senior}/wellness-trends`, {
      accessToken: observer.accessToken,
    });
    expect(asObserver.status, asObserver.text).toBe(200);
    const withheld = FamilyWellnessTrendsResponseSchema.parse(asObserver.body);
    // **Default opt-out, and the withholding is explicit rather than empty.**
    // §12: a family observer sees what the senior consented to share, and no
    // consent row means no. `shared: false` says "there is a boundary here",
    // which an empty series alone would not.
    expect(withheld.shared).toBe(false);
    expect(withheld.series).toEqual([]);
  });

  test('the same consent gate governs wellness anomalies', async () => {
    // A separate surface with its own aggregator and its own copy of the
    // gate — which is exactly why it needs its own spec rather than being
    // assumed to match trends.
    const payer = await registerVerifiedUser('anomaly-payer');
    const observer = await registerVerifiedUser('anomaly-observer');
    const seeded = await seedHouseholdWithMember({
      userId: payer.userId,
      withSenior: true,
      alsoMembers: [{ userId: observer.userId, memberRole: 'family_observer' }],
    });
    const senior = requireSeniorId(seeded);

    const asPayer = await gateway(`/api/v1/seniors/${senior}/wellness-anomalies`, {
      accessToken: payer.accessToken,
    });
    expect(asPayer.status, asPayer.text).toBe(200);
    expect(FamilyWellnessAnomalyResponseSchema.parse(asPayer.body).shared).toBe(true);

    const asObserver = await gateway(`/api/v1/seniors/${senior}/wellness-anomalies`, {
      accessToken: observer.accessToken,
    });
    expect(asObserver.status, asObserver.text).toBe(200);
    expect(FamilyWellnessAnomalyResponseSchema.parse(asObserver.body).shared).toBe(false);
  });

  test("a senior in someone else's household is not readable", async () => {
    const owner = await registerVerifiedUser('wellness-owner');
    const stranger = await registerVerifiedUser('wellness-stranger');
    const seeded = await seedHouseholdWithMember({ userId: owner.userId, withSenior: true });
    const senior = requireSeniorId(seeded);

    const response = await gateway(`/api/v1/seniors/${senior}/wellness-trends`, {
      accessToken: stranger.accessToken,
    });

    // The consent read is the authorisation step (the aggregator's own
    // comment says so), so a non-member is refused there — not handed a
    // `shared: false` body, which would confirm the senior exists.
    expect([400, 403, 404]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });
});
