import { expect, test } from '@playwright/test';

import { registerVerifiedUser } from '../src/auth-flows';
import {
  createConciergeBooking,
  householdId,
  requestConciergeBooking,
  seniorId,
  setHouseholdTier,
  setProviderTier,
} from '../src/booking-flows';
import { gateway } from '../src/gateway-client';
import { indexProvider, providerDocument, searchProviders } from '../src/search-flows';

/**
 * Tier-gated booking (TS-505c; CLAUDE.md §12).
 *
 * §12 states the rule and states where it lives: *"Tier 3 (Concierge) clients
 * can only book Elite Concierge providers. Enforce at the booking-svc layer,
 * not the UI."* The second clause is the one only this level can assert. A
 * portal test proves the ineligible provider was not offered; it cannot prove
 * what happens when a client asks anyway — and "the option was hidden" and
 * "the request is refused" are different guarantees, only one of which
 * survives a client that does not use the portal.
 *
 * So every spec here sends the request the UI would never send, and asserts
 * the refusal comes back from the service.
 */
test.describe('tier-gated booking', () => {
  test('a Tier 3 household cannot book a non-elite provider', async () => {
    const family = await registerVerifiedUser('tier3-family');
    const household = householdId();
    const senior = seniorId();
    const certified = providerDocument({ tier: 'certified' });

    await setHouseholdTier(household, 'tier_3_concierge');
    await setProviderTier(certified.providerId, 'certified');

    const response = await requestConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: senior,
      providerId: certified.providerId,
    });

    // 409, not 403: the caller is authorised and the request is well-formed —
    // it conflicts with an active policy. (The service's own mapping makes the
    // same distinction for a trust & safety hold.)
    expect(response.status).toBe(409);
    expect(response.text).toContain('Elite Concierge providers');
  });

  test('the same household books the same visit once the provider is elite', async () => {
    const family = await registerVerifiedUser('tier3-elite');
    const household = householdId();
    const senior = seniorId();
    const elite = providerDocument({ tier: 'elite' });

    await setHouseholdTier(household, 'tier_3_concierge');
    await setProviderTier(elite.providerId, 'elite');

    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: senior,
      providerId: elite.providerId,
    });

    expect(booking.householdId).toBe(household);
    expect(booking.providerId).toBe(elite.providerId);
    // Every concierge request is created pending — the concierge team
    // confirms it. A create that landed anywhere else would mean the family
    // portal is booking care nobody has accepted.
    expect(booking.status).toBe('pending');
  });

  test('a Tier 1 household books a certified provider the Tier 3 household was refused', async () => {
    const family = await registerVerifiedUser('tier1-family');
    const household = householdId();
    const certified = providerDocument({ tier: 'certified' });

    await setHouseholdTier(household, 'tier_1_essential');
    await setProviderTier(certified.providerId, 'certified');

    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: seniorId(),
      providerId: certified.providerId,
    });

    // The complement of the first spec, and the reason it is worth having: a
    // gate that refused *everything* would pass that assertion. The two
    // together say the rule is the tier pairing, not a broken booking path.
    expect(booking.status).toBe('pending');
  });

  test('a household with no tier snapshot is refused rather than defaulted', async () => {
    const family = await registerVerifiedUser('tier-unknown');
    const elite = providerDocument({ tier: 'elite' });
    await setProviderTier(elite.providerId, 'elite');

    const response = await requestConciergeBooking({
      accessToken: family.accessToken,
      // Deliberately never hydrated.
      householdId: householdId(),
      seniorId: seniorId(),
      providerId: elite.providerId,
    });

    // In `enforce` mode an unknown household is a refusal, not an implied
    // Tier 1. This is the property that makes the gate fail *closed*: the
    // cache is hydrated by a separate workload, and a cache miss that read as
    // "cheapest tier" would let a lagging consumer quietly widen who may be
    // booked for a Tier 3 senior.
    expect(response.status).toBe(409);
  });

  test('search to booking: the searchId a family received is accepted on the visit it books', async () => {
    const family = await registerVerifiedUser('search-to-booking');
    const household = householdId();
    const elite = providerDocument({ tier: 'elite' });

    await indexProvider(elite);
    await setHouseholdTier(household, 'tier_3_concierge');
    await setProviderTier(elite.providerId, 'elite');

    const results = await searchProviders(family.accessToken, {
      query: elite.displayName,
      limit: 10,
    });
    expect(results.hits.map((hit) => hit.document.providerId)).toContain(elite.providerId);

    // The one journey a family actually makes — find a provider, book that
    // provider — across three services and two contracts. The `searchId` is
    // the correlation token service-analytics joins on (TS-217-prep-4c); it
    // crosses a service boundary here and nothing else exercises that hop.
    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: seniorId(),
      providerId: elite.providerId,
      searchId: results.searchId,
    });

    expect(booking.status).toBe('pending');

    // Readable back by the family that created it, through the gateway.
    const read = await gateway(`/api/v1/bookings/${encodeURIComponent(booking.id)}`, {
      accessToken: family.accessToken,
    });
    expect(read.status).toBe(200);
  });
});
