import { expect, test } from '@playwright/test';

import { registerAdminUser } from '../src/admin-flows';
import { registerVerifiedUser } from '../src/auth-flows';
import {
  createConciergeBooking,
  requestConciergeBooking,
  seniorId,
  setHouseholdTier,
  setProviderTier,
} from '../src/booking-flows';
import { gateway } from '../src/gateway-client';
import { seedHouseholdWithMember } from '../src/household-flows';
import { providerDocument } from '../src/search-flows';
import { fileConcern, listBookingHolds, waitForBookingHolds } from '../src/trust-safety-flows';

/**
 * A trust & safety incident suspends a household's visits (TS-505d2-followup-3b).
 *
 * **Neither half of this had ever run.** `service-trust-safety` appends
 * `trust_safety.booking_hold.requested` inside the incident transaction and
 * `service-booking`'s outbox consumer turns it into a `booking_subject_holds`
 * row plus a `held_by_incident_id` stamp (TS-304) — but no event consumer on
 * the platform had ever subscribed until TS-505d2, and the family surface
 * that files the incident could not be reached by any actor until
 * TS-505d2-followup-5. So a trust & safety incident has never actually
 * suspended a booking, in any environment, while both services' unit suites
 * stayed green.
 *
 * **Three processes and a real bus hop**: trust-safety → `worker-outbox-relay`
 * → booking. The assertion is a booking-side consequence, not an event.
 *
 * **The producer is the family path, not the concierge on-behalf route.**
 * TS-505d2-followup-3b recorded the admin route as a legitimate fallback and
 * deliberately did not take it, because using it would have asserted the hold
 * mechanism while stepping around a dead family path. That path is alive now,
 * so this spec files the concern the way a daughter would.
 */

const WELFARE_CONCERN =
  'Mum was left waiting outside for the whole visit and seemed frightened afterwards.';
const BILLING_CONCERN = 'We were charged twice for the same visit last Tuesday.';

/** A household with a booked visit and a family member who can report on it. */
async function seedHouseholdWithVisit(label: string): Promise<{
  readonly accessToken: string;
  readonly householdId: string;
  readonly bookingId: string;
  readonly seniorId: string;
  readonly providerId: string;
}> {
  const family = await registerVerifiedUser(label);
  const { householdId } = await seedHouseholdWithMember({ userId: family.userId });
  const senior = seniorId();
  const provider = providerDocument({ tier: 'elite' });

  // The tier gate runs in `enforce` on this fleet, so both snapshots have to
  // exist before a booking is possible — see `tier-gated-booking.spec.ts`.
  await setHouseholdTier(householdId, 'tier_1_essential');
  await setProviderTier(provider.providerId, 'elite');

  const booking = await createConciergeBooking({
    accessToken: family.accessToken,
    householdId,
    seniorId: senior,
    providerId: provider.providerId,
  });

  return {
    accessToken: family.accessToken,
    householdId,
    bookingId: booking.id,
    seniorId: senior,
    providerId: provider.providerId,
  };
}

test.describe('an incident holds a booking', () => {
  test('a high-severity concern suspends the household and refuses a new booking', async () => {
    const operator = await registerAdminUser('hold-operator');
    const world = await seedHouseholdWithVisit('hold-family');

    // `welfare` grades to `high` at intake (TS-301a), which is one of the two
    // severities `booking-hold-policy.ts` holds on. The family never names a
    // severity — grading is trust & safety's decision, and this spec asserts
    // the platform's own default rather than steering it.
    const receipt = await fileConcern({
      accessToken: world.accessToken,
      category: 'welfare',
      description: WELFARE_CONCERN,
    });

    const holds = await waitForBookingHolds(operator.accessToken, receipt.incidentId, 1);

    // **The subject is the household**, because that is what a family-filed
    // concern names — there is no self-asserted provider id on this path
    // (TS-301a: a reporter must not be able to pin a concern on someone
    // else). One hold row, one subject.
    expect(holds).toHaveLength(1);
    const hold = holds[0];
    expect(hold?.subjectKind).toBe('household');
    expect(hold?.subjectId).toBe(world.householdId);
    expect(hold?.severity).toBe('high');
    expect(hold?.releasedAt).toBeNull();

    // **The per-row stamp**: the visit that already existed is suspended, and
    // the count is attributed to this incident.
    expect(hold?.incidentSuspendedBookingCount).toBe(1);

    // **The pre-flight path, which is a different question** (TS-304 exists
    // because a per-row marker cannot answer "is this subject held" before a
    // row exists). A brand-new booking for the same household is refused.
    const blocked = await requestConciergeBooking({
      accessToken: world.accessToken,
      householdId: world.householdId,
      seniorId: world.seniorId,
      providerId: world.providerId,
    });
    expect(blocked.status, blocked.text).toBe(409);
  });

  test('a medium-severity concern holds nothing', async () => {
    // Without this the spec would prove only that *something* happened. The
    // severity predicate lives with trust & safety and booking honours an
    // explicit order; `billing` grades to `medium`, whose 24h SLA is the
    // everyday queue, not a reason to stop a senior's meals.
    const operator = await registerAdminUser('no-hold-operator');
    const world = await seedHouseholdWithVisit('no-hold-family');

    const receipt = await fileConcern({
      accessToken: world.accessToken,
      category: 'billing',
      description: BILLING_CONCERN,
    });

    // A negative across an asynchronous hop cannot be proven by looking once,
    // so this waits out a window in which a hold would certainly have landed:
    // the positive case above completes well inside it.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const page = await listBookingHolds(operator.accessToken, {
      incidentId: receipt.incidentId,
      status: 'all',
    });
    expect(page.holds).toHaveLength(0);

    // And the household can still book — the everyday complaint did not
    // interrupt anyone's care.
    const allowed = await requestConciergeBooking({
      accessToken: world.accessToken,
      householdId: world.householdId,
      seniorId: world.seniorId,
      providerId: world.providerId,
    });
    expect(allowed.status, allowed.text).toBe(201);
  });

  test('the holds surface is not readable without trust_safety:read', async () => {
    // The hold list names who is under investigation. CLAUDE.md §12 is
    // explicit that this must not spread across the booking queue, which is
    // why the route is gated on a trust & safety permission rather than a
    // booking one (TS-304-followup-3).
    const family = await registerVerifiedUser('hold-reader-denied');
    const response = await gateway('/api/v1/admin/booking-holds', {
      accessToken: family.accessToken,
    });
    expect(response.status).toBe(403);
  });
});
