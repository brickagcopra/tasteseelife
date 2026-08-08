import { expect, test } from '@playwright/test';

import { idempotencyKey } from '../src/actors';
import { registerVerifiedUser } from '../src/auth-flows';
import {
  createConciergeBooking,
  householdId,
  seniorId,
  setHouseholdTier,
  setProviderTier,
} from '../src/booking-flows';
import { gateway } from '../src/gateway-client';
import { providerDocument } from '../src/search-flows';

/**
 * The booking lifecycle, end to end through the gateway (TS-505d-prep).
 *
 * **Why this spec exists.** Premise-checking TS-505d found that
 * `POST /api/v1/bookings/concierge-request` was the only non-GET call the
 * gateway made to service-booking. A visit could be requested and read, and
 * then never accepted, never started and **never completed** — so no
 * commission was ever recognised and no provider was ever paid, on a platform
 * whose accounting subsystem is fully built and fully tested. The lifecycle
 * routes existed downstream and were unreachable from every client.
 *
 * The assertion that matters is therefore the whole walk, not any one step:
 * `pending → confirmed → in_progress → completed` through the surface a
 * provider's phone actually talks to.
 */
test.describe('booking lifecycle', () => {
  test('walks a visit from requested to completed through the gateway', async () => {
    const family = await registerVerifiedUser('lifecycle-family');
    const household = householdId();
    const provider = providerDocument({ tier: 'elite' });

    await setHouseholdTier(household, 'tier_3_concierge');
    await setProviderTier(provider.providerId, 'elite');

    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: seniorId(),
      providerId: provider.providerId,
    });
    expect(booking.status).toBe('pending');

    const accepted = await post(`/api/v1/bookings/${booking.id}/accept`, family.accessToken, {});
    expect(accepted.status, accepted.text).toBe(200);
    expect((accepted.body as { status: string }).status).toBe('confirmed');

    // Coordinates are the provider's GPS at the doorstep (TS-060-followup-4a).
    const checkIn = await post(`/api/v1/bookings/${booking.id}/check-ins`, family.accessToken, {
      kind: 'check_in',
      latitude: 40.7128,
      longitude: -74.006,
    });
    expect(checkIn.status, checkIn.text).toBe(201);
    expect((checkIn.body as { booking: { status: string } }).booking.status).toBe('in_progress');

    const checkOut = await post(`/api/v1/bookings/${booking.id}/check-ins`, family.accessToken, {
      kind: 'check_out',
      latitude: 40.7128,
      longitude: -74.006,
    });
    expect(checkOut.status, checkOut.text).toBe(201);

    // The step the money path hangs off: `check_out` is the visit having
    // happened, and it is what emits `booking.completed`.
    const completed = (checkOut.body as { booking: { status: string; completedAt: string | null } })
      .booking;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();

    // Both rows are readable back through the gateway, in order.
    const listed = await gateway(`/api/v1/bookings/${booking.id}/check-ins`, {
      accessToken: family.accessToken,
    });
    expect(listed.status).toBe(200);
    expect((listed.body as { items: { kind: string }[] }).items.map((i) => i.kind)).toEqual([
      'check_in',
      'check_out',
    ]);
  });

  test('refuses a check-out on a visit that never started', async () => {
    const family = await registerVerifiedUser('lifecycle-order');
    const household = householdId();
    const provider = providerDocument({ tier: 'elite' });

    await setHouseholdTier(household, 'tier_1_essential');
    await setProviderTier(provider.providerId, 'elite');

    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: seniorId(),
      providerId: provider.providerId,
    });

    const checkOut = await post(`/api/v1/bookings/${booking.id}/check-ins`, family.accessToken, {
      kind: 'check_out',
      latitude: 40.7128,
      longitude: -74.006,
    });

    // 409 from the downstream state machine, forwarded verbatim. The gateway
    // must not be a second place the lifecycle rules are written down — if it
    // re-derived them, the two copies would be free to disagree.
    expect(checkOut.status).toBe(409);
  });

  test('a declined request does not become a visit', async () => {
    const family = await registerVerifiedUser('lifecycle-decline');
    const household = householdId();
    const provider = providerDocument({ tier: 'elite' });

    await setHouseholdTier(household, 'tier_1_essential');
    await setProviderTier(provider.providerId, 'elite');

    const booking = await createConciergeBooking({
      accessToken: family.accessToken,
      householdId: household,
      seniorId: seniorId(),
      providerId: provider.providerId,
    });

    const declined = await post(`/api/v1/bookings/${booking.id}/decline`, family.accessToken, {
      declineReason: 'schedule_conflict',
    });
    expect(declined.status, declined.text).toBe(200);
    expect((declined.body as { status: string }).status).toBe('declined');

    const accepted = await post(`/api/v1/bookings/${booking.id}/accept`, family.accessToken, {});
    expect(accepted.status).toBe(409);
  });
});

/** POST through the gateway, always carrying an `Idempotency-Key` (§3.3). */
async function post(
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
): ReturnType<typeof gateway> {
  return gateway(path, {
    method: 'POST',
    accessToken,
    idempotencyKey: idempotencyKey(),
    body,
  });
}
