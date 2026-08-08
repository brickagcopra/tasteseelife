import { z } from 'zod';

/**
 * Trust & Safety domain events (TS-301a; PRD §10.14; PDD §7.4, §16.1;
 * CLAUDE.md §5.3).
 *
 * `trust_safety.incident.created` — emitted by `service-trust-safety` when
 * an incident row is inserted (today: the authenticated "Report a concern"
 * intake, TS-301a; later: the TS-302 event-driven escalation paths — the
 * same insert seam emits regardless of source).
 *
 * **Why an event, not a direct call.** The incident insert is a
 * trust-safety-side state change; "tell the ops queue / notify staff /
 * acknowledge the filer" are cross-service concerns owned by their own
 * consumers (TS-302 owns escalation + notification routing — the consumers
 * are carved per the seam-and-stub steer). The producer appends this event
 * to `trust_safety.outbox_events` *inside the same Prisma transaction as
 * the insert* (CLAUDE.md §5.3 outbox pattern), so a created incident is
 * guaranteed to have durably queued its signal and a rolled-back intake
 * never emits. Consumers are idempotent on `eventId`.
 *
 * **No free text.** The payload names ids + triage facts only — the report
 * `description` a family member typed may carry names, health details, or
 * allegations (PII/PHI) and NEVER rides an event; consumers that need it
 * read the incident row through an authorised surface (CLAUDE.md §3.9,
 * §10).
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The constant
 * is the single source of truth — services import the literal, so a rename
 * is a TS error at every call site.
 */
export const TRUST_SAFETY_INCIDENT_CREATED = 'trust_safety.incident.created' as const;

/** Soft id cap — incident/household/senior ids are CUID-shaped; 64 leaves headroom. */
export const TRUST_SAFETY_EVENT_ID_MAX_LENGTH = 64;

/** Mirrors `trust_safety.incident_severity` (TS-300). */
export const TrustSafetyEventSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type TrustSafetyEventSeverity = z.infer<typeof TrustSafetyEventSeveritySchema>;

/** Mirrors `trust_safety.incident_source` (TS-300). */
export const TrustSafetyEventSourceSchema = z.enum([
  'family',
  'senior',
  'provider',
  'concierge',
  'system',
]);
export type TrustSafetyEventSource = z.infer<typeof TrustSafetyEventSourceSchema>;

/** Mirrors `trust_safety.incident_category` (TS-300). */
export const TrustSafetyEventCategorySchema = z.enum(['welfare', 'safety', 'billing', 'conduct']);
export type TrustSafetyEventCategory = z.infer<typeof TrustSafetyEventCategorySchema>;

/**
 * Common event envelope — every event carries `eventId` (consumer dedup key
 * per CLAUDE.md §5.3) and `occurredAt` (producer wall-clock timestamp).
 * Same shape as the audit / booking / content / identity-rbac events.
 */
const TrustSafetyEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * `trust_safety.incident.created` payload — one opened incident.
 *
 *   - `incidentId` — the `trust_safety.incidents` row (the consumer's key
 *     for any authorised detail read).
 *   - `category` / `severity` / `source` — the triage facts as inserted
 *     (severity is the intake DEFAULT — TS-302 triage may re-grade; the
 *     event marks creation, not final triage).
 *   - `householdId` — the household the concern is scoped to (null on
 *     future non-household sources, e.g. `system`-ingested flags).
 *   - `seniorId` — the senior the concern is about, when the filer named
 *     one (soft reference).
 *   - `openedAt` / `slaDueAt` — creation moment + the SLA deadline computed
 *     at insert (TS-300 budgets; the TS-306 breach sweep hangs off the row,
 *     not this event).
 */
export const TrustSafetyIncidentCreatedSchema = TrustSafetyEventEnvelopeSchema.extend({
  incidentId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH),
  category: TrustSafetyEventCategorySchema,
  severity: TrustSafetyEventSeveritySchema,
  source: TrustSafetyEventSourceSchema,
  householdId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH).nullable(),
  seniorId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH).nullable(),
  openedAt: z.string().datetime({ offset: true }),
  slaDueAt: z.string().datetime({ offset: true }),
}).strict();
export type TrustSafetyIncidentCreated = z.infer<typeof TrustSafetyIncidentCreatedSchema>;

/**
 * `trust_safety.booking_hold.requested` / `.released` (TS-304; PRD §10.14;
 * PDD §16.1; CLAUDE.md §5.3, §12).
 *
 * The signal that suspends a subject's bookings while a serious concern is
 * under review, and the signal that lifts the suspension when the review
 * committee closes it. Emitted by `service-trust-safety` from inside the
 * incident-open / incident-resolve transactions; consumed by
 * `service-booking`, which owns what "suspended" means to a booking.
 *
 * **Why a pair of dedicated events rather than reusing
 * `trust_safety.incident.created`.** Three reasons, each load-bearing:
 *
 *   1. `incident.created` fires for EVERY incident at every severity. A
 *      consumer keyed on it would have to re-implement trust & safety's
 *      severity policy to know which ones matter — a second copy of a
 *      policy that decides whether a family's visits stop, living in the
 *      service that has no business owning it.
 *   2. `incident.created` deliberately omits `providerId`. It was designed
 *      for consumers that key on the household; a hold must also reach a
 *      PROVIDER's bookings, and widening a shipped event's meaning to
 *      carry a new subject is exactly the "repurposing" CLAUDE.md §5.3
 *      forbids.
 *   3. There is no "un-create". The release half has no counterpart on the
 *      creation event at all, and a hold that cannot be lifted is worse
 *      than no hold.
 *
 * **Why an event rather than an authenticated call into service-booking.**
 * An incident must not fail to open because service-booking is down
 * (CLAUDE.md §12 — a welfare concern is never dropped), and the hold must
 * survive a redelivery. The outbox gives both: the signal commits in the
 * same transaction as the incident, and the consumer is idempotent on
 * `eventId`.
 *
 * **No free text, and no severity policy on the wire.** The payload names
 * ids + the severity that triggered it. The filer's `description` is a
 * family's account of a named senior (PII/PHI) and never rides an event;
 * `service-booking` does not need it to stop a visit, and the operator
 * console reads it through an authorised surface instead.
 *
 * **At least one subject is REQUIRED — enforced in the schema.** An
 * incident's provider / senior / household references are each
 * independently nullable (a billing report names no provider; a
 * system-ingested flag may name no household). A hold event carrying none
 * of the three does not describe a narrow suspension — it describes a
 * platform-wide freeze, which is the worst possible reading of a
 * malformed payload. The `superRefine` below makes that shape
 * unrepresentable, so the producer fails its own outbox append (aborting
 * the incident insert, loudly) rather than publishing an ambiguous stop
 * order.
 */
export const TRUST_SAFETY_BOOKING_HOLD_REQUESTED = 'trust_safety.booking_hold.requested' as const;
export const TRUST_SAFETY_BOOKING_HOLD_RELEASED = 'trust_safety.booking_hold.released' as const;

/**
 * The subject fields shared by both halves of the pair, plus the invariant
 * that at least one of them is present. Split out so the requested/released
 * schemas cannot drift on the part that decides WHO is held.
 */
const TrustSafetyBookingHoldSubjectShape = {
  /** Soft reference to `provider.providers.id` — the implicated provider. */
  providerId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH).nullable(),
  /** Soft reference to `household.seniors.id` — the senior concerned. */
  seniorId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH).nullable(),
  /** Soft reference to `household.households.id` — the household concerned. */
  householdId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH).nullable(),
} as const;

/** Message used by both refinements so producer + consumer read identically. */
export const TRUST_SAFETY_BOOKING_HOLD_NO_SUBJECT_MESSAGE =
  'a booking hold must name at least one of providerId / seniorId / householdId — a subjectless hold would suspend the whole platform';

function refineHoldHasSubject(
  value: {
    readonly providerId: string | null;
    readonly seniorId: string | null;
    readonly householdId: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.providerId === null && value.seniorId === null && value.householdId === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerId'],
      message: TRUST_SAFETY_BOOKING_HOLD_NO_SUBJECT_MESSAGE,
    });
  }
}

/**
 * `trust_safety.booking_hold.requested` payload.
 *
 *   - `incidentId` — the hold's REASON and its identity. `service-booking`
 *     records it on every row it suspends, so "why is this visit on hold"
 *     is answerable from the booking row alone, and so the release can
 *     find exactly the rows this incident stopped.
 *   - `severity` — the grade that triggered the hold, carried for the
 *     consumer's logs and for the family-facing copy decision. The
 *     PREDICATE (which severities hold) is trust & safety's, applied
 *     before this event is emitted; the consumer must not re-derive it.
 *   - `providerId` / `seniorId` / `householdId` — the subjects to suspend;
 *     at least one is non-null (see above). A hold applies to every named
 *     subject independently.
 *   - `requestedAt` — when the incident opened. Distinct from
 *     `occurredAt` only in a backfill, where the hold's clock should be
 *     the incident's, not the publisher's.
 */
export const TrustSafetyBookingHoldRequestedSchema = TrustSafetyEventEnvelopeSchema.extend({
  incidentId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH),
  severity: TrustSafetyEventSeveritySchema,
  category: TrustSafetyEventCategorySchema,
  ...TrustSafetyBookingHoldSubjectShape,
  requestedAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine(refineHoldHasSubject);
export type TrustSafetyBookingHoldRequested = z.infer<typeof TrustSafetyBookingHoldRequestedSchema>;

/**
 * `trust_safety.booking_hold.released` payload.
 *
 * Carries the same subject triple as the requested half — deliberately,
 * even though `incidentId` alone would identify the rows to clear. The
 * consumer needs the subjects to answer the question that actually
 * matters on release: "is this booking still held by some OTHER open
 * incident?". Re-deriving the subjects from its own hold rows would work
 * only if the requested event was never lost; carrying them makes the
 * release self-describing and lets a consumer that missed the request
 * still converge.
 *
 *   - `releasedAt` — when the incident was resolved (the committee's
 *     decision moment, not the publisher's).
 */
export const TrustSafetyBookingHoldReleasedSchema = TrustSafetyEventEnvelopeSchema.extend({
  incidentId: z.string().min(1).max(TRUST_SAFETY_EVENT_ID_MAX_LENGTH),
  severity: TrustSafetyEventSeveritySchema,
  category: TrustSafetyEventCategorySchema,
  ...TrustSafetyBookingHoldSubjectShape,
  releasedAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine(refineHoldHasSubject);
export type TrustSafetyBookingHoldReleased = z.infer<typeof TrustSafetyBookingHoldReleasedSchema>;
