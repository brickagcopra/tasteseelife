import { z } from 'zod';

import {
  BOOKING_SEARCH_ID_MAX_LENGTH,
  BookingCancellationReasonSchema,
  BookingDeclineKindSchema,
  BookingDeclineReasonSchema,
  BookingServiceKindSchema,
} from '../events/booking';
import { AccountCurrencySchema } from './account.schema';
import { BOOKING_ID_MAX_LENGTH } from './booking-commission.schema';

/**
 * Booking HTTP DTOs (TS-060-followup-1; PRD §6.3; PDD §8.2 / §9.2).
 *
 * The single source of truth for the public contract of
 * `service-booking`'s three Phase-1 endpoints:
 *
 *   - `POST /api/v1/bookings`             — create a booking (always
 *                                            lands in `pending`).
 *   - `PATCH /api/v1/bookings/:id/status` — transition the booking's
 *                                            lifecycle status.
 *   - `GET /api/v1/bookings/:id`          — read a single booking.
 *
 * `.strict()` everywhere — unknown fields are a parse error so a typo
 * or a stray client field never silently round-trips (CLAUDE.md §3.3).
 *
 * **Money discipline**. The booking row stores `Decimal(12,2)` server-
 * side (CLAUDE.md §4.1 / §17.6). At the wire the SAME precision is
 * carried as **integer USD minor units** (cents). Float math is
 * forbidden at every layer — the controller parses minor units, the
 * service converts to `Decimal` before persisting, and the read-side
 * mapper converts back to minor units for the response.
 *
 * **`BookingStatus`** mirrors the Prisma enum (TS-060). Same
 * five-state machine as the lifecycle service: pending → confirmed
 * → in_progress → completed/canceled.
 */

// Reusable bounds documented as exported constants so consumers (BFF
// clients, admin tooling) can validate inputs against the same shape
// without re-deriving from the schema body.
export const BOOKING_NOTES_MAX_LENGTH = 2_000;
export const BOOKING_CANCELLATION_REASON_TEXT_MAX_LENGTH = 2_000;
export const BOOKING_DECLINE_REASON_TEXT_MAX_LENGTH = 2_000;
export const BOOKING_MONEY_AMOUNT_MIN_MINOR = 0;
export const BOOKING_MONEY_AMOUNT_MAX_MINOR = 9_999_999_999;
export const BOOKING_SOFT_FK_MAX_LENGTH = 64;
export const BOOKING_CURRENCY_CODE_LENGTH = 3;

/**
 * Provider accept window (TS-205; PRD §7.3).
 *
 * Default 30 minutes from booking creation; configurable per service
 * via `BOOKING_ACCEPT_WINDOW_MINUTES`. The window bounds the time the
 * assigned provider has to respond before the booking is auto-declined
 * back to the concierge queue (TS-205-followup-1 wires the worker;
 * Phase-1 stop-gap is the accept endpoint refusing past the window).
 * The contract layer pins the legal bounds so a misconfigured env var
 * fails fast at boot.
 */
export const BOOKING_ACCEPT_WINDOW_MINUTES_DEFAULT = 30;
export const BOOKING_ACCEPT_WINDOW_MINUTES_MIN = 1;
export const BOOKING_ACCEPT_WINDOW_MINUTES_MAX = 24 * 60; // 24h hard ceiling.

export const BookingStatusSchema = z.enum([
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'canceled',
  'declined',
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

/**
 * `POST /api/v1/bookings` request.
 *
 * The booking is always created in `pending`. The caller passes:
 *
 *   - identifiers — `householdId`, `seniorId`, `providerId`. The
 *     service rejects requests where the authenticated user is not a
 *     member of `householdId` (CLAUDE.md §3.2 row-level checks).
 *   - service shape — `serviceKind`, `scheduledStart`, `scheduledEnd`.
 *   - money — `basePriceMinor` + `currency` + `commissionRateBps`.
 *     The service derives `commissionAmountMinor` from rate × base
 *     and stores both, plus `finalPriceMinor` (which equals
 *     `basePriceMinor` at create time — diverges later with TS-043
 *     coupons / TS-084 tax + refunds).
 *   - free-text — `bookingNotes` optional (allergies, door codes,
 *     etc.). Capped at 2000 chars; never logged in plaintext.
 *
 * The basis-points rate (0–10000) matches the booking-commission
 * receiver shape (`packages/contracts/src/http/booking-commission.schema.ts`).
 */
export const CreateBookingRequestSchema = z
  .object({
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    providerId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    serviceKind: BookingServiceKindSchema,
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    // TS-060-followup-1b — currency is allow-listed at the wire (Phase-1:
    // USD only, PRD §11.4) so a malformed / non-USD value is a 400 here
    // rather than surfacing downstream at the booking-commission
    // recognizer (TS-083), whose cap is also USD-only. Reuses the
    // platform-wide `AccountCurrencySchema` (z.enum(['USD'])) — the same
    // allow-list the booking-commission contract already pins — so
    // Phase-3 multi-currency expansion (TS-264) lands in one place.
    currency: AccountCurrencySchema,
    basePriceMinor: z
      .number()
      .int()
      .min(BOOKING_MONEY_AMOUNT_MIN_MINOR)
      .max(BOOKING_MONEY_AMOUNT_MAX_MINOR),
    commissionRateBps: z.number().int().min(0).max(10_000),
    bookingNotes: z.string().max(BOOKING_NOTES_MAX_LENGTH).optional(),
    // TS-217-prep-4c — optional search-correlation token. When the family
    // arrived at this booking from a provider-discovery search, the portal
    // threads the `searchId` it received on `SearchProvidersResponse`
    // (TS-217-prep-4a) through the provider-detail / request-a-visit links
    // into this create call. service-booking echoes it onto `booking.created`
    // so service-analytics can attribute the booking to the exact originating
    // search (precise query→booking conversion). Omitted for concierge manual
    // bookings or direct-link visits that did not originate from a search.
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
export type CreateBookingRequest = z.infer<typeof CreateBookingRequestSchema>;

/**
 * Subset of `BookingStatus` accepted by the transition endpoint. The
 * server rejects illegal transitions per the state-machine matrix in
 * `service-booking` (e.g. `pending → in_progress` is a 409).
 */
export const TransitionableBookingStatusSchema = z.enum([
  'confirmed',
  'in_progress',
  'completed',
  'canceled',
]);
export type TransitionableBookingStatus = z.infer<typeof TransitionableBookingStatusSchema>;

/**
 * `PATCH /api/v1/bookings/:id/status` request.
 *
 * The caller asks for a specific destination status. The server
 * validates the transition against the lifecycle matrix and rejects
 * with 409 on illegal transitions (e.g. `pending → completed`).
 *
 * `cancellationReason` is required when transitioning to `canceled`
 * (categorical) — the free-form text variant lives on
 * `cancellationReasonText`. The schema enforces "reason required on
 * cancel" via `.superRefine`.
 *
 * `startedAt` / `completedAt` are NOT accepted at the wire — the
 * service stamps them server-side from a trusted clock. The lifecycle
 * timestamps are not client-controllable.
 */
export const TransitionBookingStatusRequestSchema = z
  .object({
    targetStatus: TransitionableBookingStatusSchema,
    cancellationReason: BookingCancellationReasonSchema.optional(),
    cancellationReasonText: z.string().max(BOOKING_CANCELLATION_REASON_TEXT_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.targetStatus === 'canceled' && body.cancellationReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cancellationReason is required when targetStatus is canceled',
        path: ['cancellationReason'],
      });
    }
    if (body.targetStatus !== 'canceled' && body.cancellationReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cancellationReason is only permitted when targetStatus is canceled',
        path: ['cancellationReason'],
      });
    }
    if (body.cancellationReasonText !== undefined && body.cancellationReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cancellationReasonText is only permitted alongside cancellationReason',
        path: ['cancellationReasonText'],
      });
    }
  });
export type TransitionBookingStatusRequest = z.infer<typeof TransitionBookingStatusRequestSchema>;

/**
 * `POST /api/v1/bookings/:id/accept` (TS-205) — provider accepts the
 * inbound booking request, transitioning `pending` → `confirmed`.
 *
 * The body is intentionally empty today — every relevant fact
 * (actor, booking id, current time) is sourced server-side. A future
 * follow-up may extend it with a per-accept note (e.g. "running 10
 * minutes late") at which point the schema grows additively.
 *
 * Status codes:
 *   200 OK              — body is the updated BookingResponse.
 *   401 Unauthorized    — missing / invalid access token.
 *   403 Forbidden       — actor is not the assigned provider.
 *   404 Not Found       — booking id does not exist.
 *   409 Conflict        — booking is no longer in `pending` (already
 *                         accepted, declined, canceled, etc.) OR the
 *                         accept window has expired (`accept_window_expired`).
 */
export const AcceptBookingRequestSchema = z.object({}).strict();
export type AcceptBookingRequest = z.infer<typeof AcceptBookingRequestSchema>;

/**
 * `POST /api/v1/bookings/:id/decline` (TS-205) — provider declines
 * the inbound booking request, transitioning `pending` → `declined`.
 *
 * `declineReason` is the categorical reason (required for the
 * `provider_declined` / `admin_declined` decline kinds). The auto-
 * decline worker (TS-205-followup-1) sets `window_expired` server-
 * side with a null reason; that path does not pass through this DTO.
 *
 * `declineReasonText` carries the optional free-form narrative for
 * ops triage. Bounded at 2000 chars; never logged in plaintext
 * (CLAUDE.md §3.9 — PII discipline).
 *
 * Status codes:
 *   200 OK              — body is the updated BookingResponse.
 *   400 Bad Request     — payload failed validation.
 *   401 Unauthorized    — missing / invalid access token.
 *   403 Forbidden       — actor is not the assigned provider.
 *   404 Not Found       — booking id does not exist.
 *   409 Conflict        — booking is no longer in `pending`.
 */
export const DeclineBookingRequestSchema = z
  .object({
    declineReason: BookingDeclineReasonSchema,
    declineReasonText: z.string().max(BOOKING_DECLINE_REASON_TEXT_MAX_LENGTH).optional(),
  })
  .strict();
export type DeclineBookingRequest = z.infer<typeof DeclineBookingRequestSchema>;

/**
 * Booking response shape — used by `POST /api/v1/bookings`,
 * `PATCH /api/v1/bookings/:id/status`, `POST /api/v1/bookings/:id/accept`,
 * `POST /api/v1/bookings/:id/decline`, and `GET /api/v1/bookings/:id`.
 *
 * All money fields are integer USD minor units (cents). All
 * timestamps are ISO 8601 strings (`z.string().datetime()`).
 *
 * **TS-205 fields**. The accept-window stamp + the decline metadata
 * surface so the family portal can render "accept by 6:42 PM" and
 * the provider portal can render decline-reason chips for completed
 * declines.
 *
 *   - `acceptWindowExpiresAt` — wall-clock time after which the
 *     auto-decline worker (TS-205-followup-1) declines a still-
 *     pending booking. Always non-null for newly-created bookings;
 *     nullable to support back-fill of pre-TS-205 rows + future
 *     "no expiry" admin-created bookings (TS-128).
 *   - `declinedAt` / `declineKind` / `declineReason` /
 *     `declineReasonText` / `declinedByUserId` — populated exactly
 *     once on the `pending` → `declined` transition. All null on
 *     non-declined bookings.
 */
export const BookingResponseSchema = z
  .object({
    id: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    providerId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    serviceKind: BookingServiceKindSchema,
    status: BookingStatusSchema,
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    currency: z.string().length(BOOKING_CURRENCY_CODE_LENGTH),
    basePriceMinor: z.number().int().min(0),
    commissionRateBps: z.number().int().min(0).max(10_000),
    commissionAmountMinor: z.number().int().min(0),
    finalPriceMinor: z.number().int().min(0),
    bookingNotes: z.string().nullable(),
    completedAt: z.string().datetime().nullable(),
    canceledAt: z.string().datetime().nullable(),
    cancellationReason: BookingCancellationReasonSchema.nullable(),
    cancellationReasonText: z.string().nullable(),
    acceptWindowExpiresAt: z.string().datetime().nullable(),
    declinedAt: z.string().datetime().nullable(),
    declineKind: BookingDeclineKindSchema.nullable(),
    declineReason: BookingDeclineReasonSchema.nullable(),
    declineReasonText: z.string().nullable(),
    declinedByUserId: z.string().nullable(),
    /**
     * **Is this visit suspended by a trust & safety hold?** (TS-304-followup-1.)
     *
     * TS-304 made a hold ENFORCED and INVISIBLE: `bookings.held_by_incident_id`
     * blocks the visit, and every read surface — family portal, provider
     * portal, admin — rendered the booking as if it were proceeding. Nobody
     * showed up and everybody expected somebody. This field is the fix.
     *
     * **A boolean, and the narrowness is the design.** This shape is served to
     * the family portal (`GET /api/v1/bookings/:id`, the household list, and
     * every create / transition response), so anything on it is family-visible
     * — and a hold means the provider, the senior, or the household is under
     * review for a `high` or `critical` concern. The reader is often the
     * family member who booked, sometimes the very person a conduct report
     * names. So the incident id is NOT here, the severity is NOT here, the
     * category is NOT here, and neither is `held_at`: a timestamp is a
     * correlation handle ("it was paused right after I did X") that buys the
     * family nothing they need. Exactly one bit crosses: this visit is paused.
     *
     * That is the same calculus as the TS-304 booking-create 409, which says
     * the visit is temporarily unavailable and points at a human without
     * naming a reason. The 409 keeps the incident id in a SEPARATE field for
     * ops correlation; the equivalent richer view here already exists as
     * `GET /api/v1/admin/booking-holds` (TS-304-followup-3), gated
     * `trust_safety:read` — which is why admin loses nothing by this field
     * being one bit wide, and why widening it "for admin" would be widening it
     * for the family portal.
     *
     * `false` on every booking that is not held, including completed and
     * cancelled ones — a hold that outlives the visit is still a hold, and the
     * flag tracks the column rather than second-guessing it.
     */
    onHold: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type BookingResponse = z.infer<typeof BookingResponseSchema>;
