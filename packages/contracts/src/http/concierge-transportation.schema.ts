import { z } from 'zod';

import {
  CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH,
  CONCIERGE_TICKET_ID_MAX_LENGTH,
  CONCIERGE_TICKET_USER_ID_MAX_LENGTH,
} from './concierge-ticket.schema';

/**
 * Concierge transportation-coordination HTTP DTOs (TS-226; PRD §5.1 Tier 3
 * "transportation coordination", §6.6 "Custom requests"; PDD §10.6).
 *
 * The back-office surface where a dedicated concierge arranges a ride for a
 * Tier-3 household — a medical appointment, a museum outing, a social visit —
 * tracks its lifecycle, and overrides / cancels it. Where `ConciergeTicket`
 * (TS-223) is the REQUEST a family submits, a transportation request is the
 * FULFILMENT — the concrete booked ride with a pickup, a dropoff, a scheduled
 * time, and a confirmation reference. The sibling of TS-227 scheduled events
 * (event dining + social outings); transportation is its own surface because
 * a ride carries a distinct lifecycle (a vendor mirrors driver state back via
 * webhook) and distinct fields (pickup / dropoff vs venue).
 *
 * **Scaffold, not a live integration (Phase 1).** `externalProvider` is the
 * adapter seam — `manual` (the Phase-1 default: the concierge booked the ride
 * by phone / a partner app, and drives the lifecycle by hand) vs `uber_health`
 * / `lyft_health` (a live ride-hailing API, wired in Phase 3 — TS-226-followup,
 * which requires an SDK ADR per CLAUDE.md §13 since neither vendor is on the
 * approved-library list). `externalReference` holds the vendor ride id;
 * `externalStatus` holds the raw vendor status string the webhook last mirrored
 * back. No external SDK is imported here; the seam lets Phase 3 land without a
 * schema change. The inbound ride-status webhook (`POST
 * /internal/concierge/transportation/ride-events`) is shared-secret-pinned and
 * ships now as a scaffold — for the `manual` provider it is never called; for
 * the vendor providers it maps the raw vendor status onto our domain lifecycle.
 *
 * **Authorisation.** Every admin endpoint that consumes these DTOs is gated on
 * a concierge permission (CLAUDE.md §3.2): `concierge:read` for the list,
 * `concierge:write` for the schedule / update mutations — the same permissions
 * TS-224 added to the RBAC catalog (no new permission here). The gateway BFF +
 * service-concierge both enforce the gate (defence-in-depth). The inbound
 * webhook is authenticated by a constant-time shared-secret header instead (no
 * user logs in as a ride-hailing edge — webhook auth IS the model, CLAUDE.md
 * §3.5 / §17.8), so it is NOT exposed at the gateway.
 *
 * **Actor is global-scoped.** The acting ops staff member holds a `global`
 * scope, so the create body carries the target `householdId` explicitly (no
 * household crosses via a token claim, unlike the family-side TS-223 submit).
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID/CUID2-shaped transportation-request row id cap. */
export const CONCIERGE_RIDE_ID_MAX_LENGTH = CONCIERGE_TICKET_ID_MAX_LENGTH;

/** Pickup / dropoff address free-text (street, building, suite, instructions). */
export const CONCIERGE_RIDE_ADDRESS_MAX_LENGTH = 400;

/** Trip purpose shown on the ops list (e.g. "Cardiology follow-up"). */
export const CONCIERGE_RIDE_PURPOSE_MAX_LENGTH = 200;

/** Rider display name (the senior travelling). Low-sensitivity — never a phone. */
export const CONCIERGE_RIDE_RIDER_NAME_MAX_LENGTH = 200;

/** Concierge coordination notes (accessibility, mobility aid, escort). */
export const CONCIERGE_RIDE_NOTES_MAX_LENGTH = 4000;

/** Vendor ride id / confirmation reference from the booking source. */
export const CONCIERGE_RIDE_EXTERNAL_REFERENCE_MAX_LENGTH = 200;

/** Raw vendor status string the webhook last mirrored (`accepted`, `arriving`…). */
export const CONCIERGE_RIDE_EXTERNAL_STATUS_MAX_LENGTH = 100;

/** Ops transportation list caps. Bounded, no cursor (Phase 1 — followup). */
export const CONCIERGE_RIDES_LIST_LIMIT_DEFAULT = 50;
export const CONCIERGE_RIDES_LIST_LIMIT_MAX = 200;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Transportation-request lifecycle status — mirrors the `ConciergeRideStatus`
 * Prisma enum. A vendor-agnostic domain lifecycle the webhook adapter maps the
 * raw vendor status onto:
 *
 *   `requested`   = the concierge created the request; not yet booked with a
 *                   provider (a `manual` request a concierge is still arranging).
 *   `scheduled`   = the ride is booked / confirmed for its pickup time.
 *   `in_progress` = the ride is underway (driver en route / rider aboard).
 *   `completed`   = the ride finished (terminal).
 *   `canceled`    = the ride was canceled by the concierge, the family, or the
 *                   vendor (terminal).
 *
 * Additive only — new states arrive via `ALTER TYPE … ADD VALUE`.
 */
export const ConciergeRideStatusSchema = z.enum([
  'requested',
  'scheduled',
  'in_progress',
  'completed',
  'canceled',
]);
export type ConciergeRideStatus = z.infer<typeof ConciergeRideStatusSchema>;

/**
 * The status a concierge may set at SCHEDULE time — only the two non-terminal
 * entry states. A concierge cannot create a request straight into
 * `in_progress` / `completed` / `canceled` (those are transitions from a live
 * ride).
 */
export const InitialConciergeRideStatusSchema = z.enum(['requested', 'scheduled']);
export type InitialConciergeRideStatus = z.infer<typeof InitialConciergeRideStatusSchema>;

/**
 * Booking source — the Phase-3 adapter seam. `manual` is the Phase-1 default
 * (the concierge booked the ride by phone / a partner app and drives the
 * lifecycle by hand). `uber_health` / `lyft_health` name the live ride-hailing
 * integrations wired in Phase 3 (TS-226-followup; requires an SDK ADR per
 * CLAUDE.md §13). Additive only.
 */
export const ConciergeTransportationProviderSchema = z.enum([
  'manual',
  'uber_health',
  'lyft_health',
]);
export type ConciergeTransportationProvider = z.infer<typeof ConciergeTransportationProviderSchema>;

// ─── Status-transition policy ───────────────────────────────────────────

/**
 * Allowed status transitions, keyed by the current status. `completed` +
 * `canceled` are terminal (no outbound transitions). A ride may be canceled
 * from any non-terminal state; `requested` may also jump straight to
 * `in_progress` for an on-demand ride that skips an explicit scheduled step.
 * Shared between the service (enforces the matrix on the concierge PATCH) and
 * the web-admin UI (renders only the valid actions) so the two never drift.
 */
export const CONCIERGE_RIDE_STATUS_TRANSITIONS = {
  requested: ['scheduled', 'in_progress', 'canceled'],
  scheduled: ['in_progress', 'canceled'],
  in_progress: ['completed', 'canceled'],
  completed: [],
  canceled: [],
} as const satisfies Record<ConciergeRideStatus, readonly ConciergeRideStatus[]>;

/** `true` when `from → to` is an allowed transportation-request transition. */
export function canTransitionConciergeRide(
  from: ConciergeRideStatus,
  to: ConciergeRideStatus,
): boolean {
  return (CONCIERGE_RIDE_STATUS_TRANSITIONS[from] as readonly ConciergeRideStatus[]).includes(to);
}

/** Terminal statuses — no further transition, no field edits, no webhook change. */
export const CONCIERGE_RIDE_TERMINAL_STATUSES = ['completed', 'canceled'] as const;

/** `true` when the ride can no longer be acted on (completed / canceled). */
export function isConciergeRideTerminal(status: ConciergeRideStatus): boolean {
  return (CONCIERGE_RIDE_TERMINAL_STATUSES as readonly ConciergeRideStatus[]).includes(status);
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONCIERGE_RIDE_ID_MAX_LENGTH);
const HouseholdIdSchema = z.string().min(1).max(CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH);
const TicketIdSchema = z.string().min(1).max(CONCIERGE_TICKET_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(CONCIERGE_TICKET_USER_ID_MAX_LENGTH);
const AddressSchema = z.string().trim().min(1).max(CONCIERGE_RIDE_ADDRESS_MAX_LENGTH);
const PurposeSchema = z.string().trim().min(1).max(CONCIERGE_RIDE_PURPOSE_MAX_LENGTH);
const RiderNameSchema = z.string().trim().min(1).max(CONCIERGE_RIDE_RIDER_NAME_MAX_LENGTH);
const NotesSchema = z.string().trim().min(1).max(CONCIERGE_RIDE_NOTES_MAX_LENGTH);
const ExternalReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONCIERGE_RIDE_EXTERNAL_REFERENCE_MAX_LENGTH);
const ExternalStatusSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONCIERGE_RIDE_EXTERNAL_STATUS_MAX_LENGTH);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shape ───────────────────────────────────────────────────────

/**
 * Full transportation-request record returned by the list + schedule + update
 * endpoints.
 *
 *   - `ticketId` — the originating `concierge_tickets` row when the ride
 *     fulfils a family request; null for a concierge-initiated ride.
 *   - `scheduledPickupAt` — when the rider needs to be collected (full
 *     timestamp).
 *   - `externalProvider` / `externalReference` — the booking-source seam.
 *   - `externalStatus` — the raw vendor status string the webhook last
 *     mirrored back; null for a `manual` ride (no vendor reports on it).
 *   - `createdByUserId` — the concierge who arranged it (from the token).
 */
export const ConciergeTransportationRequestRecordSchema = z
  .object({
    id: IdSchema,
    householdId: HouseholdIdSchema,
    ticketId: TicketIdSchema.nullable(),
    status: ConciergeRideStatusSchema,
    externalProvider: ConciergeTransportationProviderSchema,
    pickupAddress: AddressSchema,
    dropoffAddress: AddressSchema,
    scheduledPickupAt: TimestampSchema,
    purpose: PurposeSchema.nullable(),
    riderName: RiderNameSchema.nullable(),
    externalReference: ExternalReferenceSchema.nullable(),
    externalStatus: ExternalStatusSchema.nullable(),
    notes: NotesSchema.nullable(),
    createdByUserId: UserIdSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ConciergeTransportationRequestRecord = z.infer<
  typeof ConciergeTransportationRequestRecordSchema
>;

// ─── Schedule (create) ──────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/concierge/transportation` body — arrange a new ride.
 * `householdId` is required (the ops actor is global-scoped). When `ticketId`
 * is supplied the service verifies the ticket exists AND belongs to the same
 * household (a mismatch is a 409). `status` defaults to `requested`; a
 * concierge may schedule directly as `scheduled`. `externalProvider` defaults
 * to `manual`.
 */
export const ScheduleConciergeTransportationRequestSchema = z
  .object({
    householdId: HouseholdIdSchema,
    ticketId: TicketIdSchema.optional(),
    pickupAddress: AddressSchema,
    dropoffAddress: AddressSchema,
    scheduledPickupAt: TimestampSchema,
    purpose: PurposeSchema.optional(),
    riderName: RiderNameSchema.optional(),
    externalProvider: ConciergeTransportationProviderSchema.default('manual'),
    externalReference: ExternalReferenceSchema.optional(),
    notes: NotesSchema.optional(),
    status: InitialConciergeRideStatusSchema.default('requested'),
  })
  .strict();
export type ScheduleConciergeTransportationRequest = z.infer<
  typeof ScheduleConciergeTransportationRequestSchema
>;

/** `POST .../transportation` response — the newly-arranged ride. */
export const ScheduleConciergeTransportationResponseSchema = z
  .object({
    request: ConciergeTransportationRequestRecordSchema,
  })
  .strict();
export type ScheduleConciergeTransportationResponse = z.infer<
  typeof ScheduleConciergeTransportationResponseSchema
>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/concierge/transportation/:requestId` body — a partial
 * update / override / cancel. At least one field must be present. Nullable
 * fields (`purpose`, `riderName`, `externalReference`, `notes`) accept `null`
 * to CLEAR the value. `householdId` and `externalProvider` are NOT editable —
 * a different household / booking source is a different ride.
 *
 * `status`, when present, must be an allowed transition from the request's
 * current status (validated server-side; a disallowed move is a 409). A
 * terminal ride (completed / canceled) rejects all edits (409). Setting
 * `status: 'canceled'` is the concierge cancel path.
 */
export const UpdateConciergeTransportationRequestSchema = z
  .object({
    pickupAddress: AddressSchema.optional(),
    dropoffAddress: AddressSchema.optional(),
    scheduledPickupAt: TimestampSchema.optional(),
    purpose: PurposeSchema.nullable().optional(),
    riderName: RiderNameSchema.nullable().optional(),
    externalReference: ExternalReferenceSchema.nullable().optional(),
    notes: NotesSchema.nullable().optional(),
    status: ConciergeRideStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one field must be supplied',
      });
    }
  });
export type UpdateConciergeTransportationRequest = z.infer<
  typeof UpdateConciergeTransportationRequestSchema
>;

/** `PATCH .../transportation/:requestId` response — the updated ride. */
export const UpdateConciergeTransportationResponseSchema = z
  .object({
    request: ConciergeTransportationRequestRecordSchema,
  })
  .strict();
export type UpdateConciergeTransportationResponse = z.infer<
  typeof UpdateConciergeTransportationResponseSchema
>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/concierge/transportation` query. With no filters the list
 * returns rides across every household ordered by `scheduledPickupAt`
 * (soonest first). `householdId` / `ticketId` narrow to one household or one
 * originating request; `status` / `externalProvider` narrow by lifecycle /
 * booking source; `upcomingOnly=true` drops rides whose pickup is in the past.
 */
export const ListConciergeTransportationQuerySchema = z
  .object({
    householdId: HouseholdIdSchema.optional(),
    ticketId: TicketIdSchema.optional(),
    status: ConciergeRideStatusSchema.optional(),
    externalProvider: ConciergeTransportationProviderSchema.optional(),
    upcomingOnly: z.coerce.boolean().optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_RIDES_LIST_LIMIT_MAX)
      .default(CONCIERGE_RIDES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListConciergeTransportationQuery = z.infer<
  typeof ListConciergeTransportationQuerySchema
>;

/**
 * `GET /api/v1/admin/concierge/transportation` response — the matching rides
 * ordered by `scheduledPickupAt` ascending. Bounded by `limit`; no cursor at
 * Phase-1 volume (followup carries cursor pagination).
 */
export const ConciergeTransportationListResponseSchema = z
  .object({
    requests: z.array(ConciergeTransportationRequestRecordSchema),
  })
  .strict();
export type ConciergeTransportationListResponse = z.infer<
  typeof ConciergeTransportationListResponseSchema
>;

// ─── Inbound ride-status webhook ────────────────────────────────────────

/**
 * `POST /internal/concierge/transportation/ride-events` body — the inbound
 * ride-status webhook a ride-hailing vendor (Uber Health / Lyft Health) POSTs
 * as a ride progresses. The endpoint is shared-secret-pinned (not gateway-
 * exposed); webhook auth IS the model (CLAUDE.md §3.5 / §17.8).
 *
 *   - `externalProvider` — the vendor sending the event. `manual` is rejected
 *     (a manually-coordinated ride has no vendor edge).
 *   - `externalReference` — the vendor ride id, matched against the stored
 *     request's `externalReference`.
 *   - `externalStatus` — the raw vendor status string (`accepted`, `arriving`,
 *     `in_progress`, `completed`, `rider_canceled`…). The service maps it onto
 *     a domain `ConciergeRideStatus` via the per-vendor adapter; an
 *     unrecognised value is stored verbatim but leaves the domain status
 *     unchanged (the scaffold degrades rather than guesses).
 *   - `occurredAt` — when the vendor emitted the event.
 */
export const ConciergeRideStatusWebhookEventSchema = z
  .object({
    externalProvider: ConciergeTransportationProviderSchema,
    externalReference: ExternalReferenceSchema,
    externalStatus: ExternalStatusSchema,
    occurredAt: TimestampSchema,
  })
  .strict();
export type ConciergeRideStatusWebhookEvent = z.infer<typeof ConciergeRideStatusWebhookEventSchema>;

/**
 * The outcome the webhook reports back to the vendor edge.
 *
 *   `applied`            = the domain status changed to a newly-mapped value.
 *   `unchanged`          = the mapped status equalled the current one (no-op).
 *   `unrecognized_status`= the raw vendor status had no domain mapping; the
 *                          raw value is stored but the domain status is left.
 *   `already_terminal`   = the request is completed / canceled; no change.
 *   `not_found`          = no non-deleted request matches (provider, reference).
 */
export const ConciergeRideStatusWebhookOutcomeSchema = z.enum([
  'applied',
  'unchanged',
  'unrecognized_status',
  'already_terminal',
  'not_found',
]);
export type ConciergeRideStatusWebhookOutcome = z.infer<
  typeof ConciergeRideStatusWebhookOutcomeSchema
>;

/** `POST .../ride-events` response — the processing outcome (no request body echoed). */
export const ConciergeRideStatusWebhookResponseSchema = z
  .object({
    received: z.literal(true),
    outcome: ConciergeRideStatusWebhookOutcomeSchema,
    status: ConciergeRideStatusSchema.nullable(),
  })
  .strict();
export type ConciergeRideStatusWebhookResponse = z.infer<
  typeof ConciergeRideStatusWebhookResponseSchema
>;
