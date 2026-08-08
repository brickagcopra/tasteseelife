import { z } from 'zod';

import { BOOKING_SEARCH_ID_MAX_LENGTH, BookingServiceKindSchema } from '../events/booking';
import {
  BOOKING_NOTES_MAX_LENGTH,
  BOOKING_SOFT_FK_MAX_LENGTH,
  BookingResponseSchema,
} from './booking.schema';

/**
 * Concierge booking-request HTTP DTO (TS-125; PRD §6.3 + §6.6; PDD §28
 * Phase 1 "manual matching by ops").
 *
 * The Phase-1 manual-matching booking-request surface. Families pick a
 * provider in the discovery UX, fill out a short request form, and
 * submit. **The family never enters money** — `basePrice`,
 * `commissionRate`, and `currency` are derived server-side from a
 * platform-default service-kind catalog (`apps/service-booking/src/modules/concierge/services/service-kind-defaults.ts`).
 * That keeps the family-facing surface concise + auditable, and gives
 * the concierge team a clean intake row to fulfil.
 *
 * The downstream `service-booking` endpoint translates the request to
 * the existing `CreateBookingRequest` shape, calls
 * `BookingsService.createBooking`, and returns the resulting
 * `BookingResponse` (always `status: pending`).
 *
 * Status transitions stay on `PATCH /api/v1/bookings/:id/status` — the
 * concierge team uses the admin tooling (TS-128) to confirm /
 * reschedule / cancel; the family uses `/bookings/[id]` to cancel
 * pre-confirmation.
 *
 * `.strict()` everywhere — typos in field names are 400s, not silently
 * dropped knobs (CLAUDE.md §3.3).
 */

export const CreateConciergeBookingRequestSchema = z
  .object({
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    providerId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    serviceKind: BookingServiceKindSchema,
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    bookingNotes: z.string().max(BOOKING_NOTES_MAX_LENGTH).optional(),
    // TS-217-prep-4c — optional search-correlation token. The Phase-1
    // family-portal booking flow IS this concierge-request path, so the
    // `searchId` the portal received on `SearchProvidersResponse`
    // (TS-217-prep-4a) is threaded here; the service forwards it onto the
    // canonical `CreateBookingRequest` so `booking.created` echoes it for
    // precise per-search conversion attribution (TS-217-prep-4c-followup-1).
    searchId: z.string().min(1).max(BOOKING_SEARCH_ID_MAX_LENGTH).optional(),
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
export type CreateConciergeBookingRequest = z.infer<typeof CreateConciergeBookingRequestSchema>;

/**
 * Response is the same shape as a regular booking create — the family
 * portal renders the just-created pending booking as a confirmation
 * receipt. Re-exported here as a convenience so portal callers only
 * import from `concierge-booking-request.schema`.
 */
export const CreateConciergeBookingResponseSchema = BookingResponseSchema;
export type CreateConciergeBookingResponse = z.infer<typeof CreateConciergeBookingResponseSchema>;
