import { randomUUID } from 'node:crypto';

import {
  BookingResponseSchema,
  HouseholdTierSnapshotResponseSchema,
  ProviderTierSnapshotResponseSchema,
  type BookingResponse,
  type BookingServiceKind,
  type HouseholdSubscriptionTier,
  type ProviderTierSnapshotTier,
} from '@taste-and-see/contracts';

import { idempotencyKey } from './actors';
import { gateway, type GatewayResponse } from './gateway-client';
import { expectInternalStatus, internal } from './internal-client';

/**
 * Booking flows (TS-505c).
 *
 * **The booking a family can actually create is a concierge request.**
 * `POST /api/v1/bookings` exists on service-booking but is not proxied by the
 * gateway — the Phase-1 family path is
 * `POST /api/v1/bookings/concierge-request`, which service-booking funnels
 * through the same `createBooking` (and therefore the same tier gate) after
 * deriving platform-default pricing. That is the surface these helpers drive,
 * because it is the surface a client has.
 *
 * **Tier snapshots are hydrated, not assumed.** service-booking does not own
 * household or provider tier (§2.3) — it keeps a read-side cache and the gate
 * reads that cache. In `enforce` mode a *missing* snapshot is itself a
 * refusal (`household_snapshot_unknown` / `provider_snapshot_unknown`), which
 * is the correct behaviour and also means a spec that forgets to hydrate gets
 * a 409 for the wrong reason. `setHouseholdTier` / `setProviderTier` make the
 * hydration a visible step of every booking spec.
 */

/** Ids service-booking treats as opaque soft FKs (§2.3) — bounded at 64 chars. */
export function householdId(): string {
  return `e2e-hh-${randomUUID()}`;
}

export function seniorId(): string {
  return `e2e-senior-${randomUUID()}`;
}

/** Hydrate the household side of the tier cache. */
export async function setHouseholdTier(id: string, tier: HouseholdSubscriptionTier): Promise<void> {
  const response = await internal(
    'service-booking',
    '/api/v1/internal/booking/tier-snapshots/household',
    {
      method: 'POST',
      body: { householdId: id, tier, lastSyncedAt: new Date().toISOString() },
      secretEnvKey: 'BOOKING_TIER_DISPATCH_API_KEY',
    },
  );
  expectInternalStatus(response, 200, 'household tier snapshot upsert');
  const parsed = HouseholdTierSnapshotResponseSchema.parse(response.body);
  if (parsed.tier !== tier) {
    throw new Error(`household snapshot persisted tier '${parsed.tier}', expected '${tier}'`);
  }
}

/** Hydrate the provider side of the tier cache. */
export async function setProviderTier(id: string, tier: ProviderTierSnapshotTier): Promise<void> {
  const response = await internal(
    'service-booking',
    '/api/v1/internal/booking/tier-snapshots/provider',
    {
      method: 'POST',
      body: { providerId: id, tier, lastSyncedAt: new Date().toISOString() },
      secretEnvKey: 'BOOKING_TIER_DISPATCH_API_KEY',
    },
  );
  expectInternalStatus(response, 200, 'provider tier snapshot upsert');
  const parsed = ProviderTierSnapshotResponseSchema.parse(response.body);
  if (parsed.tier !== tier) {
    throw new Error(`provider snapshot persisted tier '${parsed.tier}', expected '${tier}'`);
  }
}

export interface ConciergeRequestInput {
  readonly accessToken: string;
  readonly householdId: string;
  readonly seniorId: string;
  readonly providerId: string;
  readonly serviceKind?: BookingServiceKind;
  /** Threaded from `SearchProvidersResponse.searchId` when the visit came from a search. */
  readonly searchId?: string;
}

/**
 * `POST /api/v1/bookings/concierge-request` — the raw response.
 *
 * Returned unparsed on purpose: half of what TS-505c asserts is a *refusal*,
 * and a helper that parsed the success shape would throw on the interesting
 * case before the spec could look at it.
 */
export async function requestConciergeBooking(
  input: ConciergeRequestInput,
): Promise<GatewayResponse> {
  // A visit far enough out that no availability or accept-window rule is in
  // play. This spec is about the tier gate; a scheduling refusal would be a
  // pass-looking failure.
  const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  return gateway('/api/v1/bookings/concierge-request', {
    method: 'POST',
    accessToken: input.accessToken,
    idempotencyKey: idempotencyKey(),
    body: {
      householdId: input.householdId,
      seniorId: input.seniorId,
      providerId: input.providerId,
      serviceKind: input.serviceKind ?? 'companion_dining',
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      ...(input.searchId === undefined ? {} : { searchId: input.searchId }),
    },
  });
}

/** The same call, asserting it was accepted and returning the created booking. */
export async function createConciergeBooking(
  input: ConciergeRequestInput,
): Promise<BookingResponse> {
  const response = await requestConciergeBooking(input);
  if (response.status !== 201) {
    throw new Error(
      `concierge booking request returned ${String(response.status)}, expected 201: ${response.text.slice(0, 800)}`,
    );
  }
  return BookingResponseSchema.parse(response.body);
}

/**
 * Walk an accepted-and-attended visit: `pending → confirmed → in_progress →
 * completed` (TS-505d2).
 *
 * `booking-lifecycle.spec.ts` asserts each step of this walk in its own right.
 * Here it is a prerequisite — the money path starts from a visit that
 * happened — so the helper asserts the steps and throws, rather than leaving a
 * spec about journals to explain a 409 from the state machine.
 *
 * **Check-out is the money event.** It is what stamps `completedAt` and what
 * emits `booking.completed` in the same transaction (PDD §7.3), which is the
 * row the relay picks up.
 */
export async function completeBooking(
  accessToken: string,
  bookingId: string,
): Promise<BookingResponse> {
  await lifecycleStep(accessToken, `/api/v1/bookings/${bookingId}/accept`, {}, 200, 'accept');

  // The provider's GPS at the doorstep (TS-060-followup-4a). One fixed
  // location for both punches: an impossible-travel pair is a different
  // spec's subject (TS-308a), and the fleet runs with the detector off.
  const location = { latitude: 40.7128, longitude: -74.006 };

  await lifecycleStep(
    accessToken,
    `/api/v1/bookings/${bookingId}/check-ins`,
    { kind: 'check_in', ...location },
    201,
    'check-in',
  );
  const checkOut = await lifecycleStep(
    accessToken,
    `/api/v1/bookings/${bookingId}/check-ins`,
    { kind: 'check_out', ...location },
    201,
    'check-out',
  );

  const booking = BookingResponseSchema.parse((checkOut.body as { booking: unknown }).booking);
  if (booking.status !== 'completed') {
    throw new Error(`check-out left the visit ${booking.status}, expected completed`);
  }
  return booking;
}

async function lifecycleStep(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
  expected: number,
  label: string,
): Promise<GatewayResponse> {
  const response = await gateway(path, {
    method: 'POST',
    accessToken,
    idempotencyKey: idempotencyKey(),
    body,
  });
  if (response.status !== expected) {
    throw new Error(
      `booking ${label} returned ${String(response.status)}, expected ${String(expected)}: ${response.text.slice(0, 800)}`,
    );
  }
  return response;
}
