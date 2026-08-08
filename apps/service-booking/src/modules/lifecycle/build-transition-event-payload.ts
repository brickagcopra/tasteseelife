/**
 * Shared builder for the outbox payloads emitted on a booking
 * lifecycle transition (`booking.confirmed` / `booking.in_progress`
 * / `booking.completed` / `booking.canceled`).
 *
 * Single source of truth for two callers — the status PATCH flow in
 * `BookingsService.transitionStatus` (any of the four events) and
 * the geo check-in/check-out flow in `CheckInsService.record` (only
 * `booking.in_progress` and `booking.completed`). Each branch maps
 * to the matching event's Zod schema in
 * `packages/contracts/src/events/booking.ts`; the outbox SDK
 * validates the runtime shape at append time so a drift between
 * this builder and the schema surfaces as an `OutboxValidationFailedError`.
 *
 * **Why a single helper rather than per-event builders.** The four
 * events share the same envelope (`eventId`, `occurredAt`) + the
 * same identifier block (`bookingId`, `householdId`, `seniorId`,
 * `providerId`, `serviceKind`). A switch over `eventName` keeps the
 * envelope/identifier construction in one place; the per-event
 * fields branch off the switch. Per-event builders would either
 * duplicate the envelope/identifier code 4×, or share it via a
 * second layer of indirection — both worse than the single
 * function.
 *
 * **Why the args interface uses optional fields rather than a
 * discriminated union.** The `BOOKING_CANCELED` event is the only
 * branch that requires `previousStatus` / `actorUserId` /
 * `cancellationReason`. A discriminated union would express this
 * precisely at the type level, but the call sites would need to
 * branch the construction of the args object on `eventName`,
 * doubling the call-site boilerplate. The current shape — optional
 * fields with a runtime defence inside the `BOOKING_CANCELED`
 * branch — preserves the call-site ergonomics. The check-ins
 * caller never invokes `BOOKING_CANCELED` (its `transitionEventName`
 * throws on `canceled`), so the runtime defence is genuinely
 * defensive, not a load-bearing path.
 *
 * **Round-once-at-presentation invariant (CLAUDE.md §6).** The
 * `BOOKING_COMPLETED` branch is the only one that touches money;
 * it uses the shared `decimalStringToMinor` / `ratioStringToBps`
 * from `apps/service-booking/src/common/money.ts` (TS-063-followup-8)
 * to convert the Decimal columns into integer minor units / basis
 * points exactly once, here at the event-payload boundary.
 */
import {
  BOOKING_CANCELED,
  BOOKING_COMPLETED,
  BOOKING_CONFIRMED,
  BOOKING_IN_PROGRESS,
  type BookingCancellationReason,
  type EventName,
} from '@taste-and-see/contracts';

import { decimalStringToMinor, ratioStringToBps } from '../../common/money';
import type { BookingRecord } from '../bookings/services/bookings.service';
import type { BookingStatus } from './booking-status';

export interface BuildTransitionEventArgs {
  readonly eventName: EventName;
  readonly row: BookingRecord;
  readonly now: Date;
  /**
   * Required when `eventName === BOOKING_CANCELED` so the cancel
   * event payload can record the lifecycle state the booking left
   * behind. Optional for the other three events because they don't
   * include `previousStatus` in their schema.
   */
  readonly previousStatus?: BookingStatus;
  /**
   * Required when `eventName === BOOKING_CANCELED` (becomes the
   * `canceledByUserId` on the payload). Optional for the other
   * three events because they don't carry a per-event actor field
   * — the audit log records who triggered the transition.
   */
  readonly actorUserId?: string;
  /**
   * Optional even for `BOOKING_CANCELED` — defaults to `'other'`
   * when omitted. The `BookingCanceled` schema accepts the full
   * `BookingCancellationReason` enum.
   */
  readonly cancellationReason?: BookingCancellationReason;
}

/**
 * Build the per-event payload from the just-updated booking row.
 *
 * Pure function — no side effects, no I/O, no clock reads. The
 * `now` arg is supplied by the caller so the event's `occurredAt`
 * matches the row's `updatedAt` (single-clock-read invariant).
 *
 * Throws when `BOOKING_CANCELED` is requested without
 * `previousStatus` / `actorUserId`, or when an unknown `eventName`
 * is passed. Both cases are programmer errors (compile-time
 * `EventName` typing should prevent the second, the documented
 * cancel-args contract prevents the first) so a thrown `Error` is
 * the right shape — the caller's outer try/catch maps it to an
 * `OutboxValidationFailedError`-equivalent surfacing.
 */
export function buildTransitionEventPayload(args: BuildTransitionEventArgs): unknown {
  const { row, now, eventName } = args;
  const identifiers = {
    bookingId: row.id,
    householdId: row.householdId,
    seniorId: row.seniorId,
    providerId: row.providerId,
    serviceKind: row.serviceKind,
  };
  const envelope = {
    eventId: `${row.id}.${row.status}.${now.getTime()}`,
    occurredAt: now.toISOString(),
  };

  switch (eventName) {
    case BOOKING_CONFIRMED:
      return {
        ...envelope,
        ...identifiers,
        scheduledStart: row.scheduledStart.toISOString(),
        scheduledEnd: row.scheduledEnd.toISOString(),
        confirmedAt: now.toISOString(),
      };
    case BOOKING_IN_PROGRESS:
      return {
        ...envelope,
        ...identifiers,
        startedAt: now.toISOString(),
      };
    case BOOKING_COMPLETED: {
      const finalPriceMinor = decimalStringToMinor(row.finalPrice.toString());
      const commissionAmountMinor = decimalStringToMinor(row.commissionAmount.toString());
      const commissionRateBps = ratioStringToBps(row.commissionRate.toString());
      // Phase-1 gross == finalPrice (no coupons / refunds yet). The
      // marketplace portion is `commissionAmountMinor`, the provider
      // portion is `gross - marketplace`. This satisfies the
      // BookingCompleted invariant: gross == provider + marketplace.
      const grossAmountMinor = finalPriceMinor;
      const marketplaceAmountMinor = commissionAmountMinor;
      const providerAmountMinor = grossAmountMinor - marketplaceAmountMinor;
      return {
        ...envelope,
        ...identifiers,
        completedAt: now.toISOString(),
        currency: row.currency,
        grossAmountMinor,
        providerAmountMinor,
        marketplaceAmountMinor,
        commissionRateBps,
      };
    }
    case BOOKING_CANCELED: {
      if (args.previousStatus === undefined) {
        throw new Error('buildTransitionEventPayload: BOOKING_CANCELED requires previousStatus');
      }
      if (args.actorUserId === undefined) {
        throw new Error('buildTransitionEventPayload: BOOKING_CANCELED requires actorUserId');
      }
      const prev =
        args.previousStatus === 'pending' ||
        args.previousStatus === 'confirmed' ||
        args.previousStatus === 'in_progress'
          ? args.previousStatus
          : 'confirmed';
      return {
        ...envelope,
        ...identifiers,
        canceledAt: now.toISOString(),
        previousStatus: prev,
        cancellationReason: args.cancellationReason ?? 'other',
        canceledByUserId: args.actorUserId,
      };
    }
    default:
      throw new Error(`buildTransitionEventPayload: unexpected event ${eventName}`);
  }
}
