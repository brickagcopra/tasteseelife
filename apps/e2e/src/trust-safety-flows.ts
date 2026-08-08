import {
  BookingHoldListResponseSchema,
  type BookingHoldListResponse,
  type ReportConcernResponse,
  type TrustSafetyIncidentCategory,
} from '@taste-and-see/contracts';

import { idempotencyKey } from './actors';
import { gateway } from './gateway-client';

/**
 * Trust & safety flows for the suite (TS-505d2-followup-3b).
 *
 * The two halves of the booking-hold path, which are in different services
 * and have never been connected by a running process: a family files a
 * concern (`service-trust-safety`), and `service-booking`'s outbox consumer
 * turns the resulting `trust_safety.booking_hold.requested` into a
 * `booking_subject_holds` row plus a `held_by_incident_id` stamp.
 */

/**
 * File a concern as the acting family member.
 *
 * No household id anywhere in the call — the gateway resolves it from the
 * caller's membership (TS-505d2-followup-5), which is the whole reason this
 * spec can exist without the concierge on-behalf route.
 */
export async function fileConcern(args: {
  readonly accessToken: string;
  readonly category: TrustSafetyIncidentCategory;
  readonly description: string;
}): Promise<ReportConcernResponse['receipt']> {
  const response = await gateway('/api/v1/trust-safety/incidents', {
    method: 'POST',
    accessToken: args.accessToken,
    idempotencyKey: idempotencyKey(),
    body: { category: args.category, description: args.description },
  });
  if (response.status !== 201) {
    throw new Error(
      `filing a concern returned ${String(response.status)}, expected 201: ${response.text.slice(0, 600)}`,
    );
  }
  return (response.body as ReportConcernResponse).receipt;
}

/** `GET /api/v1/admin/booking-holds` — the ops read surface (TS-304-followup-3). */
export async function listBookingHolds(
  accessToken: string,
  query: Readonly<Record<string, string>> = {},
): Promise<BookingHoldListResponse> {
  const search = new URLSearchParams(query);
  const response = await gateway(`/api/v1/admin/booking-holds?${search.toString()}`, {
    accessToken,
  });
  if (response.status !== 200) {
    throw new Error(
      `admin/booking-holds returned ${String(response.status)}: ${response.text.slice(0, 600)}`,
    );
  }
  return BookingHoldListResponseSchema.parse(response.body);
}

/**
 * Wait until an incident's hold rows have landed in service-booking.
 *
 * **The wait is on a COUNT, not on "any hold"**, for the same reason the
 * audit trail's is: an incident naming several subjects produces several
 * rows, and a spec that read the first would assert against a real
 * intermediate state.
 *
 * The failure message names all three processes because the hop is three
 * processes long and the symptom — no rows — is identical whichever one
 * broke.
 */
export async function waitForBookingHolds(
  accessToken: string,
  incidentId: string,
  expected: number,
  options: { readonly timeoutMs?: number } = {},
): Promise<BookingHoldListResponse['holds']> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const page = await listBookingHolds(accessToken, { incidentId, status: 'all' });
    if (page.holds.length >= expected) return page.holds;

    if (Date.now() >= deadline) {
      throw new Error(
        `Expected ${String(expected)} booking hold(s) for incident ${incidentId} within ` +
          `${String(timeoutMs)}ms; saw ${String(page.holds.length)}. Either service-trust-safety ` +
          `did not emit trust_safety.booking_hold.requested, the relay did not publish it, or ` +
          `service-booking did not consume it. Check test-results/fleet/` +
          `{service-trust-safety,worker-outbox-relay,service-booking}.log.`,
      );
    }
    await delay(500);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
