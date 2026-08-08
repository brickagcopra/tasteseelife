import { z } from 'zod';

import {
  CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH,
  CONCIERGE_TICKET_ID_MAX_LENGTH,
  CONCIERGE_TICKET_PARTY_SIZE_MAX,
  CONCIERGE_TICKET_PARTY_SIZE_MIN,
  CONCIERGE_TICKET_USER_ID_MAX_LENGTH,
} from './concierge-ticket.schema';

/**
 * Concierge scheduled-event HTTP DTOs (TS-227; PRD §5.1 Tier 3 "social
 * outings · event dining", §6.6; PDD §10.6).
 *
 * The back-office surface where a concierge schedules the actual experience
 * that fulfils a Tier-3 household's request: a restaurant reservation, a
 * museum / cultural event, or a group outing. Where TS-223/TS-224 are the
 * REQUEST side (a family submits a `museum_outing` ticket; ops triages it on
 * the console), this module is the FULFILMENT side — the concrete booked
 * event with a venue, a time, a party size, and a confirmation reference.
 *
 * A scheduled event optionally links to the originating `concierge_tickets`
 * row (`ticketId`) so the request → fulfilment chain is traceable; it may
 * also be concierge-initiated with no ticket (proactive Tier-3 enrichment).
 *
 * **Scaffold, not a live integration (Phase 1).** `externalProvider` is the
 * adapter seam — `manual` (the concierge booked by phone / in person, the
 * Phase-1 default) vs `opentable` / `museum` (a live partner API, wired in
 * Phase 3 — TS-227-followup-5, requires an SDK ADR). `externalReference`
 * holds the confirmation / reservation number regardless of source. No
 * external SDK is imported here; the seam lets Phase 3 land without a schema
 * change.
 *
 * **Authorisation.** Every endpoint that consumes these DTOs is gated on a
 * concierge permission (CLAUDE.md §3.2): `concierge:read` for the list,
 * `concierge:write` for the schedule / update mutations — the same
 * permissions TS-224 added to the RBAC catalog (no new permission here). The
 * gateway BFF + service-concierge both enforce the gate (defence-in-depth).
 *
 * **Actor is global-scoped.** The acting ops staff member holds a `global`
 * scope, so the create body carries the target `householdId` explicitly (no
 * household crosses via a token claim, unlike the family-side TS-223 submit).
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID/CUID2-shaped scheduled-event row id cap. */
export const CONCIERGE_EVENT_ID_MAX_LENGTH = CONCIERGE_TICKET_ID_MAX_LENGTH;

/** Short event title shown on the ops list (e.g. "Sunday lunch at Carbone"). */
export const CONCIERGE_EVENT_TITLE_MAX_LENGTH = 160;

/** Venue name (restaurant, museum, venue). */
export const CONCIERGE_EVENT_VENUE_NAME_MAX_LENGTH = 200;

/** Venue address / location free-text. */
export const CONCIERGE_EVENT_VENUE_ADDRESS_MAX_LENGTH = 400;

/** Concierge scheduling notes (logistics, accessibility, preferences). */
export const CONCIERGE_EVENT_NOTES_MAX_LENGTH = 4000;

/** External confirmation / reservation reference from the booking source. */
export const CONCIERGE_EVENT_EXTERNAL_REFERENCE_MAX_LENGTH = 200;

/** Ops scheduled-events list caps. Bounded, no cursor (Phase 1 — followup). */
export const CONCIERGE_EVENTS_LIST_LIMIT_DEFAULT = 50;
export const CONCIERGE_EVENTS_LIST_LIMIT_MAX = 200;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Scheduled-event category — mirrors the `ConciergeEventKind` Prisma enum.
 * The three Tier-3 experience types PRD §5.1 names ("social outings · event
 * dining"). Additive only — new kinds arrive via `ALTER TYPE … ADD VALUE`.
 *
 *   `restaurant_reservation` = a dining reservation (the family-portal
 *                              `holiday_dinner` / `birthday_experience` /
 *                              `memory_meal` requests typically fulfil here).
 *   `cultural_event`         = a museum / theatre / concert / cultural outing
 *                              (the `museum_outing` request fulfils here).
 *   `group_outing`           = a social outing for a group (a `tea_social`,
 *                              or any concierge-arranged gathering).
 */
export const ConciergeEventKindSchema = z.enum([
  'restaurant_reservation',
  'cultural_event',
  'group_outing',
]);
export type ConciergeEventKind = z.infer<typeof ConciergeEventKindSchema>;

/**
 * Scheduled-event lifecycle status — mirrors the `ConciergeEventStatus`
 * Prisma enum. `proposed` (drafted, not yet confirmed with the venue) →
 * `confirmed` (the reservation is locked) → `completed` (the event happened);
 * `canceled` is reachable from either non-terminal state. `completed` and
 * `canceled` are terminal.
 */
export const ConciergeEventStatusSchema = z.enum([
  'proposed',
  'confirmed',
  'completed',
  'canceled',
]);
export type ConciergeEventStatus = z.infer<typeof ConciergeEventStatusSchema>;

/**
 * The status a concierge may set at SCHEDULE time — only the two non-terminal
 * entry states. A concierge cannot create an event straight into `completed`
 * or `canceled` (those are transitions from a live event).
 */
export const InitialConciergeEventStatusSchema = z.enum(['proposed', 'confirmed']);
export type InitialConciergeEventStatus = z.infer<typeof InitialConciergeEventStatusSchema>;

/**
 * Booking source — the Phase-3 adapter seam. `manual` is the Phase-1 default
 * (the concierge booked the event by phone / in person). `opentable` /
 * `museum` name the live partner integrations wired in Phase 3
 * (TS-227-followup-5; requires an SDK ADR per CLAUDE.md §13). Additive only.
 */
export const ConciergeEventExternalProviderSchema = z.enum(['manual', 'opentable', 'museum']);
export type ConciergeEventExternalProvider = z.infer<typeof ConciergeEventExternalProviderSchema>;

// ─── Status-transition policy ───────────────────────────────────────────

/**
 * Allowed status transitions, keyed by the current status. `completed` +
 * `canceled` are terminal (no outbound transitions). Shared between the
 * service (enforces the matrix) and the web-admin UI (renders only the valid
 * actions) so the two never drift.
 */
export const CONCIERGE_EVENT_STATUS_TRANSITIONS = {
  proposed: ['confirmed', 'canceled'],
  confirmed: ['completed', 'canceled'],
  completed: [],
  canceled: [],
} as const satisfies Record<ConciergeEventStatus, readonly ConciergeEventStatus[]>;

/** `true` when `from → to` is an allowed scheduled-event transition. */
export function canTransitionConciergeEvent(
  from: ConciergeEventStatus,
  to: ConciergeEventStatus,
): boolean {
  return (CONCIERGE_EVENT_STATUS_TRANSITIONS[from] as readonly ConciergeEventStatus[]).includes(to);
}

/** Terminal statuses — no further transition, no field edits. */
export const CONCIERGE_EVENT_TERMINAL_STATUSES = ['completed', 'canceled'] as const;

/** `true` when the event can no longer be acted on (completed / canceled). */
export function isConciergeEventTerminal(status: ConciergeEventStatus): boolean {
  return (CONCIERGE_EVENT_TERMINAL_STATUSES as readonly ConciergeEventStatus[]).includes(status);
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONCIERGE_EVENT_ID_MAX_LENGTH);
const HouseholdIdSchema = z.string().min(1).max(CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH);
const TicketIdSchema = z.string().min(1).max(CONCIERGE_TICKET_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(CONCIERGE_TICKET_USER_ID_MAX_LENGTH);
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'a title is required')
  .max(CONCIERGE_EVENT_TITLE_MAX_LENGTH);
const VenueNameSchema = z.string().trim().min(1).max(CONCIERGE_EVENT_VENUE_NAME_MAX_LENGTH);
const VenueAddressSchema = z.string().trim().min(1).max(CONCIERGE_EVENT_VENUE_ADDRESS_MAX_LENGTH);
const NotesSchema = z.string().trim().min(1).max(CONCIERGE_EVENT_NOTES_MAX_LENGTH);
const ExternalReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONCIERGE_EVENT_EXTERNAL_REFERENCE_MAX_LENGTH);
const PartySizeSchema = z
  .number()
  .int()
  .min(CONCIERGE_TICKET_PARTY_SIZE_MIN)
  .max(CONCIERGE_TICKET_PARTY_SIZE_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shape ───────────────────────────────────────────────────────

/**
 * Full scheduled-event record returned by the list + schedule + update
 * endpoints.
 *
 *   - `ticketId` — the originating `concierge_tickets` row when the event
 *     fulfils a family request; null for a concierge-initiated event.
 *   - `scheduledStart` / `scheduledEnd` — full timestamps (an event happens
 *     at a specific time, unlike a ticket's date-only `requestedDate`).
 *     `scheduledEnd` is null when only a start time is known.
 *   - `externalProvider` / `externalReference` — the booking-source seam.
 *   - `createdByUserId` — the concierge who scheduled it (from the token).
 */
export const ConciergeScheduledEventRecordSchema = z
  .object({
    id: IdSchema,
    householdId: HouseholdIdSchema,
    ticketId: TicketIdSchema.nullable(),
    kind: ConciergeEventKindSchema,
    status: ConciergeEventStatusSchema,
    title: TitleSchema,
    venueName: VenueNameSchema.nullable(),
    venueAddress: VenueAddressSchema.nullable(),
    scheduledStart: TimestampSchema,
    scheduledEnd: TimestampSchema.nullable(),
    partySize: PartySizeSchema.nullable(),
    externalProvider: ConciergeEventExternalProviderSchema,
    externalReference: ExternalReferenceSchema.nullable(),
    notes: NotesSchema.nullable(),
    createdByUserId: UserIdSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ConciergeScheduledEventRecord = z.infer<typeof ConciergeScheduledEventRecordSchema>;

// ─── Schedule (create) ──────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/concierge/scheduled-events` body — schedule a new
 * event. `householdId` is required (the ops actor is global-scoped). When
 * `ticketId` is supplied the service verifies the ticket exists AND belongs
 * to the same household (a mismatch is a 409). `status` defaults to
 * `proposed`; a concierge may schedule directly as `confirmed`. When
 * `scheduledEnd` is supplied it must be after `scheduledStart`.
 */
export const ScheduleConciergeEventRequestSchema = z
  .object({
    householdId: HouseholdIdSchema,
    ticketId: TicketIdSchema.optional(),
    kind: ConciergeEventKindSchema,
    title: TitleSchema,
    venueName: VenueNameSchema.optional(),
    venueAddress: VenueAddressSchema.optional(),
    scheduledStart: TimestampSchema,
    scheduledEnd: TimestampSchema.optional(),
    partySize: PartySizeSchema.optional(),
    externalProvider: ConciergeEventExternalProviderSchema.default('manual'),
    externalReference: ExternalReferenceSchema.optional(),
    notes: NotesSchema.optional(),
    status: InitialConciergeEventStatusSchema.default('proposed'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scheduledEnd !== undefined && !isAfter(value.scheduledEnd, value.scheduledStart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledEnd'],
        message: 'scheduledEnd must be after scheduledStart',
      });
    }
  });
export type ScheduleConciergeEventRequest = z.infer<typeof ScheduleConciergeEventRequestSchema>;

/** `POST .../scheduled-events` response — the newly-scheduled event. */
export const ScheduleConciergeEventResponseSchema = z
  .object({
    event: ConciergeScheduledEventRecordSchema,
  })
  .strict();
export type ScheduleConciergeEventResponse = z.infer<typeof ScheduleConciergeEventResponseSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/concierge/scheduled-events/:eventId` body — a partial
 * update. At least one field must be present. Nullable fields (`venueName`,
 * `venueAddress`, `scheduledEnd`, `partySize`, `externalReference`, `notes`)
 * accept `null` to CLEAR the value. `kind` is NOT editable — a different
 * experience type is a different event.
 *
 * `status`, when present, must be an allowed transition from the event's
 * current status (validated server-side; a disallowed move is a 409). A
 * terminal event (completed / canceled) rejects all edits (409). When both
 * `scheduledStart` and `scheduledEnd` are present in the request,
 * `scheduledEnd` must be after `scheduledStart`; the service additionally
 * re-checks the merged pair after applying the partial.
 */
export const UpdateConciergeEventRequestSchema = z
  .object({
    title: TitleSchema.optional(),
    venueName: VenueNameSchema.nullable().optional(),
    venueAddress: VenueAddressSchema.nullable().optional(),
    scheduledStart: TimestampSchema.optional(),
    scheduledEnd: TimestampSchema.nullable().optional(),
    partySize: PartySizeSchema.nullable().optional(),
    externalProvider: ConciergeEventExternalProviderSchema.optional(),
    externalReference: ExternalReferenceSchema.nullable().optional(),
    notes: NotesSchema.nullable().optional(),
    status: ConciergeEventStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one field must be supplied',
      });
    }
    if (
      value.scheduledStart !== undefined &&
      value.scheduledEnd !== undefined &&
      value.scheduledEnd !== null &&
      !isAfter(value.scheduledEnd, value.scheduledStart)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledEnd'],
        message: 'scheduledEnd must be after scheduledStart',
      });
    }
  });
export type UpdateConciergeEventRequest = z.infer<typeof UpdateConciergeEventRequestSchema>;

/** `PATCH .../scheduled-events/:eventId` response — the updated event. */
export const UpdateConciergeEventResponseSchema = z
  .object({
    event: ConciergeScheduledEventRecordSchema,
  })
  .strict();
export type UpdateConciergeEventResponse = z.infer<typeof UpdateConciergeEventResponseSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/concierge/scheduled-events` query. With no filters the
 * list returns events across every household ordered by `scheduledStart`
 * (soonest first). `householdId` / `ticketId` narrow to one household or one
 * originating request; `status` / `kind` narrow by lifecycle / type;
 * `upcomingOnly=true` drops events whose start is in the past.
 */
export const ListConciergeScheduledEventsQuerySchema = z
  .object({
    householdId: HouseholdIdSchema.optional(),
    ticketId: TicketIdSchema.optional(),
    status: ConciergeEventStatusSchema.optional(),
    kind: ConciergeEventKindSchema.optional(),
    upcomingOnly: z.coerce.boolean().optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_EVENTS_LIST_LIMIT_MAX)
      .default(CONCIERGE_EVENTS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListConciergeScheduledEventsQuery = z.infer<
  typeof ListConciergeScheduledEventsQuerySchema
>;

/**
 * `GET /api/v1/admin/concierge/scheduled-events` response — the matching
 * events ordered by `scheduledStart` ascending. Bounded by `limit`; no cursor
 * at Phase-1 volume (followup carries cursor pagination).
 */
export const ConciergeScheduledEventsListResponseSchema = z
  .object({
    events: z.array(ConciergeScheduledEventRecordSchema),
  })
  .strict();
export type ConciergeScheduledEventsListResponse = z.infer<
  typeof ConciergeScheduledEventsListResponseSchema
>;

/** `true` when ISO timestamp `a` is strictly after ISO timestamp `b`. */
function isAfter(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}
