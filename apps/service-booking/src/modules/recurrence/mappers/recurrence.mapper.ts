import type { BookingRecurrenceRecord } from '@taste-and-see/contracts';

import type { PersistedBookingRecurrence } from '../recurrence.service';

/**
 * Convert a Prisma `BookingRecurrence` row to the public
 * `BookingRecurrenceRecord` DTO (CLAUDE.md §3.3 — DTO mappers, never
 * return raw Prisma objects).
 *
 * `endDate` (resolved UNTIL) crosses the wire as an ISO 8601 string;
 * `count` crosses as the integer it is. Exactly one of the two is
 * non-null per row.
 */
export function toBookingRecurrenceRecord(
  row: PersistedBookingRecurrence,
): BookingRecurrenceRecord {
  return {
    seriesId: row.seriesId,
    rrule: row.rrule,
    endDate: row.endDate !== null ? row.endDate.toISOString() : null,
    count: row.count,
    occurrenceCount: row.occurrenceCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
