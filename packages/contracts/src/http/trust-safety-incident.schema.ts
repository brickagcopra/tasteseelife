import { z } from 'zod';

/**
 * Trust & Safety incident-intake HTTP DTOs (TS-301a; PRD §10.14; PDD §16.1).
 *
 * The "Report a concern" surface: an authenticated household member (family
 * or senior) files a structured concern that opens a trust & safety incident
 * (`trust_safety.incidents`, TS-300). The household is resolved from the
 * token's `tenantScope: {type:'household', householdId}` claim — no
 * household id crosses the wire (the token is the household-membership trust
 * boundary; service-trust-safety cannot read `household.household_members`,
 * CLAUDE.md §2.3 — the same posture as the TS-225 emergency channel).
 *
 * **Receipt, not dossier.** The response is a deliberately minimal receipt
 * (reference id + category + when we opened it). Severity, SLA deadline, and
 * triage status are internal operational facts — exposing them to the filer
 * would leak triage mechanics ("my concern is only `medium`?") and invite
 * distress over internals the family cannot act on. The UI copy carries the
 * reassurance; the reference id is what support needs on a follow-up call.
 *
 * **Provider seam (TS-301b).** The provider-side report adds a
 * `providerId`-bearing variant whose scope resolution (providers carry a
 * `global` token scope, not a household) is its own design decision — that
 * field is deliberately absent here so it lands with its semantics settled,
 * not as dead weight.
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/**
 * Free-text description of the concern. Long enough for a family member to
 * tell the story properly (a welfare concern is not a tweet), bounded so the
 * row and the ops queue stay sane. Stored on the incident; NEVER carried on
 * the `trust_safety.incident.created` event (PII/PHI discipline — the event
 * names ids + triage facts only).
 */
export const TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH = 4000;

/** Soft id cap — senior/incident ids are CUID-shaped; 64 leaves headroom. */
export const TRUST_SAFETY_INCIDENT_ID_MAX_LENGTH = 64;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Concern categories per PDD §16.1 / TS-301. Mirrors the
 * `trust_safety.incident_category` DB enum (TS-300).
 *
 *   `welfare` = a worry about the senior's wellbeing (possible neglect,
 *               abuse, scam, or a concerning change).
 *   `safety`  = a safety or security concern (the home, a visit, a person).
 *   `billing` = a billing or payment concern.
 *   `conduct` = conduct of a provider or other person on the platform.
 */
export const TrustSafetyIncidentCategorySchema = z.enum([
  'welfare',
  'safety',
  'billing',
  'conduct',
]);
export type TrustSafetyIncidentCategory = z.infer<typeof TrustSafetyIncidentCategorySchema>;

// ─── Field schemas ──────────────────────────────────────────────────────

const DescriptionSchema = z
  .string()
  .trim()
  .min(1, 'a description is required — tell us what happened')
  .max(TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH);

const IdSchema = z.string().trim().min(1).max(TRUST_SAFETY_INCIDENT_ID_MAX_LENGTH);

// ─── Request / response shapes ──────────────────────────────────────────

/**
 * `POST /api/v1/trust-safety/incidents` body — file a concern.
 * `category` + `description` are required; `seniorId` optionally names the
 * senior the concern is about (validated only as an id shape — the senior
 * linkage is a soft reference, resolved by the ops queue).
 */
export const ReportConcernRequestSchema = z
  .object({
    category: TrustSafetyIncidentCategorySchema,
    description: DescriptionSchema,
    seniorId: IdSchema.optional(),
  })
  .strict();
export type ReportConcernRequest = z.infer<typeof ReportConcernRequestSchema>;

/**
 * `POST /api/v1/admin/trust-safety/incidents` body — a concierge filing a
 * concern ON BEHALF OF a household (TS-301b).
 *
 * This is the ONLY shape that carries `householdId` in the body, and it exists
 * as a separate schema on a separate route for exactly that reason. On the
 * filer-facing `ReportConcernRequestSchema` path the household is derived from
 * the token scope and a body-supplied household is not merely ignored but
 * rejected (`.strict()`) — that asymmetry is the trust boundary, so the two
 * shapes must never be merged into one optional-field schema.
 *
 * The route is gated on `concierge:write` at the gateway AND re-checked in
 * service-trust-safety (defence in depth), because a body-supplied household
 * id is an authorisation decision, not a validation one.
 *
 * Note there is no `providerId` here and none on the provider path either:
 * a self-asserted provider id would let a reporter pin a concern on someone
 * else. Provider attribution rides `reporter_user_id` + async linkage.
 */
export const AdminReportConcernRequestSchema = z
  .object({
    householdId: IdSchema,
    category: TrustSafetyIncidentCategorySchema,
    description: DescriptionSchema,
    seniorId: IdSchema.optional(),
  })
  .strict();
export type AdminReportConcernRequest = z.infer<typeof AdminReportConcernRequestSchema>;

/**
 * The filer-facing receipt — see the header for why this is minimal
 * (reference id for follow-up, category echo, when we opened it; NO
 * severity / SLA / status internals).
 */
export const ReportConcernReceiptSchema = z
  .object({
    incidentId: IdSchema,
    category: TrustSafetyIncidentCategorySchema,
    openedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ReportConcernReceipt = z.infer<typeof ReportConcernReceiptSchema>;

/** `POST /api/v1/trust-safety/incidents` response (201). */
export const ReportConcernResponseSchema = z
  .object({
    receipt: ReportConcernReceiptSchema,
  })
  .strict();
export type ReportConcernResponse = z.infer<typeof ReportConcernResponseSchema>;

// ─── Operator incident queue + detail (TS-303c2d) ───────────────────────

/**
 * Incident queue page size. Unlike the mandated-reporter queue (whose open
 * set is small by construction), the incident queue is the day-to-day trust &
 * safety worklist and can legitimately run long, so the cap is higher — still
 * bounded, because an unbounded operator read is an outage waiting for a busy
 * week.
 */
export const TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_DEFAULT = 50;
export const TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_MAX = 200;

/** Mirrors `trust_safety.incident_severity` (TS-300). */
export const TrustSafetyIncidentSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type TrustSafetyIncidentSeverity = z.infer<typeof TrustSafetyIncidentSeveritySchema>;

/**
 * Mirrors `trust_safety.incident_status` (TS-300). `resolved` is terminal and
 * reachable only through the resolution route, which consults the
 * never-auto-close gate first.
 */
export const TrustSafetyIncidentStatusSchema = z.enum([
  'open',
  'triaging',
  'awaiting_review',
  'resolved',
]);
export type TrustSafetyIncidentStatus = z.infer<typeof TrustSafetyIncidentStatusSchema>;

/** Mirrors `trust_safety.incident_source` (TS-300). */
export const TrustSafetyIncidentSourceSchema = z.enum([
  'family',
  'senior',
  'provider',
  'concierge',
  'system',
]);
export type TrustSafetyIncidentSource = z.infer<typeof TrustSafetyIncidentSourceSchema>;

/**
 * A queue row. Carries NO `description` and NO `resolutionNotes`.
 *
 * `description` is a family member's free-text account of what they believe
 * happened to a named senior — the single most sensitive string the platform
 * stores. It belongs on the detail read, where one operator is working one
 * incident, and nowhere near a 200-row list that lands in a browser cache, an
 * RSC payload, and any error report that captures a response body (CLAUDE.md
 * §3.9). Same split as the mandated-reporter queue (TS-303c2a).
 *
 * Everything triage turns on is here: what kind of thing it is, how urgent,
 * where the SLA clock stands, and who it concerns.
 */
export const TrustSafetyIncidentSummarySchema = z
  .object({
    id: IdSchema,
    source: TrustSafetyIncidentSourceSchema,
    category: TrustSafetyIncidentCategorySchema,
    severity: TrustSafetyIncidentSeveritySchema,
    status: TrustSafetyIncidentStatusSchema,
    householdId: IdSchema.nullable(),
    seniorId: IdSchema.nullable(),
    providerId: IdSchema.nullable(),
    reporterUserId: IdSchema.nullable(),
    openedAt: z.string().datetime({ offset: true }),
    slaDueAt: z.string().datetime({ offset: true }),
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
    /**
     * Whether a mandated-reporter case has been opened against this incident.
     * A BOOLEAN, not the case: the queue needs to show that an incident is in
     * the statutory pathway (and therefore cannot be closed), and a flag says
     * that without dragging a second confidential record into a list read.
     */
    hasMandatedReporterCase: z.boolean(),
  })
  .strict();
export type TrustSafetyIncidentSummary = z.infer<typeof TrustSafetyIncidentSummarySchema>;

// ─── System evidence (TS-308c-followup-2) ───────────────────────────────

/**
 * Which detector opened a system-sourced incident.
 *
 * Three detectors now open incidents with `source: 'system'` and a NULL
 * `description`, and until this landed an operator opening one saw a
 * category, a severity, a subject and **nothing whatsoever about what
 * happened**. The numbers that justified the incident lived only on the
 * outbox event and in one WARN log line, so a `conduct`/`medium`
 * incident naming a provider could equally have come from any of them.
 *
 * The discriminator is stored separately from the evidence blob as well
 * as inside it: if a stored blob ever fails to parse (a schema evolved,
 * a row was written by an older build), the console must still be able
 * to say WHICH detector opened the incident rather than rendering
 * nothing at all.
 */
export const TrustSafetyIncidentDetectorSchema = z.enum([
  /** TS-307a — an active provider's background check returned adversely. */
  'background_check',
  /** TS-308a — two check-ins further apart than the elapsed time allows. */
  'impossible_travel',
  /** TS-308c — one subject's cancellations breaching a rolling threshold. */
  'mass_cancellation',
]);
export type TrustSafetyIncidentDetector = z.infer<typeof TrustSafetyIncidentDetectorSchema>;

/**
 * The evidence a detector recorded when it opened an incident.
 *
 * **A DISCRIMINATED UNION of explicitly-typed variants, not a free-form
 * bag.** That shape is the whole safety property: free text is exactly
 * what these events refuse to carry (a check-in location is a senior's
 * home address; a cancellation reason says something about a named
 * senior's circumstances), and an open `Record<string, unknown>` would
 * become the channel for it the first time someone wanted "a bit more
 * context". Every field below is a scalar, an opaque id, or a timestamp,
 * named at the contract layer and validated before it is persisted —
 * so a prose sentence cannot be stored here at all.
 *
 * The variants mirror their source events field for field, minus
 * anything the event itself withheld. In particular
 * `impossible_travel` carries NO coordinates, for the reason its event
 * gives: the ids are handles a reviewer resolves inside service-booking,
 * where the permission to see a location already lives.
 *
 * Rendered on the incident detail page, which is gated
 * `trust_safety:write` (TS-303c2d's permission split — the detail is the
 * harder gate because it carries an account of a named senior). The
 * queue does NOT carry it: a list read has no business fetching it, and
 * the projection enforces that in SQL.
 */
export const TrustSafetySystemEvidenceSchema = z.discriminatedUnion('detector', [
  z
    .object({
      detector: z.literal('background_check'),
      backgroundCheckId: IdSchema,
      /**
       * The Checkr status that raised this — the categorical result, never
       * the finding itself. TS-307a's rule holds: what the report SAYS
       * never crosses a service boundary.
       */
      status: z.string().min(1).max(64),
      previousStatus: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  z
    .object({
      detector: z.literal('impossible_travel'),
      previousCheckInId: IdSchema,
      checkInId: IdSchema,
      previousBookingId: IdSchema,
      bookingId: IdSchema,
      distanceMeters: z.number().int().min(0),
      elapsedSeconds: z.number().int().min(1),
      impliedSpeedKph: z.number().nonnegative(),
      thresholdKph: z.number().positive(),
      previousOccurredAt: z.string().datetime(),
      occurredAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      detector: z.literal('mass_cancellation'),
      subjectKind: z.enum(['provider', 'household']),
      windowStart: z.string().datetime(),
      windowEnd: z.string().datetime(),
      canceledBookingCount: z.number().int().min(1),
      distinctCancellationCount: z.number().int().min(1),
      threshold: z.number().int().min(1),
      distinctActorCount: z.number().int().min(0),
      unattributedCount: z.number().int().min(0),
      /**
       * Rows cancelled by platform staff, excluded from every count
       * above (TS-308c-followup-3). Carried rather than dropped: "four
       * cancellations, and eight more by us" and "four cancellations"
       * are different situations, and only the console can tell the
       * reviewer which one they are looking at.
       */
      staffExcludedCount: z.number().int().min(0),
    })
    .strict(),
]);
export type TrustSafetySystemEvidence = z.infer<typeof TrustSafetySystemEvidenceSchema>;

/**
 * The full operator view of one incident — the summary plus the two free-text
 * fields, plus the system-intake trail. Gated harder than the queue; see the
 * route doc-block.
 */
export const TrustSafetyIncidentRecordSchema = TrustSafetyIncidentSummarySchema.extend({
  /** The filer's account. PII/PHI — never on an event or a log line. */
  description: z.string().nullable(),
  resolutionNotes: z.string().nullable(),
  /**
   * The outbox `event_id` that produced this incident, or null for every
   * human-filed report. Surfaced on the detail (not the queue) because it is
   * the handle that ties an incident to the event, the relay log and the
   * producer's own logs — deliberately greppable, per TS-308a.
   */
  // 128, matching the event envelope's own `eventId` bound rather than
  // the 64 the platform's own ids use. A derived event id is a composite
  // — `mass-cancellation:{kind}:{cuid}:{YYYY-MM-DD}` clears 64 on its
  // own — and truncating one here would break the very grep it exists
  // for.
  sourceEventId: z.string().trim().min(1).max(128).nullable(),
  /** Which detector opened it; null for human-filed reports. */
  detector: TrustSafetyIncidentDetectorSchema.nullable(),
  /**
   * What the detector recorded. Null when the incident was human-filed —
   * and ALSO null when a stored blob failed to parse, which is why
   * `detector` is carried separately: the console can still name the
   * detector and say its evidence could not be read, rather than
   * silently rendering an incident with no explanation (the exact
   * failure this field exists to fix).
   */
  systemEvidence: TrustSafetySystemEvidenceSchema.nullable(),
}).strict();
export type TrustSafetyIncidentRecord = z.infer<typeof TrustSafetyIncidentRecordSchema>;

/**
 * `GET /api/v1/admin/trust-safety/incidents` query.
 *
 * `status` absent returns every incident that is not `resolved` — the queue
 * means live work, same convention as the mandated-reporter queue. An
 * explicit `?status=resolved` reaches the closed ones.
 *
 * The three subject filters are the "incidents for household X / senior Y /
 * provider Z" scrolls PDD §16.1's 360-view is built on, and each has its own
 * index (TS-300). `providerId` in particular is what TS-305's Provider 360
 * reads — with the caveat recorded in TS-301b-followup-1 that a
 * provider-FILED incident carries no `provider_id`, so that scroll under-counts
 * until the async linkage lands.
 */
export const ListTrustSafetyIncidentsQuerySchema = z
  .object({
    status: TrustSafetyIncidentStatusSchema.optional(),
    severity: TrustSafetyIncidentSeveritySchema.optional(),
    category: TrustSafetyIncidentCategorySchema.optional(),
    householdId: IdSchema.optional(),
    seniorId: IdSchema.optional(),
    providerId: IdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_MAX)
      .default(TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_DEFAULT),
  })
  .strict();
export type ListTrustSafetyIncidentsQuery = z.infer<typeof ListTrustSafetyIncidentsQuerySchema>;

/**
 * `GET .../incidents` response. Ordered by `slaDueAt` ascending — the
 * partial index `trust_safety_incidents_unresolved_sla_idx` exists for
 * exactly this scan. `slaDueAt` is NOT nullable (every severity has a budget),
 * so unlike the mandated-reporter queue there is no null-ordering question
 * here.
 */
export const TrustSafetyIncidentListResponseSchema = z
  .object({ incidents: z.array(TrustSafetyIncidentSummarySchema) })
  .strict();
export type TrustSafetyIncidentListResponse = z.infer<typeof TrustSafetyIncidentListResponseSchema>;

/** `GET .../incidents/{incidentId}` response. */
export const TrustSafetyIncidentResponseSchema = z
  .object({ incident: TrustSafetyIncidentRecordSchema })
  .strict();
export type TrustSafetyIncidentResponse = z.infer<typeof TrustSafetyIncidentResponseSchema>;
