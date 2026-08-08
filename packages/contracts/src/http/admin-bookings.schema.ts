import { z } from 'zod';

import {
  BookingCancellationReasonSchema,
  BookingDisputeOpenedByRoleSchema,
  BookingDisputeReasonSchema,
  BookingServiceKindSchema,
} from '../events/booking';
import {
  BookingCheckInKindSchema,
  CHECK_IN_LATITUDE_MAX,
  CHECK_IN_LATITUDE_MIN,
  CHECK_IN_LONGITUDE_MAX,
  CHECK_IN_LONGITUDE_MIN,
} from './booking-check-ins.schema';
import { BookingDisputeStatusSchema } from './booking-disputes.schema';
import { BookingStatusSchema } from './booking.schema';
import { RRULE_MAX_LENGTH, RECURRENCE_MAX_OCCURRENCES } from './booking-recurrence.schema';
import {
  VisitNoteAppetiteSchema,
  VisitNoteHydrationSchema,
  VisitNoteMoodSchema,
  VisitNoteSocialEngagementSchema,
} from './booking-visit-notes.schema';

/**
 * Admin bookings management HTTP DTOs (TS-128 Slice 1; PRD §10.5).
 *
 * Two read-only surfaces:
 *
 *   - `GET /api/v1/admin/bookings?householdId=&providerId=&seniorId=
 *      &serviceKind=&status=&cursor=&limit=`
 *     Cursor-paginated search across the booking service's `bookings`
 *     table. Returns a denormalised summary per row (status, money
 *     fields in integer USD minor units, schedule, currency, derived
 *     `isRecurring` flag) so the list page renders without an N+1
 *     detail fetch.
 *
 *   - `GET /api/v1/admin/bookings/:id`
 *     Full booking-detail view. Carries the booking row plus the visit
 *     notes (one row max), check-ins (up to two — check_in / check_out),
 *     disputes (zero or more), and the recurrence record when the row
 *     is part of a recurring series.
 *
 * **Slice 1 scope.** Read-only. Mutations (manual concierge booking
 * creation — TS-128-followup-1, cancel/refund — TS-128-followup-2,
 * dispute open/resolve — TS-128-followup-3), provider tier + commission
 * management (TS-128-followup-4), featured-placement scheduling
 * (TS-128-followup-5), service-catalog management (TS-128-followup-6),
 * audit-event emission (TS-128-followup-7), Playwright E2E
 * (TS-128-followup-8), OTel + Prometheus (TS-128-followup-9), and
 * OpenAPI generator registration (TS-128-followup-10) arrive in
 * subsequent TS-128 follow-ups.
 *
 * **Authorisation.** The downstream service-booking endpoint is gated
 * by a `SuperAdminRoleGuard` that requires the access token's `roles[]`
 * claim to carry an active `super_admin` assignment. The api-gateway
 * proxy enforces the same gate at the edge for defence-in-depth.
 * Future per-permission gating (`booking:read` for ops + concierge +
 * trust-safety) lands with TS-128-followup-11 once `PermissionGuard`
 * lifts to `packages/nest-auth` (TS-052-followup-11).
 *
 * **Audit.** Admin reads do NOT emit audit events in Slice 1 — only
 * mutations do, and Slice 1 has no mutations. Read auditing arrives
 * with TS-128-followup-7 once the audit pipe is operational.
 *
 * **Money fields.** Integer USD minor units (`basePriceMinor`,
 * `commissionAmountMinor`, `finalPriceMinor`) per CLAUDE.md §17.6 — no
 * floats over the wire. Mirrors `BookingResponseSchema`'s shape for
 * the columns they share.
 *
 * **`.strict()`** everywhere — unknown fields are a parse error so a
 * typo or stray field never silently round-trips.
 */

/**
 * Cursor max length. Opaque to the consumer; the service emits a
 * base64-encoded `(createdAt-ISO, id)` pair. 256 bytes is well past
 * the maximum encoded size; the cap exists to bound query-string
 * abuse, not to constrain the cursor format. Mirrors
 * `ADMIN_USERS_LIST_CURSOR_MAX_LENGTH` /
 * `ADMIN_SUBSCRIPTIONS_LIST_CURSOR_MAX_LENGTH`.
 */
export const ADMIN_BOOKINGS_LIST_CURSOR_MAX_LENGTH = 256;

/** Default page size for `GET /api/v1/admin/bookings`. */
export const ADMIN_BOOKINGS_LIST_LIMIT_DEFAULT = 25;

/** Maximum page size for `GET /api/v1/admin/bookings`. */
export const ADMIN_BOOKINGS_LIST_LIMIT_MAX = 100;

/**
 * Booking / household / provider / senior id path-parameter max length.
 * CUID2 + safety margin. Matches the cap used across the booking
 * contracts.
 */
export const ADMIN_BOOKINGS_ID_MAX_LENGTH = 64;

/**
 * Maximum number of dispute rows returned on the detail view. Slice 1
 * surfaces the most-recent N entries (chronological); the full
 * cursor-paginated dispute history lands as a follow-up. Bounds the
 * response size against a noisy booking with many disputes.
 */
export const ADMIN_BOOKINGS_DISPUTES_MAX = 50;

/**
 * Maximum number of check-in rows returned on the detail view. At
 * most two in Phase 1 (one `check_in`, one `check_out`) — the cap
 * leaves headroom for a future "provider stepped out and re-entered"
 * surface.
 */
export const ADMIN_BOOKINGS_CHECK_INS_MAX = 10;

/**
 * Maximum freeform-narrative length on visit notes / cancellation /
 * dispute fields. Mirrors `BOOKING_NOTES_MAX_LENGTH` /
 * `BOOKING_DISPUTE_REASON_DETAIL_MAX_LENGTH` so the read-back never
 * surfaces a value the write surface wouldn't accept.
 */
export const ADMIN_BOOKINGS_FREEFORM_MAX_LENGTH = 2_000;

/**
 * Denormalised visit notes snapshot on the detail view. Null when the
 * booking has not yet received any visit notes (most pending /
 * confirmed bookings; never-checked-in cancellations).
 *
 * Coarse-grained 5-point ordinals echo `VisitNote{Mood,Appetite,...}`
 * (CLAUDE.md §12 — hospitality, not clinical). All four are nullable
 * because partial saves are accepted by the upstream upsert surface.
 *
 * `freeform` and `photoKeys` are bounded; admin tooling renders the
 * narrative + thumbnails directly without traversing into media-svc.
 */
export const AdminBookingVisitNoteSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    mood: VisitNoteMoodSchema.nullable(),
    appetite: VisitNoteAppetiteSchema.nullable(),
    hydration: VisitNoteHydrationSchema.nullable(),
    socialEngagement: VisitNoteSocialEngagementSchema.nullable(),
    freeform: z.string().max(ADMIN_BOOKINGS_FREEFORM_MAX_LENGTH).nullable(),
    photoKeys: z.array(z.string().min(1).max(128)),
    recordedByUserId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    recordedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminBookingVisitNoteSummary = z.infer<typeof AdminBookingVisitNoteSummarySchema>;

/**
 * Check-in snapshot on the detail view. Echoes the persisted columns
 * with geo coordinates as JSON numbers (the persistence layer holds
 * `Decimal(8,6)` / `Decimal(9,6)` — see `BookingCheckInResponseSchema`).
 *
 * Phase-1 admin tooling renders the raw coordinates for ops triage
 * (the family-portal does NOT expose them — CLAUDE.md §12 family-
 * observability boundary). Future map-rendering or trust-safety
 * "obvious geo mismatch" flags lives with TS-300 trust-safety.
 */
export const AdminBookingCheckInSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    kind: BookingCheckInKindSchema,
    latitude: z.number().finite().min(CHECK_IN_LATITUDE_MIN).max(CHECK_IN_LATITUDE_MAX),
    longitude: z.number().finite().min(CHECK_IN_LONGITUDE_MIN).max(CHECK_IN_LONGITUDE_MAX),
    locationAccuracyMeters: z.number().finite().nonnegative().nullable(),
    occurredAt: z.string().datetime(),
    recordedByUserId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminBookingCheckInSummary = z.infer<typeof AdminBookingCheckInSummarySchema>;

/**
 * Dispute snapshot on the detail view. Echoes the persisted columns
 * (status, reason, opener, optional resolution). Capped narrative
 * fields mirror `BookingDisputeResponseSchema`.
 *
 * Welfare/safety disputes are first class (CLAUDE.md §12); the admin
 * tooling renders the dispute reason chip prominently for ops triage.
 * The list endpoint already filters by parent-booking id so this row
 * shape carries no `bookingId` — the parent is implicit.
 */
export const AdminBookingDisputeSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    openedByUserId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    openedByRole: BookingDisputeOpenedByRoleSchema,
    reason: BookingDisputeReasonSchema,
    reasonDetail: z.string().max(ADMIN_BOOKINGS_FREEFORM_MAX_LENGTH).nullable(),
    status: BookingDisputeStatusSchema,
    resolutionNotes: z.string().max(ADMIN_BOOKINGS_FREEFORM_MAX_LENGTH).nullable(),
    resolvedByUserId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH).nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminBookingDisputeSummary = z.infer<typeof AdminBookingDisputeSummarySchema>;

/**
 * Recurrence snapshot on the detail view. Null when the booking is a
 * one-off (the row's `seriesId` is null). Carries the canonical RRULE
 * + the resolved termination clause so admin tooling can show "weekly
 * companion dinner — 12 occurrences" without a second round-trip.
 */
export const AdminBookingRecurrenceSummarySchema = z
  .object({
    seriesId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    rrule: z.string().min(1).max(RRULE_MAX_LENGTH),
    endDate: z.string().datetime().nullable(),
    count: z.number().int().min(1).max(RECURRENCE_MAX_OCCURRENCES).nullable(),
    occurrenceCount: z.number().int().min(1).max(RECURRENCE_MAX_OCCURRENCES),
    /**
     * Zero-based position of THIS booking within the series. Echoed
     * from `bookings.series_index` so the admin tooling shows
     * "occurrence 3 of 12" inline.
     */
    seriesIndex: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminBookingRecurrenceSummary = z.infer<typeof AdminBookingRecurrenceSummarySchema>;

/**
 * Row shape for the list response. Carries only what the list page
 * needs to render — full visit notes / check-ins / disputes graph is
 * reserved for the detail endpoint.
 */
export const AdminBookingSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    householdId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    seniorId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    providerId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    serviceKind: BookingServiceKindSchema,
    status: BookingStatusSchema,
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    currency: z.string().length(3),
    basePriceMinor: z.number().int().min(0),
    commissionRateBps: z.number().int().min(0).max(10_000),
    commissionAmountMinor: z.number().int().min(0),
    finalPriceMinor: z.number().int().min(0),
    completedAt: z.string().datetime().nullable(),
    canceledAt: z.string().datetime().nullable(),
    cancellationReason: BookingCancellationReasonSchema.nullable(),
    /**
     * Derived "is part of a recurring series" flag. True when the
     * underlying `bookings.series_id` is non-null. Carried on the
     * summary so the list page can chip recurring rows without
     * expanding the recurrence sub-object.
     */
    isRecurring: z.boolean(),
    /**
     * Trust & safety hold (TS-304-followup-1). True while
     * `bookings.held_by_incident_id` is non-null — the visit is suspended and
     * will not proceed. Ops triaging this queue must not read a held row as a
     * normal upcoming visit.
     *
     * **A boolean here too, deliberately.** The incident id would be
     * defensible on an admin surface in isolation — but this row is mapped
     * from the same booking projection the family portal reads, and one
     * disclosure rule that holds everywhere is worth more than a per-surface
     * one nobody re-checks. The ops view that DOES name the incident is
     * `GET /api/v1/admin/booking-holds` (TS-304-followup-3), gated
     * `trust_safety:read` — which this queue's `booking:read` audience may not
     * hold, and that is the point (CLAUDE.md §12: do not spread "who is under
     * investigation" across the booking queue).
     */
    onHold: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminBookingSummary = z.infer<typeof AdminBookingSummarySchema>;

/**
 * Query shape for `GET /api/v1/admin/bookings`.
 *
 * - `householdId` — optional exact-match filter against `household_id`.
 * - `providerId`  — optional exact-match filter against `provider_id`.
 * - `seniorId`    — optional exact-match filter against `senior_id`.
 * - `serviceKind` — optional exact-match filter against `service_kind`.
 * - `status`      — optional exact-match filter against `status`.
 * - `cursor`      — opaque pagination cursor from the previous page's
 *                   `nextCursor`.
 * - `limit`       — page size; defaults to 25, max 100.
 */
export const AdminBookingsListQuerySchema = z
  .object({
    householdId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH).optional(),
    providerId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH).optional(),
    seniorId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH).optional(),
    serviceKind: BookingServiceKindSchema.optional(),
    status: BookingStatusSchema.optional(),
    cursor: z.string().min(1).max(ADMIN_BOOKINGS_LIST_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_BOOKINGS_LIST_LIMIT_MAX)
      .default(ADMIN_BOOKINGS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type AdminBookingsListQuery = z.infer<typeof AdminBookingsListQuerySchema>;

export const AdminBookingsListResponseSchema = z
  .object({
    bookings: z.array(AdminBookingSummarySchema),
    nextCursor: z.string().min(1).max(ADMIN_BOOKINGS_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminBookingsListResponse = z.infer<typeof AdminBookingsListResponseSchema>;

/**
 * Detail-view response for `GET /api/v1/admin/bookings/:id`.
 *
 * Composes the per-row columns (echoed from `BookingResponseSchema`)
 * with the visit-notes sub-object (one row max), the check-ins list,
 * the disputes list, and the recurrence summary when the booking
 * belongs to a series. Each related-row collection is capped at the
 * contract layer so a noisy booking can't blow the detail-view
 * response size.
 */
export const AdminBookingDetailSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    householdId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    seniorId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    providerId: z.string().min(1).max(ADMIN_BOOKINGS_ID_MAX_LENGTH),
    serviceKind: BookingServiceKindSchema,
    status: BookingStatusSchema,
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    currency: z.string().length(3),
    basePriceMinor: z.number().int().min(0),
    commissionRateBps: z.number().int().min(0).max(10_000),
    commissionAmountMinor: z.number().int().min(0),
    finalPriceMinor: z.number().int().min(0),
    bookingNotes: z.string().max(ADMIN_BOOKINGS_FREEFORM_MAX_LENGTH).nullable(),
    completedAt: z.string().datetime().nullable(),
    canceledAt: z.string().datetime().nullable(),
    cancellationReason: BookingCancellationReasonSchema.nullable(),
    cancellationReasonText: z.string().max(ADMIN_BOOKINGS_FREEFORM_MAX_LENGTH).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /**
     * Visit-notes snapshot for the booking. Null when no row exists
     * (typical for pending / confirmed bookings; permanent for
     * never-started cancellations).
     */
    visitNote: AdminBookingVisitNoteSummarySchema.nullable(),
    /**
     * Check-in rows for the booking. Empty when the visit hasn't
     * started; one entry after `check_in`; two entries after
     * `check_out`. Capped at `ADMIN_BOOKINGS_CHECK_INS_MAX`.
     */
    checkIns: z.array(AdminBookingCheckInSummarySchema).max(ADMIN_BOOKINGS_CHECK_INS_MAX),
    /**
     * Dispute rows for the booking, newest-first. Empty in the common
     * case. Capped at `ADMIN_BOOKINGS_DISPUTES_MAX`.
     */
    disputes: z.array(AdminBookingDisputeSummarySchema).max(ADMIN_BOOKINGS_DISPUTES_MAX),
    /**
     * Recurrence record when the row belongs to a series. Null on
     * one-off bookings (`bookings.series_id IS NULL`).
     */
    recurrence: AdminBookingRecurrenceSummarySchema.nullable(),
  })
  .strict();
export type AdminBookingDetail = z.infer<typeof AdminBookingDetailSchema>;

export const AdminBookingDetailResponseSchema = z
  .object({
    booking: AdminBookingDetailSchema,
  })
  .strict();
export type AdminBookingDetailResponse = z.infer<typeof AdminBookingDetailResponseSchema>;
