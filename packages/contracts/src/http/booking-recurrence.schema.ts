import { z } from 'zod';

import {
  BOOKING_CURRENCY_CODE_LENGTH,
  BOOKING_MONEY_AMOUNT_MAX_MINOR,
  BOOKING_MONEY_AMOUNT_MIN_MINOR,
  BOOKING_NOTES_MAX_LENGTH,
  BOOKING_SOFT_FK_MAX_LENGTH,
  BookingResponseSchema,
} from './booking.schema';
import { BookingServiceKindSchema } from '../events/booking';

/**
 * Booking recurrence contracts (TS-061; PRD §6.3).
 *
 * One write surface, `POST /api/v1/bookings/recurring`. The caller
 * supplies the same per-booking shape as `POST /api/v1/bookings`
 * (`CreateBookingRequest`) plus an RFC 5545 RRULE that pins the
 * recurrence pattern + a termination clause (UNTIL or COUNT — the
 * RRULE string carries one of them; the server caps the materialised
 * series at `RECURRENCE_MAX_OCCURRENCES` regardless to keep the write
 * transaction bounded).
 *
 * **Phase 1 RRULE subset (PRD §6.3 — weekly / biweekly / monthly).**
 * The pure-TS expander in `apps/service-booking/src/modules/recurrence`
 * supports the subset that covers the three product requirements:
 *
 *   - `FREQ=WEEKLY;INTERVAL=1`  — every week
 *   - `FREQ=WEEKLY;INTERVAL=2`  — biweekly
 *   - `FREQ=MONTHLY;INTERVAL=1` — every month on the same day-of-month
 *   - termination: `COUNT=N` (1..RECURRENCE_MAX_OCCURRENCES) OR
 *     `UNTIL=YYYYMMDDTHHMMSSZ` (UTC basic-format)
 *
 * Unsupported clauses (`BYDAY`, `BYMONTHDAY`, `WKST`, `BYSETPOS`, etc.)
 * surface as a typed `unsupported_rrule_clause` failure at the service
 * boundary so future RFC 5545 coverage can land additively (TS-061-followup-1).
 *
 * **Series identity.** Every materialised child booking carries the same
 * `seriesId` (CUID-style id) so the family-portal and ops queries can
 * group occurrences as "the Tuesday companion-dinner series" without a
 * back-join to `booking_recurrence`. The recurrence row itself stores
 * the canonical RRULE + termination clause so a future "edit the
 * series" surface (TS-061-followup) has a single source of truth.
 *
 * **Atomic explode.** The service inserts every child row plus the
 * recurrence row in a single Prisma `$transaction` so partial series
 * never reach the database; the outbox-event-per-child emission
 * happens in the same transaction so consumers see the whole series
 * exactly once.
 *
 * **Hard cap.** `RECURRENCE_MAX_OCCURRENCES` (52) bounds the
 * materialised series at one year of weekly visits. Caps the write
 * transaction's runtime + the worst-case outbox volume per request.
 * Future tasks can lift the cap once a streaming-explode pattern
 * exists.
 *
 * **Money discipline.** Per-occurrence money fields cross the wire as
 * integer minor units, same as `CreateBookingRequest` (CLAUDE.md §17.6).
 */

/** Hard upper bound on materialised occurrences per call. */
export const RECURRENCE_MAX_OCCURRENCES = 52;
/** Hard upper bound on the RRULE string length (RFC 5545 leaves no fixed cap; bound for input-validation discipline). */
export const RRULE_MAX_LENGTH = 500;
/** Bound for the `seriesId` we return — same shape as a booking id. */
export const SERIES_ID_MAX_LENGTH = 64;

/**
 * Recurrence pattern shape carried on the request. Stays a small
 * dedicated subschema (rather than collapsing into the parent shape)
 * so future fields (timezone overrides, byday clauses, exception
 * dates) can land additively.
 */
export const BookingRecurrencePatternSchema = z
  .object({
    rrule: z.string().min(1).max(RRULE_MAX_LENGTH),
  })
  .strict();
export type BookingRecurrencePattern = z.infer<typeof BookingRecurrencePatternSchema>;

/**
 * `POST /api/v1/bookings/recurring` request — same per-occurrence
 * fields as `CreateBookingRequest` plus the `recurrence` block. The
 * `scheduledStart` / `scheduledEnd` define the FIRST occurrence; the
 * expander walks forward from that anchor.
 *
 * `bookingNotes` propagates to every materialised occurrence (a stable
 * note across the series — "every Tuesday companion dinner — door
 * code 1234"). A per-occurrence override surface lands in a follow-up.
 */
export const CreateRecurringBookingRequestSchema = z
  .object({
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    providerId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    serviceKind: BookingServiceKindSchema,
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    currency: z.string().length(BOOKING_CURRENCY_CODE_LENGTH),
    basePriceMinor: z
      .number()
      .int()
      .min(BOOKING_MONEY_AMOUNT_MIN_MINOR)
      .max(BOOKING_MONEY_AMOUNT_MAX_MINOR),
    commissionRateBps: z.number().int().min(0).max(10_000),
    bookingNotes: z.string().max(BOOKING_NOTES_MAX_LENGTH).optional(),
    recurrence: BookingRecurrencePatternSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Date.parse(body.scheduledEnd) <= Date.parse(body.scheduledStart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scheduledEnd must be strictly after scheduledStart',
        path: ['scheduledEnd'],
      });
    }
  });
export type CreateRecurringBookingRequest = z.infer<typeof CreateRecurringBookingRequestSchema>;

/**
 * Persisted recurrence record returned on the create response (so the
 * caller learns the canonical RRULE + termination back). `endDate`
 * carries the resolved UNTIL clause (if any) as an ISO date-time
 * string in UTC; `count` carries the resolved COUNT clause. Exactly
 * one of `endDate` / `count` is non-null — the parser materialises one
 * from the RRULE.
 */
export const BookingRecurrenceRecordSchema = z
  .object({
    seriesId: z.string().min(1).max(SERIES_ID_MAX_LENGTH),
    rrule: z.string().min(1).max(RRULE_MAX_LENGTH),
    endDate: z.string().datetime().nullable(),
    count: z.number().int().min(1).max(RECURRENCE_MAX_OCCURRENCES).nullable(),
    occurrenceCount: z.number().int().min(1).max(RECURRENCE_MAX_OCCURRENCES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type BookingRecurrenceRecord = z.infer<typeof BookingRecurrenceRecordSchema>;

/**
 * `POST /api/v1/bookings/recurring` response — returns the recurrence
 * record + every materialised child booking. The full child shape
 * lets the family-portal render the series without a second round-trip.
 */
export const CreateRecurringBookingResponseSchema = z
  .object({
    recurrence: BookingRecurrenceRecordSchema,
    bookings: z.array(BookingResponseSchema).min(1).max(RECURRENCE_MAX_OCCURRENCES),
  })
  .strict();
export type CreateRecurringBookingResponse = z.infer<typeof CreateRecurringBookingResponseSchema>;
