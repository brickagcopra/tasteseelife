import type { VisitNotesResponse } from '@taste-and-see/contracts';

import type { VisitNoteRecord } from '../services/visit-notes.service';

/**
 * Convert a Prisma `BookingVisitNote` row to the public
 * `VisitNotesResponse` DTO (CLAUDE.md §3.3 — DTO mappers, never
 * return raw Prisma objects).
 *
 * The conversion is mostly an identity map; the persistence layer
 * already uses the same enum string values the contract carries.
 * Timestamps cross the wire as ISO 8601 strings; `photoKeys` is
 * defensively copied so the response is not a live reference to the
 * Prisma row's mutable internal array (Prisma's runtime returns a
 * fresh array per read but defensive copying makes the mapper safe
 * to call against either runtime shape).
 */
export function toVisitNotesResponse(row: VisitNoteRecord): VisitNotesResponse {
  return {
    bookingId: row.bookingId,
    mood: row.mood,
    appetite: row.appetite,
    hydration: row.hydration,
    socialEngagement: row.socialEngagement,
    freeform: row.freeform,
    photoKeys: [...row.photoKeys],
    recordedByUserId: row.recordedByUserId,
    recordedAt: row.recordedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
