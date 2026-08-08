import type {
  AdminBookingCheckInSummary,
  AdminBookingDetail,
  AdminBookingDisputeSummary,
  AdminBookingRecurrenceSummary,
  AdminBookingSummary,
  AdminBookingVisitNoteSummary,
  BookingCancellationReason,
} from '@taste-and-see/contracts';

import { decimalStringToMinor, ratioStringToBps } from '../../../common/money';
import type {
  AdminBookingCheckInRow,
  AdminBookingDetailRow,
  AdminBookingDisputeRow,
  AdminBookingRecurrenceRow,
  AdminBookingRow,
  AdminBookingVisitNoteRow,
} from '../services/admin-bookings.service';

/**
 * Project the service-layer row shapes onto the contract DTO shapes
 * (TS-128 Slice 1).
 *
 * Mirrors `admin-subscription.mapper.ts` (TS-127) / `admin-user.mapper.ts`
 * (TS-126) — lives at the controller boundary so the controllers never
 * return raw Prisma rows (CLAUDE.md §3.3 — "All outbound responses pass
 * through DTO mappers — never return raw Prisma objects to the client.").
 *
 * Date conversion: ISO 8601 strings on the wire. Money conversion:
 * `Decimal` strings to integer minor units via the shared
 * `decimalStringToMinor` / `ratioStringToBps` helpers in
 * `apps/service-booking/src/common/money.ts` (TS-063-followup-8 —
 * previously duplicated locally per surface).
 */
export function summaryRowToDto(row: AdminBookingRow): AdminBookingSummary {
  return {
    id: row.id,
    householdId: row.householdId,
    seniorId: row.seniorId,
    providerId: row.providerId,
    serviceKind: row.serviceKind,
    status: row.status,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd.toISOString(),
    currency: row.currency,
    basePriceMinor: decimalStringToMinor(row.basePrice.toString()),
    commissionRateBps: ratioStringToBps(row.commissionRate.toString()),
    commissionAmountMinor: decimalStringToMinor(row.commissionAmount.toString()),
    finalPriceMinor: decimalStringToMinor(row.finalPrice.toString()),
    completedAt: row.completedAt !== null ? row.completedAt.toISOString() : null,
    canceledAt: row.canceledAt !== null ? row.canceledAt.toISOString() : null,
    cancellationReason: narrowCancellationReason(row.cancellationReason),
    isRecurring: row.seriesId !== null,
    // TS-304-followup-1 — narrowed to a boolean here for the same reason as
    // `toBookingResponse`: one disclosure rule that holds on every surface,
    // rather than a per-surface one nobody re-checks. The incident id lives on
    // GET /api/v1/admin/booking-holds, gated `trust_safety:read`.
    onHold: row.heldByIncidentId !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function detailRowToDto(row: AdminBookingDetailRow): AdminBookingDetail {
  return {
    id: row.id,
    householdId: row.householdId,
    seniorId: row.seniorId,
    providerId: row.providerId,
    serviceKind: row.serviceKind,
    status: row.status,
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    visitNote: row.visitNote !== null ? visitNoteRowToDto(row.visitNote) : null,
    checkIns: row.checkIns.map(checkInRowToDto),
    disputes: row.disputes.map(disputeRowToDto),
    recurrence: row.recurrence !== null ? recurrenceRowToDto(row.recurrence) : null,
  };
}

function visitNoteRowToDto(row: AdminBookingVisitNoteRow): AdminBookingVisitNoteSummary {
  return {
    id: row.id,
    mood: row.mood,
    appetite: row.appetite,
    hydration: row.hydration,
    socialEngagement: row.socialEngagement,
    freeform: row.freeform,
    photoKeys: [...row.photoKeys],
    recordedByUserId: row.recordedByUserId,
    recordedAt: row.recordedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function checkInRowToDto(row: AdminBookingCheckInRow): AdminBookingCheckInSummary {
  return {
    id: row.id,
    kind: row.kind,
    latitude: decimalStringToNumber(row.latitude.toString()),
    longitude: decimalStringToNumber(row.longitude.toString()),
    locationAccuracyMeters:
      row.locationAccuracyMeters !== null
        ? decimalStringToNumber(row.locationAccuracyMeters.toString())
        : null,
    occurredAt: row.occurredAt.toISOString(),
    recordedByUserId: row.recordedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function disputeRowToDto(row: AdminBookingDisputeRow): AdminBookingDisputeSummary {
  return {
    id: row.id,
    openedByUserId: row.openedByUserId,
    openedByRole: row.openedByRole,
    reason: row.reason,
    reasonDetail: row.reasonDetail,
    status: row.status,
    resolutionNotes: row.resolutionNotes,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt !== null ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function recurrenceRowToDto(row: AdminBookingRecurrenceRow): AdminBookingRecurrenceSummary {
  return {
    seriesId: row.seriesId,
    rrule: row.rrule,
    endDate: row.endDate !== null ? row.endDate.toISOString() : null,
    count: row.count,
    occurrenceCount: row.occurrenceCount,
    seriesIndex: row.seriesIndex,
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

/**
 * `Decimal(8,6)` / `Decimal(9,6)` coords parsed to JSON number for the
 * wire. The admin tooling renders raw coordinates for ops triage; the
 * conversion goes through string parsing rather than `Number()` so a
 * future Decimal-shape change doesn't silently drop precision.
 */
function decimalStringToNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`admin-booking.mapper: invalid decimal '${value}'`);
  }
  return parsed;
}
