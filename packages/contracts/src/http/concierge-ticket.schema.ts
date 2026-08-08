import { z } from 'zod';

/**
 * Concierge custom-request / service-request HTTP DTOs (TS-223; PRD §6.6
 * "Concierge Service Requests"; PDD §10.6).
 *
 * The family-portal Tier-3 surface submits a structured service request —
 * a free-text body plus optional structured fields (requested date, party
 * size, theme) under one of the PRD §6.6 request kinds. `service-concierge`
 * persists it as a `concierge_tickets` row, routes it to the household's
 * active dedicated concierge (the primary from the TS-222 assignment, when
 * one exists), and stamps an SLA deadline from a per-kind policy.
 *
 * Two surfaces share this contract:
 *
 *   1. **Family submit** — `POST /api/v1/concierge/requests`. The actor
 *      token's `tenantScope: {type:'household', householdId}` claim resolves
 *      the household — no household id crosses the wire (the token is the
 *      household-membership trust boundary; service-concierge cannot read
 *      `household.household_members`, CLAUDE.md §2.3).
 *
 *   2. **Family list** — `GET /api/v1/concierge/requests/me`. The
 *      household's submitted requests, newest-first, so the portal can show
 *      a request's status + SLA at a glance.
 *
 * **Request kinds.** The family-submittable subset is the PRD §6.6 catalog:
 * custom request, holiday dinner, birthday experience, grocery stocking,
 * tea social, museum outing, memory meal. `transportation` (TS-226) and
 * `emergency_assistance` (TS-225) are deliberately excluded — they get
 * their own dedicated surfaces with distinct routing + escalation. The full
 * `ConciergeTicketKind` enum (which a record may carry) includes them so a
 * persisted ticket of any kind projects cleanly.
 *
 * **Routing + SLA.** At submission service-concierge looks up the
 * household's active assignment (in-service — both tables live in the
 * `concierge` schema, no cross-service read) and, when present, assigns the
 * ticket to the primary concierge (`status='assigned'`); otherwise the
 * ticket lands `open` in the unassigned queue (TS-224 ops console). The SLA
 * deadline is `now + CONCIERGE_TICKET_SLA_HOURS_BY_KIND[kind]` hours.
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID/CUID2-shaped ticket-row id cap. */
export const CONCIERGE_TICKET_ID_MAX_LENGTH = 64;

/** Soft-FK household id cap — matches `household.households.id`. */
export const CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH = 64;

/** Soft-FK user id cap — matches `identity.users.id` (assigned concierge). */
export const CONCIERGE_TICKET_USER_ID_MAX_LENGTH = 64;

/** Short summary the family + ops queue render as the request title. */
export const CONCIERGE_TICKET_SUBJECT_MAX_LENGTH = 160;

/** Free-text request details. */
export const CONCIERGE_TICKET_BODY_MAX_LENGTH = 4000;

/** Optional theme / occasion descriptor (e.g. "Italian Sunday supper"). */
export const CONCIERGE_TICKET_THEME_MAX_LENGTH = 120;

/** Optional party-size bounds — a single guest up to a large gathering. */
export const CONCIERGE_TICKET_PARTY_SIZE_MIN = 1;
export const CONCIERGE_TICKET_PARTY_SIZE_MAX = 200;

/** Family "my requests" list caps. Low-volume per household — bounded, no cursor (Phase 1). */
export const CONCIERGE_TICKET_LIST_LIMIT_DEFAULT = 50;
export const CONCIERGE_TICKET_LIST_LIMIT_MAX = 200;

/** Requested-date wire format — a calendar date with no time component. */
export const CONCIERGE_TICKET_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Full concierge ticket kind — mirrors the `ConciergeTicketKind` Prisma
 * enum. A record may carry any value; the family submit surface accepts
 * only the {@link FamilySubmittableConciergeTicketKindSchema} subset.
 */
export const ConciergeTicketKindSchema = z.enum([
  'custom_request',
  'holiday_dinner',
  'birthday_experience',
  'grocery_stocking',
  'tea_social',
  'museum_outing',
  'memory_meal',
  'transportation',
  'emergency_assistance',
]);
export type ConciergeTicketKind = z.infer<typeof ConciergeTicketKindSchema>;

/**
 * Family-submittable request kinds — the PRD §6.6 catalog. Excludes
 * `transportation` (TS-226) and `emergency_assistance` (TS-225), which have
 * their own surfaces with dedicated routing + escalation.
 */
export const FamilySubmittableConciergeTicketKindSchema = z.enum([
  'custom_request',
  'holiday_dinner',
  'birthday_experience',
  'grocery_stocking',
  'tea_social',
  'museum_outing',
  'memory_meal',
]);
export type FamilySubmittableConciergeTicketKind = z.infer<
  typeof FamilySubmittableConciergeTicketKindSchema
>;

/**
 * Ticket lifecycle status — mirrors the `ConciergeTicketStatus` Prisma
 * enum. `open` (unassigned queue) → `assigned` (a concierge owns it) →
 * `in_progress` → `escalated`; `resolved` / `canceled` are terminal.
 */
export const ConciergeTicketStatusSchema = z.enum([
  'open',
  'assigned',
  'in_progress',
  'escalated',
  'resolved',
  'canceled',
]);
export type ConciergeTicketStatus = z.infer<typeof ConciergeTicketStatusSchema>;

/** Escalation routing — mirrors the `ConciergeEscalationPath` Prisma enum. */
export const ConciergeEscalationPathSchema = z.enum([
  'standard',
  'concierge_lead',
  'ops_manager',
  'trust_safety',
  'emergency_on_call',
]);
export type ConciergeEscalationPath = z.infer<typeof ConciergeEscalationPathSchema>;

// ─── SLA policy ─────────────────────────────────────────────────────────

/**
 * Per-kind SLA budget in HOURS. Frozen policy constant (TS-223) — ops can
 * later move it to a `service_catalog`-backed config table without a deploy
 * (followup). `sla_due_at` is computed at submission as `now + hours`.
 *
 * Rationale: occasion planning (holiday / birthday) carries the longest
 * runway; routine errands (grocery / tea / museum) the shortest family-side
 * budget; `transportation` (TS-226) + `emergency_assistance` (TS-225) carry
 * the tightest deadlines for when those surfaces land — they aren't
 * family-submittable here but the table is complete so every kind resolves.
 */
export const CONCIERGE_TICKET_SLA_HOURS_BY_KIND = {
  custom_request: 48,
  holiday_dinner: 72,
  birthday_experience: 72,
  grocery_stocking: 24,
  tea_social: 24,
  museum_outing: 48,
  memory_meal: 48,
  transportation: 12,
  emergency_assistance: 1,
} as const satisfies Record<ConciergeTicketKind, number>;

/** Resolve the SLA budget (hours) for a ticket kind. */
export function resolveConciergeTicketSlaHours(kind: ConciergeTicketKind): number {
  return CONCIERGE_TICKET_SLA_HOURS_BY_KIND[kind];
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONCIERGE_TICKET_ID_MAX_LENGTH);
const HouseholdIdSchema = z.string().min(1).max(CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(CONCIERGE_TICKET_USER_ID_MAX_LENGTH);
const SubjectSchema = z
  .string()
  .trim()
  .min(1, 'a subject is required')
  .max(CONCIERGE_TICKET_SUBJECT_MAX_LENGTH);
const BodySchema = z
  .string()
  .trim()
  .min(1, 'request details are required')
  .max(CONCIERGE_TICKET_BODY_MAX_LENGTH);
const ThemeSchema = z.string().trim().min(1).max(CONCIERGE_TICKET_THEME_MAX_LENGTH);
const PartySizeSchema = z
  .number()
  .int()
  .min(CONCIERGE_TICKET_PARTY_SIZE_MIN)
  .max(CONCIERGE_TICKET_PARTY_SIZE_MAX);

/**
 * Calendar-date string (`YYYY-MM-DD`, no time component). Validates the
 * shape AND that the date is real (rejects `2026-02-30`, `2026-13-01`) by
 * round-tripping the components through a UTC `Date`.
 */
const RequestedDateSchema = z
  .string()
  .regex(CONCIERGE_TICKET_DATE_REGEX, 'requestedDate must be a YYYY-MM-DD calendar date')
  .refine((value) => {
    const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
    if (year === undefined || month === undefined || day === undefined) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'requestedDate is not a valid calendar date');

// ─── Record / response shapes ───────────────────────────────────────────

/**
 * Full concierge-ticket record returned by the read + submit endpoints.
 *
 *   - `kind` — any persisted kind (the full enum), so a record projects
 *     cleanly even for the non-family-submittable kinds.
 *   - `status` — `assigned` when the household had an active concierge at
 *     submission; otherwise `open`.
 *   - `assignedToUserId` — the concierge the ticket routed to, or null when
 *     it landed in the unassigned queue.
 *   - `slaDueAt` — the deadline the ops queue (TS-224) orders by.
 *   - `requestedDate` — `YYYY-MM-DD` when supplied; null otherwise.
 */
export const ConciergeTicketRecordSchema = z
  .object({
    id: IdSchema,
    householdId: HouseholdIdSchema,
    kind: ConciergeTicketKindSchema,
    status: ConciergeTicketStatusSchema,
    subject: SubjectSchema,
    body: BodySchema,
    requestedDate: RequestedDateSchema.nullable(),
    partySize: PartySizeSchema.nullable(),
    theme: ThemeSchema.nullable(),
    slaDueAt: z.string().datetime({ offset: true }).nullable(),
    assignedToUserId: UserIdSchema.nullable(),
    escalationPath: ConciergeEscalationPathSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ConciergeTicketRecord = z.infer<typeof ConciergeTicketRecordSchema>;

/**
 * `POST /api/v1/concierge/requests` body — submit a concierge service
 * request. `kind` is restricted to the family-submittable PRD §6.6 catalog;
 * `subject` + `body` are required; the structured fields are optional.
 */
export const SubmitConciergeRequestRequestSchema = z
  .object({
    kind: FamilySubmittableConciergeTicketKindSchema,
    subject: SubjectSchema,
    body: BodySchema,
    requestedDate: RequestedDateSchema.optional(),
    partySize: PartySizeSchema.optional(),
    theme: ThemeSchema.optional(),
  })
  .strict();
export type SubmitConciergeRequestRequest = z.infer<typeof SubmitConciergeRequestRequestSchema>;

/** `POST /api/v1/concierge/requests` response — the created ticket. */
export const SubmitConciergeRequestResponseSchema = z
  .object({
    ticket: ConciergeTicketRecordSchema,
  })
  .strict();
export type SubmitConciergeRequestResponse = z.infer<typeof SubmitConciergeRequestResponseSchema>;

/**
 * `GET /api/v1/concierge/requests/me` query. No household id — the token
 * resolves it. `limit` bounds the page (no cursor at Phase-1 volume).
 */
export const ListMyConciergeRequestsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_TICKET_LIST_LIMIT_MAX)
      .default(CONCIERGE_TICKET_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListMyConciergeRequestsQuery = z.infer<typeof ListMyConciergeRequestsQuerySchema>;

/**
 * `GET /api/v1/concierge/requests/me` response — the household's submitted
 * requests, newest-first.
 */
export const ConciergeTicketsListResponseSchema = z
  .object({
    tickets: z.array(ConciergeTicketRecordSchema),
  })
  .strict();
export type ConciergeTicketsListResponse = z.infer<typeof ConciergeTicketsListResponseSchema>;
