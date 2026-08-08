import { z } from 'zod';

import { BookingResponseSchema, BOOKING_SOFT_FK_MAX_LENGTH } from './booking.schema';

/**
 * Bookings list HTTP DTO (TS-125; PRD §6.4 family peace-of-mind +
 * PRD §6.3 booking management).
 *
 * `GET /api/v1/bookings?householdId=...&limit=...&cursor=...` — list
 * bookings for a single household. The Phase-1 family-portal `/bookings`
 * page calls this to render the "Your visits" list.
 *
 * **Household-scoped only.** The query MUST carry a `householdId` —
 * there is no "all bookings I can see" surface today (admin tooling
 * TS-128 ships that). The service-layer row-level check (CLAUDE.md
 * §3.2) verifies the authenticated user is a member of the named
 * household; cross-household leakage is impossible.
 *
 * **Cursor pagination.** Opaque cursor (today the underlying value is
 * `createdAt-DESC,id` encoded but the contract carries no
 * implementation detail — callers treat it as opaque, just like the
 * invoices cursor). `nextCursor` is null when this is the last page.
 *
 * **Sort.** Server-side fixed: `createdAt DESC` (most-recent first).
 * Matches the family-portal "Your visits" UX which always shows newest
 * at the top.
 */

export const BOOKINGS_LIST_LIMIT_DEFAULT = 20;
export const BOOKINGS_LIST_LIMIT_MAX = 100;
export const BOOKINGS_LIST_CURSOR_MAX_LENGTH = 256;

export const ListBookingsQuerySchema = z
  .object({
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(BOOKINGS_LIST_LIMIT_MAX)
      .default(BOOKINGS_LIST_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(BOOKINGS_LIST_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();
export type ListBookingsQuery = z.infer<typeof ListBookingsQuerySchema>;

export const BookingsListResponseSchema = z
  .object({
    bookings: z.array(BookingResponseSchema),
    nextCursor: z.string().min(1).max(BOOKINGS_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type BookingsListResponse = z.infer<typeof BookingsListResponseSchema>;
