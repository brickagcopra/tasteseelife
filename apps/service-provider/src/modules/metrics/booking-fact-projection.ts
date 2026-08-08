import {
  BOOKING_CANCELED,
  BOOKING_COMPLETED,
  BOOKING_CONFIRMED,
  BOOKING_CREATED,
  BOOKING_DECLINED,
} from '@taste-and-see/contracts';
import type {
  BookingCanceled,
  BookingCompleted,
  BookingConfirmed,
  BookingCreated,
  BookingDeclined,
} from '@taste-and-see/contracts';

/**
 * The pure half of the `provider_booking_facts` projection (TS-305d).
 *
 * Every booking lifecycle event this service consumes is turned into a
 * *contribution*: the set of columns that event, and only that event,
 * is entitled to fill. Persistence then applies contributions with
 * `COALESCE`, so a column is written once and later events never
 * overwrite it.
 *
 * **Why the decision lives here and not in the SQL.** Docker is not
 * available on this platform's dev machines (the standing wedge behind
 * every `Blocked on Docker` follow-up), so a projection whose rules
 * live inside an `INSERT … ON CONFLICT` is a projection whose rules are
 * untested until staging. Splitting it means the part that can be wrong
 * in an interesting way — which event contributes what, and what a
 * decline *means* — is covered by ordinary unit tests, and the SQL is
 * reduced to a mechanical application of the result.
 *
 * **Contributions are order-independent by construction.** A handler
 * never reads before it writes and never asks what else has happened,
 * so events may arrive in any order or be replayed any number of times
 * and the row converges to the same value. That is what makes the
 * consumer dedup table a cache rather than a correctness dependency
 * (CLAUDE.md §5.3).
 */

/**
 * Columns a single event contributes. Every field is optional: an event
 * fills its own lifecycle position and says nothing about the others.
 * `bookingId` and `providerId` are the exception — every lifecycle
 * event carries both (`BookingIdentifiersSchema`), which is what lets
 * any of them create the row.
 */
export interface BookingFactContribution {
  readonly bookingId: string;
  readonly providerId: string;
  readonly serviceKind?: string;
  readonly offeredAt?: Date;
  readonly respondedAt?: Date;
  readonly responseKind?: 'accepted' | 'declined';
  readonly declineKind?: string;
  readonly outcome?: 'completed' | 'canceled' | 'declined';
  readonly outcomeAt?: Date;
  readonly cancellationReason?: string;
  readonly canceledPreviousStatus?: string;
}

/** Event names this projection consumes. */
export const PROJECTED_BOOKING_EVENTS = [
  BOOKING_CREATED,
  BOOKING_CONFIRMED,
  BOOKING_DECLINED,
  BOOKING_COMPLETED,
  BOOKING_CANCELED,
] as const;

/**
 * `booking.created` — the offer instant.
 *
 * `occurredAt` is used rather than any schedule field: the metric is
 * how fast a provider *answers*, so the clock starts when the request
 * reached them, not when the visit is due. A booking requested for next
 * month and accepted in ten minutes is a ten-minute response.
 */
export function projectBookingCreated(payload: BookingCreated): BookingFactContribution {
  return {
    bookingId: payload.bookingId,
    providerId: payload.providerId,
    serviceKind: payload.serviceKind,
    offeredAt: new Date(payload.occurredAt),
  };
}

/**
 * `booking.confirmed` — the provider accepted.
 *
 * Contributes a response but NOT an outcome: an accepted booking has
 * not yet succeeded or failed, and counting it as either at this point
 * is how a provider with a full diary next month acquires a completion
 * rate they have not earned.
 */
export function projectBookingConfirmed(payload: BookingConfirmed): BookingFactContribution {
  return {
    bookingId: payload.bookingId,
    providerId: payload.providerId,
    serviceKind: payload.serviceKind,
    respondedAt: new Date(payload.confirmedAt),
    responseKind: 'accepted',
  };
}

/**
 * `booking.declined` — an offer refused, lapsed, or withdrawn by ops.
 *
 * All three arrive on one event and are distinguished only by
 * `declineKind`, which is why the kind is carried onto the fact row
 * instead of being flattened here: `window_expired` is a provider who
 * never answered and `admin_declined` is not the provider's act at all,
 * and a reader that cannot tell them apart from `provider_declined`
 * would score ops decisions against the provider.
 *
 * A decline is a terminal outcome *and* a response, so it contributes
 * both — but note the response instant is the decline instant even for
 * `window_expired`, where "responded" means the offer stopped being
 * open rather than that anybody replied. Response-TIME statistics
 * therefore exclude expiries (see `metrics-computation.ts`); including
 * them would report the accept window's length as the provider's speed.
 */
export function projectBookingDeclined(payload: BookingDeclined): BookingFactContribution {
  return {
    bookingId: payload.bookingId,
    providerId: payload.providerId,
    serviceKind: payload.serviceKind,
    respondedAt: new Date(payload.declinedAt),
    responseKind: 'declined',
    declineKind: payload.declineKind,
    outcome: 'declined',
    outcomeAt: new Date(payload.declinedAt),
  };
}

/**
 * `booking.completed` — the visit happened.
 *
 * Contributes an outcome only. It does NOT backfill a response, even
 * though a completed booking was obviously accepted: the acceptance
 * *instant* is not on this event, and inventing one (the completion
 * time, say) would put a fabricated number into a response-time median.
 * A booking whose `confirmed` event was lost stays out of the response
 * statistics and counts normally in the completion statistics, which is
 * the honest split.
 *
 * The money fields on this event are deliberately not projected. This
 * is a reliability read model; provider earnings are the payouts
 * context's business and copying them here would put a second,
 * divergent source of the same figure on the platform.
 */
export function projectBookingCompleted(payload: BookingCompleted): BookingFactContribution {
  return {
    bookingId: payload.bookingId,
    providerId: payload.providerId,
    serviceKind: payload.serviceKind,
    outcome: 'completed',
    outcomeAt: new Date(payload.completedAt),
  };
}

/**
 * `booking.canceled` — the visit will not happen.
 *
 * `previousStatus` is the load-bearing field. A booking cancelled out
 * of `pending` was never accepted and belongs to the offer funnel; one
 * cancelled out of `confirmed` or `in_progress` is a commitment that
 * did not hold. The computation uses that distinction; without it a
 * family who changed their mind before the provider even saw the
 * request would count against the provider's reliability.
 *
 * `canceledByUserId` is deliberately NOT projected. service-provider
 * cannot resolve whether that id is the provider, the family payer or
 * an admin without a cross-service read CLAUDE.md §2.3 forbids, so
 * storing it would create a column that looks like attribution and is
 * not. `cancellationReason` is kept instead — categorical, already
 * decided by the producer, and `no_show` in particular is a materially
 * different fact from `family_schedule_change`.
 */
export function projectBookingCanceled(payload: BookingCanceled): BookingFactContribution {
  return {
    bookingId: payload.bookingId,
    providerId: payload.providerId,
    serviceKind: payload.serviceKind,
    outcome: 'canceled',
    outcomeAt: new Date(payload.canceledAt),
    cancellationReason: payload.cancellationReason,
    canceledPreviousStatus: payload.previousStatus,
  };
}
