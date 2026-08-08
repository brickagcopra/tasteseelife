import { z } from 'zod';

import {
  ConciergeEscalationPathSchema,
  ConciergeTicketKindSchema,
  ConciergeTicketRecordSchema,
  ConciergeTicketStatusSchema,
  CONCIERGE_TICKET_BODY_MAX_LENGTH,
  CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH,
  CONCIERGE_TICKET_ID_MAX_LENGTH,
  CONCIERGE_TICKET_USER_ID_MAX_LENGTH,
  type ConciergeTicketStatus,
} from './concierge-ticket.schema';

/**
 * Concierge ops-console HTTP DTOs (TS-224; PRD §10.6 "Concierge
 * Operations"; PDD §10.6).
 *
 * The admin/internal-staff surface for working the concierge ticket queue
 * that TS-223 fills. Where TS-223 is the family-facing submit + read, this
 * module is the back-office side: a permission-gated queue ordered by SLA
 * proximity, ticket-level status transitions, escalation actions, and an
 * append-only internal-notes timeline.
 *
 * **Authorisation.** Every endpoint that consumes these DTOs is gated on a
 * concierge permission (CLAUDE.md §3.2): `concierge:read` for the queue +
 * detail reads, `concierge:write` for the transition / escalate / add-note
 * mutations. The gateway BFF + service-concierge both enforce the gate
 * (defence-in-depth).
 *
 * **No household id on the wire for reads.** The ops actor holds a global
 * scope, so the queue + detail endpoints read across every household; the
 * optional `householdId` filter narrows to one household when ops is
 * triaging a single family.
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** Free-text internal note body. Same ceiling as the ticket body. */
export const CONCIERGE_OPS_NOTE_BODY_MAX_LENGTH = CONCIERGE_TICKET_BODY_MAX_LENGTH;

/** Ops-queue list caps. Bounded, no cursor (Phase 1 — followup carries cursor). */
export const CONCIERGE_OPS_QUEUE_LIMIT_DEFAULT = 50;
export const CONCIERGE_OPS_QUEUE_LIMIT_MAX = 200;

/** Max internal notes returned in a ticket-detail response. */
export const CONCIERGE_OPS_NOTES_MAX = 200;

// ─── Status-transition policy ───────────────────────────────────────────

/**
 * Allowed ops-initiated status transitions, keyed by the current status.
 *
 * `escalated` is NOT a target here — escalation is its own action (it also
 * sets the routing path) via `POST .../escalate`. `resolved` + `canceled`
 * are terminal: no outbound transitions. A ticket reaches `assigned` only
 * through the TS-223 routing (when the household has a dedicated concierge);
 * ops moves it forward (in_progress / resolved) or sideways (canceled).
 *
 * Shared between the service (enforces the matrix) and the web-admin UI
 * (renders only the valid action buttons), so the two never drift.
 */
export const CONCIERGE_TICKET_STATUS_TRANSITIONS = {
  open: ['in_progress', 'canceled'],
  assigned: ['in_progress', 'canceled'],
  in_progress: ['resolved', 'canceled'],
  escalated: ['in_progress', 'resolved', 'canceled'],
  resolved: [],
  canceled: [],
} as const satisfies Record<ConciergeTicketStatus, readonly ConciergeTicketStatus[]>;

/** `true` when `from → to` is an allowed ops transition. */
export function canTransitionConciergeTicket(
  from: ConciergeTicketStatus,
  to: ConciergeTicketStatus,
): boolean {
  return (CONCIERGE_TICKET_STATUS_TRANSITIONS[from] as readonly ConciergeTicketStatus[]).includes(
    to,
  );
}

/** Terminal statuses — no escalation, no further transition. */
export const CONCIERGE_TICKET_TERMINAL_STATUSES = ['resolved', 'canceled'] as const;

/** `true` when the ticket can no longer be acted on (resolved / canceled). */
export function isConciergeTicketTerminal(status: ConciergeTicketStatus): boolean {
  return (CONCIERGE_TICKET_TERMINAL_STATUSES as readonly ConciergeTicketStatus[]).includes(status);
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONCIERGE_TICKET_ID_MAX_LENGTH);
const HouseholdIdSchema = z.string().min(1).max(CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(CONCIERGE_TICKET_USER_ID_MAX_LENGTH);
const NoteBodySchema = z
  .string()
  .trim()
  .min(1, 'a note body is required')
  .max(CONCIERGE_OPS_NOTE_BODY_MAX_LENGTH);

/**
 * Escalation routing target — the actionable escalation paths. Excludes
 * `standard` (the un-escalated default): escalating TO `standard` would be a
 * de-escalation, which is not an ops action this surface exposes.
 */
export const ConciergeEscalationTargetSchema = z.enum([
  'concierge_lead',
  'ops_manager',
  'trust_safety',
  'emergency_on_call',
]);
export type ConciergeEscalationTarget = z.infer<typeof ConciergeEscalationTargetSchema>;

// ─── Internal note record ───────────────────────────────────────────────

/**
 * Append-only internal note on a concierge ticket (TS-224). Authored by the
 * acting ops staff member; `authorUserId` is the authoritative actor id from
 * the verified token (display-name resolution is a cross-service concern —
 * followup). Notes are never edited or deleted (CLAUDE.md §3.6 spirit — an
 * internal audit trail of ops activity).
 */
export const ConciergeTicketNoteRecordSchema = z
  .object({
    id: IdSchema,
    ticketId: IdSchema,
    authorUserId: UserIdSchema,
    body: z.string().min(1).max(CONCIERGE_OPS_NOTE_BODY_MAX_LENGTH),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ConciergeTicketNoteRecord = z.infer<typeof ConciergeTicketNoteRecordSchema>;

// ─── Queue list ─────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/concierge/tickets` query. With no `status` filter the
 * queue returns the NON-TERMINAL tickets (open / assigned / in_progress /
 * escalated) ordered by SLA proximity — the "what needs attention" view. A
 * `status` filter pins one status (including the terminal ones for review).
 * `escalationPath`, `kind`, and `householdId` narrow further.
 */
export const ListConciergeOpsTicketsQuerySchema = z
  .object({
    status: ConciergeTicketStatusSchema.optional(),
    escalationPath: ConciergeEscalationPathSchema.optional(),
    kind: ConciergeTicketKindSchema.optional(),
    householdId: HouseholdIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_OPS_QUEUE_LIMIT_MAX)
      .default(CONCIERGE_OPS_QUEUE_LIMIT_DEFAULT),
  })
  .strict();
export type ListConciergeOpsTicketsQuery = z.infer<typeof ListConciergeOpsTicketsQuerySchema>;

/**
 * `GET /api/v1/admin/concierge/tickets` response — the queue, ordered by
 * SLA proximity (soonest deadline first). Bounded by `limit`; no cursor at
 * Phase-1 volume (followup carries cursor pagination).
 */
export const ConciergeOpsTicketsListResponseSchema = z
  .object({
    tickets: z.array(ConciergeTicketRecordSchema),
  })
  .strict();
export type ConciergeOpsTicketsListResponse = z.infer<typeof ConciergeOpsTicketsListResponseSchema>;

// ─── Ticket detail (ticket + notes) ─────────────────────────────────────

/**
 * `GET /api/v1/admin/concierge/tickets/:ticketId` response — the full
 * ticket plus its internal-notes timeline (oldest-first). 404 when the id
 * does not resolve (or the row is soft-deleted).
 */
export const ConciergeOpsTicketDetailResponseSchema = z
  .object({
    ticket: ConciergeTicketRecordSchema,
    notes: z.array(ConciergeTicketNoteRecordSchema),
  })
  .strict();
export type ConciergeOpsTicketDetailResponse = z.infer<
  typeof ConciergeOpsTicketDetailResponseSchema
>;

// ─── Status transition ──────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/concierge/tickets/:ticketId/transition` body. Moves
 * the ticket to `targetStatus` (must be allowed by
 * `CONCIERGE_TICKET_STATUS_TRANSITIONS` from the current status). The
 * optional `note` is appended to the internal-notes timeline as a record of
 * why the transition happened.
 */
export const TransitionConciergeTicketRequestSchema = z
  .object({
    targetStatus: ConciergeTicketStatusSchema,
    note: NoteBodySchema.optional(),
  })
  .strict();
export type TransitionConciergeTicketRequest = z.infer<
  typeof TransitionConciergeTicketRequestSchema
>;

/** `POST .../transition` response — the updated ticket. */
export const TransitionConciergeTicketResponseSchema = z
  .object({
    ticket: ConciergeTicketRecordSchema,
  })
  .strict();
export type TransitionConciergeTicketResponse = z.infer<
  typeof TransitionConciergeTicketResponseSchema
>;

// ─── Escalation ─────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/concierge/tickets/:ticketId/escalate` body. Sets the
 * routing `escalationPath` (one of the actionable targets) and moves the
 * ticket to `escalated` (unless already terminal — that's a 409). The
 * optional `note` records the escalation rationale.
 */
export const EscalateConciergeTicketRequestSchema = z
  .object({
    escalationPath: ConciergeEscalationTargetSchema,
    note: NoteBodySchema.optional(),
  })
  .strict();
export type EscalateConciergeTicketRequest = z.infer<typeof EscalateConciergeTicketRequestSchema>;

/** `POST .../escalate` response — the updated ticket. */
export const EscalateConciergeTicketResponseSchema = z
  .object({
    ticket: ConciergeTicketRecordSchema,
  })
  .strict();
export type EscalateConciergeTicketResponse = z.infer<typeof EscalateConciergeTicketResponseSchema>;

// ─── Add internal note ──────────────────────────────────────────────────

/** `POST /api/v1/admin/concierge/tickets/:ticketId/notes` body. */
export const AddConciergeTicketNoteRequestSchema = z
  .object({
    body: NoteBodySchema,
  })
  .strict();
export type AddConciergeTicketNoteRequest = z.infer<typeof AddConciergeTicketNoteRequestSchema>;

/** `POST .../notes` response — the appended note. */
export const AddConciergeTicketNoteResponseSchema = z
  .object({
    note: ConciergeTicketNoteRecordSchema,
  })
  .strict();
export type AddConciergeTicketNoteResponse = z.infer<typeof AddConciergeTicketNoteResponseSchema>;
