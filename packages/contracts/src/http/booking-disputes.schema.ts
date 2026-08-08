import { z } from 'zod';

import { BookingDisputeOpenedByRoleSchema, BookingDisputeReasonSchema } from '../events/booking';
import { BOOKING_ID_MAX_LENGTH } from './booking-commission.schema';
import { BOOKING_SOFT_FK_MAX_LENGTH } from './booking.schema';

/**
 * Booking dispute HTTP DTOs (TS-065; PRD §10.5 dispute resolution
 * workflow, PDD §8.2 column inventory).
 *
 * Four endpoints span the dispute lifecycle:
 *
 *   - `POST /api/v1/bookings/:bookingId/disputes` — open a new dispute
 *     against a booking. The opener (family / provider) supplies a
 *     categorical `reason` plus an optional freeform `reasonDetail`.
 *     The service stamps `openedByUserId` + `openedByRole` from the
 *     authenticated request context (CLAUDE.md §3.2 — actor is never
 *     client-supplied). Idempotent on `Idempotency-Key`.
 *
 *   - `GET /api/v1/bookings/:bookingId/disputes` — list every dispute
 *     for a booking, ordered by `createdAt` ascending. Multiple
 *     disputes per booking are permitted (a billing dispute filed by
 *     family + a property-damage dispute filed by provider against
 *     the same booking are independent rows).
 *
 *   - `GET /api/v1/disputes/:disputeId` — read a single dispute.
 *
 *   - `PATCH /api/v1/disputes/:disputeId` — transition the dispute
 *     status (open → under_review → resolved/dismissed, or direct
 *     close). Concierge / ops staff endpoint. `resolutionNotes` is
 *     required when transitioning to a terminal state. Idempotent on
 *     `Idempotency-Key`.
 *
 * **State machine** (mirrors the Prisma enum doc):
 *
 *   open ──┬──▶ under_review ──┬──▶ resolved   (terminal)
 *          │                   │
 *          ├──▶ resolved        └──▶ dismissed (terminal)
 *          │
 *          └──▶ dismissed       (terminal)
 *
 * Terminal states are reached at most once per row. Re-opening is
 * intentionally not modelled — a new complaint opens a new dispute
 * row to preserve the prior resolution's audit trail.
 *
 * **PII discipline** (CLAUDE.md §3.9). The `reasonDetail` and
 * `resolutionNotes` columns are free-form narrative. They cross the
 * wire on direct reads (`GET /disputes/:id`) and writes, but they
 * are NOT carried on the corresponding domain events
 * (`booking.dispute_opened` / `booking.dispute_resolved`) — the
 * events carry boolean `hasReasonDetail` / `hasResolutionNotes`
 * flags so consumers know presence without seeing the text.
 *
 * **`.strict()` everywhere** — unknown fields are a parse error so a
 * typo or a stray client field never silently round-trips
 * (CLAUDE.md §3.3).
 */

/**
 * Bound for the dispute id — same shape as a booking id (CUID family).
 */
export const DISPUTE_ID_MAX_LENGTH = 64;

/**
 * Free-text caps. 2000 chars matches the booking cancellation reason
 * text ceiling and the visit-notes freeform field — long enough for
 * meaningful narrative, short enough that an attacker cannot use the
 * field as a bulk-exfil bucket.
 */
export const BOOKING_DISPUTE_REASON_DETAIL_MAX_LENGTH = 2_000;
export const BOOKING_DISPUTE_RESOLUTION_NOTES_MAX_LENGTH = 2_000;

/**
 * Dispute lifecycle status — mirrors the Prisma
 * `booking_dispute_status` enum (TS-065). Four-state machine:
 *   open → under_review → resolved/dismissed (terminal)
 *   open → resolved/dismissed (direct close)
 */
export const BookingDisputeStatusSchema = z.enum(['open', 'under_review', 'resolved', 'dismissed']);
export type BookingDisputeStatus = z.infer<typeof BookingDisputeStatusSchema>;

/**
 * Subset of `BookingDisputeStatus` accepted by the PATCH endpoint —
 * the API never lets a caller flip a dispute back to `open`. The
 * service-layer state machine enforces the legal transitions; the
 * contract layer bounds the request payload up-front.
 */
export const TransitionableBookingDisputeStatusSchema = z.enum([
  'under_review',
  'resolved',
  'dismissed',
]);
export type TransitionableBookingDisputeStatus = z.infer<
  typeof TransitionableBookingDisputeStatusSchema
>;

/**
 * Re-export the opener-role + reason schemas at the HTTP layer so
 * downstream apps don't need to reach into the events module.
 */
export { BookingDisputeOpenedByRoleSchema, BookingDisputeReasonSchema } from '../events/booking';
export type { BookingDisputeOpenedByRole, BookingDisputeReason } from '../events/booking';

/**
 * `POST /api/v1/bookings/:bookingId/disputes` request body.
 *
 * The opener selects a categorical `reason` and (optionally) attaches
 * a freeform narrative in `reasonDetail`. The service stamps the
 * actor + opener role server-side from the authenticated request
 * context.
 */
export const OpenBookingDisputeRequestSchema = z
  .object({
    reason: BookingDisputeReasonSchema,
    reasonDetail: z.string().max(BOOKING_DISPUTE_REASON_DETAIL_MAX_LENGTH).optional(),
  })
  .strict();
export type OpenBookingDisputeRequest = z.infer<typeof OpenBookingDisputeRequestSchema>;

/**
 * `PATCH /api/v1/disputes/:disputeId` request body.
 *
 * Transition the dispute to `targetStatus`. The service validates the
 * transition against the state machine and rejects with 409 on illegal
 * transitions (e.g. `resolved → under_review`).
 *
 * `resolutionNotes` is REQUIRED when `targetStatus` is `resolved` or
 * `dismissed` (the terminal states need a documented outcome —
 * preserved as the audit trail on the row + as the boolean
 * `hasResolutionNotes` on the resolved event). The schema enforces
 * this via `.superRefine`.
 *
 * `resolvedByUserId` / `resolvedAt` are NOT on the wire — the
 * service stamps them server-side from the authenticated request
 * context + a trusted clock. The audit trail is not client-controllable.
 */
export const UpdateBookingDisputeRequestSchema = z
  .object({
    targetStatus: TransitionableBookingDisputeStatusSchema,
    resolutionNotes: z.string().max(BOOKING_DISPUTE_RESOLUTION_NOTES_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const isTerminal = body.targetStatus === 'resolved' || body.targetStatus === 'dismissed';
    if (isTerminal) {
      if (body.resolutionNotes === undefined || body.resolutionNotes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'resolutionNotes is required when targetStatus is resolved or dismissed',
          path: ['resolutionNotes'],
        });
      }
    }
  });
export type UpdateBookingDisputeRequest = z.infer<typeof UpdateBookingDisputeRequestSchema>;

/**
 * Single `booking_disputes` row shape, surfaced to the client. The
 * mapper converts the Prisma row to this shape — see
 * `apps/service-booking/src/modules/disputes/mappers/disputes.mapper.ts`.
 *
 * `resolvedByUserId` / `resolvedAt` / `resolutionNotes` are null on
 * open / under_review rows and non-null on terminal rows. The
 * database CHECK constraint enforces the invariant that all three
 * resolution columns transition together.
 */
export const BookingDisputeResponseSchema = z
  .object({
    id: z.string().min(1).max(DISPUTE_ID_MAX_LENGTH),
    bookingId: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    openedByUserId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    openedByRole: BookingDisputeOpenedByRoleSchema,
    reason: BookingDisputeReasonSchema,
    reasonDetail: z.string().nullable(),
    status: BookingDisputeStatusSchema,
    resolutionNotes: z.string().nullable(),
    resolvedByUserId: z.string().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type BookingDisputeResponse = z.infer<typeof BookingDisputeResponseSchema>;

/**
 * `GET /api/v1/bookings/:bookingId/disputes` 200 response.
 *
 * Lists every dispute for the booking, ordered by `createdAt`
 * ascending (oldest first — natural for "this is what happened with
 * this booking over time" timeline rendering). Empty list (booking
 * exists but no disputes) is a 200 with `items: []`.
 */
export const BookingDisputesListResponseSchema = z
  .object({
    items: z.array(BookingDisputeResponseSchema),
  })
  .strict();
export type BookingDisputesListResponse = z.infer<typeof BookingDisputesListResponseSchema>;
