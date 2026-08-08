import type { BookingCheckInResponse } from '@taste-and-see/contracts';

import type { CheckInRecord } from '../services/check-ins.service';

/**
 * Convert a Prisma `BookingCheckIn` row to the public
 * `BookingCheckInResponse` DTO (CLAUDE.md §3.3 — DTO mappers, never
 * return raw Prisma objects).
 *
 * The wire shape is JSON numbers for latitude / longitude /
 * locationAccuracyMeters. The persistence layer stores `Decimal(8,6)`
 * / `Decimal(9,6)` / `Decimal(10,2)` — they cross the mapper boundary
 * as Prisma's `Decimal` (or the stringly-typed fake's `{ toString() }`
 * shape). `parseFloat` is the canonical cross-back: the values were
 * server-rounded at insert time so the round-trip is lossless within
 * IEEE-754's representable range (lat/long don't go beyond ±180 with
 * 6 decimals — every value fits in a double).
 *
 * Timestamps cross the wire as ISO 8601 strings.
 */
export function toBookingCheckInResponse(row: CheckInRecord): BookingCheckInResponse {
  return {
    id: row.id,
    bookingId: row.bookingId,
    kind: row.kind,
    latitude: Number.parseFloat(row.latitude.toString()),
    longitude: Number.parseFloat(row.longitude.toString()),
    locationAccuracyMeters:
      row.locationAccuracyMeters !== null
        ? Number.parseFloat(row.locationAccuracyMeters.toString())
        : null,
    occurredAt: row.occurredAt.toISOString(),
    recordedByUserId: row.recordedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
