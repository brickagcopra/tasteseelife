import type {
  BookingCancellationReason,
  BookingDeclineKind,
  BookingDeclineReason,
  BookingResponse,
  BookingStatus,
} from '@taste-and-see/contracts';

import { decimalStringToMinor, ratioStringToBps } from '../../../common/money';
import type { BookingRecord } from '../services/bookings.service';

/**
 * Convert a Prisma booking row to the public `BookingResponse` DTO
 * (CLAUDE.md §3.3 — DTO mappers, never return raw Prisma objects).
 *
 * Money fields cross the wire as **integer USD minor units** (cents)
 * — CLAUDE.md §17.6 / §6. The persistence layer stores `Decimal(12,2)`
 * which is converted here exactly once on the way out (and exactly
 * once on the way in, at the service layer).
 *
 * Timestamps cross as ISO 8601 strings (`z.string().datetime()`).
 *
 * `cancellationReason` is a free-form `String?` at the database
 * layer; the contract narrows it to the
 * `BookingCancellationReason` union. The mapper performs a defensive
 * narrowing — an unrecognised value (which shouldn't exist because
 * the service writes through the typed enum, but defence is cheap)
 * surfaces as `null` rather than poisoning the response.
 */
export function toBookingResponse(row: BookingRecord): BookingResponse {
  return {
    id: row.id,
    householdId: row.householdId,
    seniorId: row.seniorId,
    providerId: row.providerId,
    serviceKind: row.serviceKind,
    status: row.status as BookingStatus,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd.toISOString(),
    currency: row.currency,
    basePriceMinor: decimalStringToMinor(row.basePrice.toString()),
    commissionRateBps: ratioStringToBps(row.commissionRate.toString()),
    commissionAmountMinor: decimalStringToMinor(row.commissionAmount.toString()),
    finalPriceMinor: decimalStringToMinor(row.finalPrice.toString()),
    bookingNotes: row.bookingNotes,
    completedAt: row.completedAt !== null ? row.completedAt.toISOString() : null,
    canceledAt: row.canceledAt !== null ? row.canceledAt.toISOString() : null,
    cancellationReason: narrowCancellationReason(row.cancellationReason),
    cancellationReasonText: row.cancellationReasonText,
    acceptWindowExpiresAt:
      row.acceptWindowExpiresAt !== null ? row.acceptWindowExpiresAt.toISOString() : null,
    declinedAt: row.declinedAt !== null ? row.declinedAt.toISOString() : null,
    declineKind: narrowDeclineKind(row.declineKind),
    declineReason: narrowDeclineReason(row.declineReason),
    declineReasonText: row.declineReasonText,
    // TS-304-followup-1 — the hold column NARROWS to a boolean here, and this
    // line is the disclosure boundary. `heldByIncidentId` names a trust &
    // safety incident; the family portal receives this DTO. Mapping the id
    // through, even "just for admin", would put it in front of the household.
    // The richer ops view lives behind `trust_safety:read` at
    // `GET /api/v1/admin/booking-holds` (TS-304-followup-3).
    onHold: row.heldByIncidentId !== null,
    declinedByUserId: row.declinedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const KNOWN_CANCELLATION_REASONS: ReadonlySet<BookingCancellationReason> = new Set([
  'family_request',
  'provider_unavailable',
  'no_show',
  'welfare_concern',
  'admin_action',
  'other',
]);

function narrowCancellationReason(value: string | null): BookingCancellationReason | null {
  if (value === null) return null;
  return KNOWN_CANCELLATION_REASONS.has(value as BookingCancellationReason)
    ? (value as BookingCancellationReason)
    : null;
}

const KNOWN_DECLINE_KINDS: ReadonlySet<BookingDeclineKind> = new Set([
  'provider_declined',
  'window_expired',
  'admin_declined',
]);

function narrowDeclineKind(value: string | null): BookingDeclineKind | null {
  if (value === null) return null;
  return KNOWN_DECLINE_KINDS.has(value as BookingDeclineKind)
    ? (value as BookingDeclineKind)
    : null;
}

const KNOWN_DECLINE_REASONS: ReadonlySet<BookingDeclineReason> = new Set([
  'schedule_conflict',
  'outside_service_area',
  'dietary_mismatch',
  'safety_concern',
  'other',
]);

function narrowDeclineReason(value: string | null): BookingDeclineReason | null {
  if (value === null) return null;
  return KNOWN_DECLINE_REASONS.has(value as BookingDeclineReason)
    ? (value as BookingDeclineReason)
    : null;
}
