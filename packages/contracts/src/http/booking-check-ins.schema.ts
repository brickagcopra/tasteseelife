import { z } from 'zod';

import { BookingResponseSchema, BOOKING_SOFT_FK_MAX_LENGTH } from './booking.schema';
import { BOOKING_ID_MAX_LENGTH } from './booking-commission.schema';

/**
 * Booking check-in HTTP DTOs (TS-063; PRD §7.4 provider visit workflow,
 * PDD §8.2 column inventory, PDD §9.2 lifecycle sequence).
 *
 * The provider geo-checks-in at the start of a visit and geo-checks-out
 * at the end. Each event records a `booking_check_ins` row carrying the
 * latitude / longitude / occurred_at + transitions the booking
 * lifecycle:
 *
 *   - `check_in`  → moves the booking from `confirmed` → `in_progress`.
 *                    Emits `booking.in_progress` on the bus.
 *   - `check_out` → moves the booking from `in_progress` → `completed`.
 *                    Emits `booking.completed` on the bus.
 *
 * Drives PRD §6.4 family peace-of-mind ("provider has arrived"), the
 * accounting commission recognition pipeline (TS-083 consumes
 * `booking.completed`), and the payouts accrual (TS-091). The geo
 * coordinates themselves are surfaced in the provider portal +
 * admin tooling — they are NOT shown to families by default
 * (CLAUDE.md §12 family-observability boundaries — provider precise
 * location isn't a family concern).
 *
 * **Two rows per booking max.** `(bookingId, kind)` is UNIQUE: one
 * check-in row + one check-out row per booking. A retried POST with the
 * same `Idempotency-Key` replays the cached response; an unkeyed retry
 * surfaces the UNIQUE violation as a typed `already_recorded` failure.
 *
 * **Lifecycle gate.** Service-side enforced:
 *   - `check_in`  requires booking status = `confirmed`.
 *   - `check_out` requires booking status = `in_progress`.
 *   Other statuses surface as `invalid_lifecycle_state` (HTTP 409).
 *
 * **Geo bounds.** Latitude is `[-90, 90]`, longitude is `[-180, 180]`
 * (the planet's actual extent). Stored as `Decimal(8,6)` / `Decimal(9,6)`
 * — 6 decimal places ≈ 11 cm of precision, more than enough for "did
 * the provider arrive at the household address". CLAUDE.md §17.6 forbids
 * floats for money; coordinates aren't money, but Decimal keeps the
 * stored values deterministic (no float drift across reads) and the
 * server-side rounding policy explicit. The wire layer accepts JSON
 * numbers; the service rounds-half-up at the 6th decimal place before
 * persisting.
 *
 * **`locationAccuracyMeters`** — optional. Browser geolocation APIs
 * surface a horizontal accuracy estimate; recording it lets ops triage
 * "the provider checked in 5 km away because their phone fell back to
 * IP geolocation" vs. "the provider checked in at the right house, GPS
 * accuracy 8 m". Nullable because some devices don't surface accuracy.
 *
 * **`occurredAt` is server-stamped.** The client does NOT supply
 * `occurredAt` on the wire — the service stamps from a trusted clock
 * (CLAUDE.md §3.2 — server stamps actor + occurred-at). Same discipline
 * as visit notes' `recordedAt`.
 *
 * **`.strict()` everywhere** — unknown fields are a parse error so a
 * typo or a stray client field never silently round-trips
 * (CLAUDE.md §3.3).
 */

/**
 * Check-in kind discriminator. Mirrors the Prisma enum
 * `BookingCheckInKind` in `apps/service-booking/prisma/schema.prisma`.
 *
 *   - `check_in`  — provider arrived at the visit location.
 *   - `check_out` — provider departed at the end of the visit.
 */
export const BookingCheckInKindSchema = z.enum(['check_in', 'check_out']);
export type BookingCheckInKind = z.infer<typeof BookingCheckInKindSchema>;

/** Latitude bound: -90..90 (planetary). */
export const CHECK_IN_LATITUDE_MIN = -90;
export const CHECK_IN_LATITUDE_MAX = 90;
/** Longitude bound: -180..180 (planetary). */
export const CHECK_IN_LONGITUDE_MIN = -180;
export const CHECK_IN_LONGITUDE_MAX = 180;
/**
 * Persisted decimal-place precision for coordinates. 6 places ≈ 11 cm
 * resolution at typical latitudes. The service rounds the wire-side
 * number to this precision before persisting; values supplied at higher
 * precision lose the trailing digits silently (no error).
 */
export const CHECK_IN_COORDINATE_DECIMAL_PLACES = 6;
/**
 * Upper bound on the recorded accuracy estimate. The browser
 * Geolocation API surfaces accuracy in meters; 1e6 (~1000 km) is a
 * generous safety cap to reject obviously-bogus values without
 * constraining the legitimate range.
 */
export const CHECK_IN_ACCURACY_METERS_MAX = 1_000_000;

/**
 * Bound for the `id` we return — same shape as a booking id (CUID
 * family).
 */
export const CHECK_IN_ID_MAX_LENGTH = 64;

/**
 * `POST /api/v1/bookings/:bookingId/check-ins` request body.
 *
 * Geo coordinates are required. Phase 1 product position: the provider
 * must enable device location to check in / out. If they can't, ops
 * uses the admin override surface (TS-128) rather than a "location
 * unavailable" branch on the provider portal. Keeps the trust signal
 * meaningful — every check-in row carries verifiable geo data.
 *
 * `recordedByUserId` and `occurredAt` are NOT on the wire — the
 * service stamps both from the authenticated request context + a
 * trusted clock (CLAUDE.md §3.2).
 */
export const RecordBookingCheckInRequestSchema = z
  .object({
    kind: BookingCheckInKindSchema,
    latitude: z
      .number()
      .finite()
      .min(CHECK_IN_LATITUDE_MIN, `latitude must be >= ${CHECK_IN_LATITUDE_MIN}`)
      .max(CHECK_IN_LATITUDE_MAX, `latitude must be <= ${CHECK_IN_LATITUDE_MAX}`),
    longitude: z
      .number()
      .finite()
      .min(CHECK_IN_LONGITUDE_MIN, `longitude must be >= ${CHECK_IN_LONGITUDE_MIN}`)
      .max(CHECK_IN_LONGITUDE_MAX, `longitude must be <= ${CHECK_IN_LONGITUDE_MAX}`),
    locationAccuracyMeters: z
      .number()
      .finite()
      .nonnegative()
      .max(CHECK_IN_ACCURACY_METERS_MAX)
      .optional(),
  })
  .strict();
export type RecordBookingCheckInRequest = z.infer<typeof RecordBookingCheckInRequestSchema>;

/**
 * Single `booking_check_ins` row shape, surfaced to the client. Every
 * coordinate field is a JSON number for client convenience; the
 * server-side persistence is `Decimal(8,6)` / `Decimal(9,6)` for the
 * coords and `Decimal(10,2)` for the accuracy. The mapper converts the
 * stored Decimal to the wire number once at the response boundary.
 */
export const BookingCheckInResponseSchema = z
  .object({
    id: z.string().min(1).max(CHECK_IN_ID_MAX_LENGTH),
    bookingId: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    kind: BookingCheckInKindSchema,
    latitude: z.number().finite().min(CHECK_IN_LATITUDE_MIN).max(CHECK_IN_LATITUDE_MAX),
    longitude: z.number().finite().min(CHECK_IN_LONGITUDE_MIN).max(CHECK_IN_LONGITUDE_MAX),
    locationAccuracyMeters: z.number().finite().nonnegative().nullable(),
    occurredAt: z.string().datetime(),
    recordedByUserId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type BookingCheckInResponse = z.infer<typeof BookingCheckInResponseSchema>;

/**
 * `POST /api/v1/bookings/:bookingId/check-ins` 201 response.
 *
 * Returns both the new check-in row AND the updated booking. The
 * transition is server-driven (the same request that records the
 * check-in row flips the booking status); returning the new booking
 * shape saves a follow-up GET round-trip from the provider-portal /
 * family-portal UIs.
 */
export const RecordBookingCheckInResponseSchema = z
  .object({
    checkIn: BookingCheckInResponseSchema,
    booking: BookingResponseSchema,
  })
  .strict();
export type RecordBookingCheckInResponse = z.infer<typeof RecordBookingCheckInResponseSchema>;

/**
 * `GET /api/v1/bookings/:bookingId/check-ins` 200 response.
 *
 * Returns every check-in row for the booking, ordered chronologically
 * (oldest first — natural for "the visit started at … and ended at …"
 * timeline rendering). At most two rows in Phase 1 (one `check_in` +
 * one `check_out`); a future "provider stepped out and re-entered"
 * surface would add more rows additively without a contract change.
 */
export const BookingCheckInsListResponseSchema = z
  .object({
    items: z.array(BookingCheckInResponseSchema),
  })
  .strict();
export type BookingCheckInsListResponse = z.infer<typeof BookingCheckInsListResponseSchema>;
