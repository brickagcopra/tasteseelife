import { z } from 'zod';

import { BookingResponseSchema, BOOKING_SOFT_FK_MAX_LENGTH } from './booking.schema';
import {
  VisitNoteAppetiteSchema,
  VisitNoteHydrationSchema,
  VisitNoteMoodSchema,
  VisitNoteSocialEngagementSchema,
} from './booking-visit-notes.schema';

/**
 * Family peace-of-mind dashboard read DTO (TS-230; PRD §6.4, §6.9;
 * PDD §10).
 *
 * `GET /api/v1/bookings/dashboard/me?windowDays=&seniorId=&historyCursor=&historyLimit=`
 *
 * The family-portal dashboard route renders two lists for a single
 * household:
 *
 *   - **upcoming** — the next 7 / 30 / 90 days of bookings that have not
 *     yet ended (status `pending` | `confirmed` | `in_progress`,
 *     `scheduledEnd >= now`, `scheduledStart <= now + windowDays`),
 *     ordered soonest-first. Window-bounded + hard-capped at
 *     `DASHBOARD_UPCOMING_MAX`; this list is NOT cursor-paginated (a
 *     bounded window never overflows in practice — a household with
 *     more than 50 visits inside its window can tighten the window).
 *
 *   - **history** — completed visits, newest-first, cursor-paginated.
 *     Each carries its visit-note summary inlined (one batched read on
 *     the service side — no N+1). "Completed-only" is the deliberate
 *     scope (TS-230 contract decision): a cancelled / declined booking
 *     is not a "visit", and missed-visit awareness is owned by TS-234
 *     (alert configuration).
 *
 * **Household resolution.** No `householdId` crosses the wire — the
 * service resolves it from the token `tenantScope` (the `/me` pattern,
 * mirroring the concierge enrichment `/me` surfaces). A non-household
 * actor gets a 400. The optional `seniorId` filter narrows both lists
 * to one senior (drives the per-senior tabs); absent = the combined
 * "All seniors" view.
 *
 * **Photos.** The visit-note summary carries a `photoCount`, NOT the
 * raw `photoKeys`. Consent-gated photo rendering via media-svc signed
 * URLs is owned by TS-232 — this dashboard surfaces only the structured
 * wellness scales + the freeform note + how many photos were shared.
 *
 * `.strict()` everywhere — unknown fields are a parse error so a typo
 * or a stray client field never silently round-trips (CLAUDE.md §3.3).
 */

/** The three windows the family dashboard offers for the upcoming list. */
export const DASHBOARD_WINDOW_DAYS_VALUES = [7, 30, 90] as const;
export type DashboardWindowDays = (typeof DASHBOARD_WINDOW_DAYS_VALUES)[number];
export const DASHBOARD_WINDOW_DAYS_DEFAULT: DashboardWindowDays = 30;

/**
 * Hard cap on the upcoming list. A window is, by construction, bounded;
 * the cap is a defence against a pathological household (e.g. many
 * daily bookings) blowing the payload. 50 is comfortably above a
 * realistic 90-day cadence (weekly = ~13, even daily = 90 would clamp).
 */
export const DASHBOARD_UPCOMING_MAX = 50;

export const DASHBOARD_HISTORY_LIMIT_DEFAULT = 10;
export const DASHBOARD_HISTORY_LIMIT_MAX = 50;
export const DASHBOARD_HISTORY_CURSOR_MAX_LENGTH = 256;

/** Literal-union schema for the response `windowDays` echo. */
export const DashboardWindowDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);

/**
 * `GET /api/v1/bookings/dashboard/me` query.
 *
 * `windowDays` coerces from the query string and must be one of the
 * three offered windows (defaults to 30). `seniorId` is the optional
 * per-senior tab filter. `historyCursor` + `historyLimit` paginate the
 * completed-visit list only — the upcoming list is window-bounded.
 */
export const FamilyVisitsDashboardQuerySchema = z
  .object({
    windowDays: z.coerce
      .number()
      .int()
      .refine(
        (value): value is DashboardWindowDays =>
          (DASHBOARD_WINDOW_DAYS_VALUES as readonly number[]).includes(value),
        { message: 'windowDays must be one of 7, 30, or 90' },
      )
      .default(DASHBOARD_WINDOW_DAYS_DEFAULT),
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH).optional(),
    historyCursor: z.string().min(1).max(DASHBOARD_HISTORY_CURSOR_MAX_LENGTH).optional(),
    historyLimit: z.coerce
      .number()
      .int()
      .positive()
      .max(DASHBOARD_HISTORY_LIMIT_MAX)
      .default(DASHBOARD_HISTORY_LIMIT_DEFAULT),
  })
  .strict();
export type FamilyVisitsDashboardQuery = z.infer<typeof FamilyVisitsDashboardQuerySchema>;

/**
 * The family-facing slice of a `booking_visit_notes` row.
 *
 * Deliberately NOT `VisitNotesResponse` — the dashboard does not expose
 * the recording provider's `recordedByUserId` (not a family concern),
 * and it carries a `photoCount` rather than the raw `photoKeys` so
 * photo rendering stays gated behind TS-232's consent + signed-URL
 * pipeline.
 */
export const DashboardVisitNoteSummarySchema = z
  .object({
    mood: VisitNoteMoodSchema.nullable(),
    appetite: VisitNoteAppetiteSchema.nullable(),
    hydration: VisitNoteHydrationSchema.nullable(),
    socialEngagement: VisitNoteSocialEngagementSchema.nullable(),
    freeform: z.string().nullable(),
    photoCount: z.number().int().min(0),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type DashboardVisitNoteSummary = z.infer<typeof DashboardVisitNoteSummarySchema>;

/**
 * A completed visit in the history list — the booking plus its
 * visit-note summary (null when the provider never recorded notes).
 */
export const DashboardPastVisitSchema = z
  .object({
    booking: BookingResponseSchema,
    visitNotes: DashboardVisitNoteSummarySchema.nullable(),
  })
  .strict();
export type DashboardPastVisit = z.infer<typeof DashboardPastVisitSchema>;

/**
 * `GET /api/v1/bookings/dashboard/me` response.
 *
 * `householdId` + `seniorId` echo the resolved scope (the latter null
 * for the combined "All seniors" view). `historyNextCursor` is null on
 * the last page of completed visits.
 */
export const FamilyVisitsDashboardResponseSchema = z
  .object({
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH).nullable(),
    windowDays: DashboardWindowDaysSchema,
    upcoming: z.array(BookingResponseSchema),
    history: z.array(DashboardPastVisitSchema),
    historyNextCursor: z.string().min(1).max(DASHBOARD_HISTORY_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type FamilyVisitsDashboardResponse = z.infer<typeof FamilyVisitsDashboardResponseSchema>;
