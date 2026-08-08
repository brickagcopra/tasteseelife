import type { BookingDisputeResponse } from '@taste-and-see/contracts';

import type { DisputeRecord } from '../services/disputes.service';

/**
 * Convert a Prisma `BookingDispute` row to the public
 * `BookingDisputeResponse` DTO (CLAUDE.md §3.3 — DTO mappers, never
 * return raw Prisma objects to the client).
 *
 * The wire shape is opinionated:
 *
 *   - Timestamps cross as ISO 8601 strings.
 *   - `resolutionNotes` / `resolvedByUserId` / `resolvedAt` are
 *     nullable. The database CHECK constraint
 *     (`booking_disputes_resolved_invariant_chk`) guarantees these
 *     three columns transition together — null on open / under_review
 *     rows, non-null on terminal rows.
 *   - `reasonDetail` echoes back as `null` when the opener didn't
 *     supply one (the column accepts NULL).
 */
export function toBookingDisputeResponse(row: DisputeRecord): BookingDisputeResponse {
  return {
    id: row.id,
    bookingId: row.bookingId,
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
