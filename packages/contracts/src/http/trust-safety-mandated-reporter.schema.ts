import { z } from 'zod';

/**
 * Mandated-reporter workflow HTTP DTOs (TS-303b; PRD §10.14, §11.4; PDD
 * §16.1, §16.4; CLAUDE.md §12).
 *
 * The ops-only surface over the statutory pathway for suspected elder abuse.
 * Every route here is gated on `trust_safety:write` at the gateway AND
 * re-checked in the service — none of it is family- or provider-facing, and
 * none of it is reachable from a household-scoped token.
 *
 * **The case row is the tag.** Opening a case IS the act of classifying an
 * incident as suspected abuse/neglect; there is no `suspectedAbuse` boolean
 * anywhere in these shapes, and nothing derives the classification from
 * category or severity. That is a legal judgement made by a trained operator
 * (TS-303a's model doc-block records why auto-derivation was rejected).
 *
 * **Notes fields carry PHI.** `determinationNotes` / `reviewerNotes` /
 * `resolutionNotes` are free text about a specific senior's circumstances.
 * They are persisted, surfaced only through these authorised ops reads, and
 * NEVER carried on an outbox event or a log line (CLAUDE.md §3.9, §10).
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/**
 * Operator narrative on a case: the reportability assessment, the facts
 * relied on, and the filing story. Generous, because "clear documentation"
 * (PDD §16.1) on a statutory filing is the deliverable and a cramped field
 * pushes operators into writing less than the record needs.
 */
export const MANDATED_REPORTER_NOTES_MAX_LENGTH = 8000;

/** Agency confirmation / case number. An operational identifier, not prose. */
export const MANDATED_REPORTER_FILING_REFERENCE_MAX_LENGTH = 200;

/** Free-text closure rationale on an incident. */
export const TRUST_SAFETY_RESOLUTION_NOTES_MAX_LENGTH = 4000;

/** Soft id cap — case / incident ids are CUID-shaped; 64 leaves headroom. */
export const MANDATED_REPORTER_ID_MAX_LENGTH = 64;

/**
 * Case-queue page size. The queue is live statutory work, not an archive:
 * a trust & safety team with more than 200 open elder-abuse cases has a
 * staffing emergency, not a pagination problem. Bounded rather than
 * unbounded because the row count grows without limit over years even
 * though the *open* set does not.
 */
export const MANDATED_REPORTER_CASE_QUEUE_LIMIT_DEFAULT = 50;
export const MANDATED_REPORTER_CASE_QUEUE_LIMIT_MAX = 200;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Mirrors the `trust_safety.mandated_reporter_case_status` DB enum (TS-303a).
 * See the schema doc-block for the lifecycle; the two load-bearing facts are
 * that `not_reportable` is NOT terminal (a negative determination still needs
 * a second pair of eyes) and `signed_off` is the only state that releases the
 * parent incident for resolution.
 */
export const MandatedReporterCaseStatusSchema = z.enum([
  'screening',
  'filing_prep',
  'filed',
  'not_reportable',
  'signed_off',
]);
export type MandatedReporterCaseStatus = z.infer<typeof MandatedReporterCaseStatusSchema>;

/**
 * The subset of statuses a client may ASK for. `screening` is absent by
 * construction: it is the state a case is born in and nothing transitions
 * back into it, so offering it on the wire would only ever produce a 422.
 */
export const MandatedReporterCaseTransitionSchema = z.enum([
  'filing_prep',
  'filed',
  'not_reportable',
  'signed_off',
]);
export type MandatedReporterCaseTransition = z.infer<typeof MandatedReporterCaseTransitionSchema>;

/**
 * The ONLY terminal state, and the only one that releases the parent incident
 * for resolution (CLAUDE.md §12 "Never auto-close").
 */
export const MANDATED_REPORTER_TERMINAL_STATUS = 'signed_off' as const;

/**
 * Permitted case-status transitions — the shared source of truth for the
 * service's legality check AND the admin console's action list (TS-303c2a/b).
 *
 * It lives in `contracts` rather than in either consumer for the same reason
 * `creativeStatusForReviewAction` does: a console that offers a transition the
 * service will reject is a bug on a legal workflow, and a second copy of this
 * matrix is exactly how the two drift. `service-trust-safety`'s local enum
 * module re-exports these rather than redeclaring them.
 *
 * Shape of the workflow:
 *   - `screening` is the entry state and forks on the reportability call —
 *     reportable goes to `filing_prep`, not reportable to `not_reportable`.
 *   - `not_reportable` is NOT terminal. A negative determination still needs a
 *     second pair of eyes; it can also be reversed back to `filing_prep` when
 *     new facts arrive, which is exactly the case a one-way "closed" state
 *     would strand.
 *   - `filed` is reachable only from `filing_prep`: a filing must have been
 *     prepared, and preparation is gated on a VERIFIED jurisdiction, so this
 *     path cannot be walked in a state whose law nobody has checked.
 *   - Everything funnels through `signed_off`, from which nothing exits.
 */
export const MANDATED_REPORTER_STATUS_TRANSITIONS: Readonly<
  Record<MandatedReporterCaseStatus, readonly MandatedReporterCaseStatus[]>
> = Object.freeze({
  screening: ['filing_prep', 'not_reportable'],
  filing_prep: ['filed', 'not_reportable'],
  filed: ['signed_off'],
  not_reportable: ['filing_prep', 'signed_off'],
  signed_off: [],
});

/** Every status, for exhaustive iteration in tests and admin filters. */
export const MANDATED_REPORTER_CASE_STATUSES = Object.freeze(
  Object.keys(MANDATED_REPORTER_STATUS_TRANSITIONS) as MandatedReporterCaseStatus[],
);

export function canAdvanceMandatedReporterCase(
  from: MandatedReporterCaseStatus,
  to: MandatedReporterCaseStatus,
): boolean {
  return MANDATED_REPORTER_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * USPS two-letter codes for the 50 states, DC, and the five inhabited
 * territories. Validates a jurisdiction key at the boundary and populates the
 * kit editor's state list.
 *
 * This list is a postal-code fact, deliberately unlike everything else in the
 * jurisdiction kit: the reporting agency, hotline, and statutory window for
 * each of these codes is legal reference data the platform does NOT author and
 * does not ship a guess for (see `verified` on the jurisdiction record).
 * Membership here means "this is a real jurisdiction code", NEVER "we know
 * this state's reporting law".
 */
export const US_JURISDICTION_CODES = Object.freeze([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'AS',
  'GU',
  'MP',
  'PR',
  'VI',
] as const);

export type UsJurisdictionCode = (typeof US_JURISDICTION_CODES)[number];

const JURISDICTION_CODE_SET: ReadonlySet<string> = new Set(US_JURISDICTION_CODES);

export function isUsJurisdictionCode(value: string): value is UsJurisdictionCode {
  return JURISDICTION_CODE_SET.has(value);
}

/**
 * Mirrors `trust_safety.mandated_reporter_platform_role`. Whether the
 * platform carries a legal duty to report in a given state, may report at its
 * discretion, or — the default and the honest initial value — has not had the
 * question settled by counsel yet.
 */
export const MandatedReporterPlatformRoleSchema = z.enum([
  'mandated',
  'permissive',
  'undetermined',
]);
export type MandatedReporterPlatformRole = z.infer<typeof MandatedReporterPlatformRoleSchema>;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().trim().min(1).max(MANDATED_REPORTER_ID_MAX_LENGTH);

/**
 * USPS two-letter state / territory code. Validated for SHAPE only here; the
 * service checks membership against the real code list and 404s when no
 * jurisdiction kit row exists for the state. Uppercase is not enforced at the
 * boundary — the service normalises, and rejecting `ny` would be pedantry on
 * a surface an operator is typing into during a distressing call.
 */
const StateCodeSchema = z.string().trim().length(2);

const NotesSchema = z.string().trim().min(1).max(MANDATED_REPORTER_NOTES_MAX_LENGTH);

// ─── Request shapes ─────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/trust-safety/mandated-reporter/cases` — route an
 * incident into the statutory pathway.
 *
 * `stateCode` is supplied by the operator rather than derived: it is the
 * senior's state of residence, service-trust-safety cannot read
 * service-household's tables to look it up (CLAUDE.md §2.3), and which state's
 * law governs is a determination a human makes regardless.
 *
 * Idempotent by construction downstream — `mandated_reporter_cases.incident_id`
 * is UNIQUE, so a retry returns the existing case rather than starting a
 * second statutory clock on the same facts.
 */
export const OpenMandatedReporterCaseRequestSchema = z
  .object({
    incidentId: IdSchema,
    stateCode: StateCodeSchema,
    determinationNotes: NotesSchema.optional(),
  })
  .strict();
export type OpenMandatedReporterCaseRequest = z.infer<typeof OpenMandatedReporterCaseRequestSchema>;

/**
 * `POST /api/v1/admin/trust-safety/mandated-reporter/cases/{caseId}/transitions`
 * — advance a case.
 *
 * `filingReference` is required by the service when `to = 'filed'` (a filing
 * is evidenced by its agency reference, and a DB CHECK backstops the pairing
 * with `filed_at`). The conditional requirement is enforced in the service
 * rather than as a Zod refinement so the 400's `detail` names the field in the
 * operator's language.
 */
export const AdvanceMandatedReporterCaseRequestSchema = z
  .object({
    to: MandatedReporterCaseTransitionSchema,
    determinationNotes: NotesSchema.optional(),
    filingReference: z
      .string()
      .trim()
      .min(1)
      .max(MANDATED_REPORTER_FILING_REFERENCE_MAX_LENGTH)
      .optional(),
    reviewerNotes: NotesSchema.optional(),
  })
  .strict();
export type AdvanceMandatedReporterCaseRequest = z.infer<
  typeof AdvanceMandatedReporterCaseRequestSchema
>;

/**
 * `POST /api/v1/admin/trust-safety/incidents/{incidentId}/resolution` — close
 * an incident.
 *
 * This route is why TS-303a's never-auto-close gate stops being inert: it is
 * the first and only path in the platform that sets an incident to `resolved`,
 * and it calls `assertIncidentResolvable` before it does. `resolutionNotes` is
 * required — an incident on this surface does not get closed with a shrug.
 */
export const ResolveIncidentRequestSchema = z
  .object({
    resolutionNotes: z
      .string()
      .trim()
      .min(1, 'a resolution note is required')
      .max(TRUST_SAFETY_RESOLUTION_NOTES_MAX_LENGTH),
  })
  .strict();
export type ResolveIncidentRequest = z.infer<typeof ResolveIncidentRequestSchema>;

// ─── Response shapes ────────────────────────────────────────────────────

/**
 * The ops-facing case record. Unlike the filer-facing intake receipt this is
 * a full operational view — the audience is a trust & safety operator who
 * needs the deadline, the determination, and the signoff state to do the work.
 */
export const MandatedReporterCaseRecordSchema = z
  .object({
    id: IdSchema,
    incidentId: IdSchema,
    stateCode: z.string().length(2),
    status: MandatedReporterCaseStatusSchema,
    openedByUserId: IdSchema,
    openedAt: z.string().datetime({ offset: true }),
    /** Null when the state's statutory window is not yet established. */
    statutoryDueAt: z.string().datetime({ offset: true }).nullable(),
    filedAt: z.string().datetime({ offset: true }).nullable(),
    filingReference: z.string().nullable(),
    determinationNotes: z.string().nullable(),
    reviewerUserId: IdSchema.nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    reviewerNotes: z.string().nullable(),
  })
  .strict();
export type MandatedReporterCaseRecord = z.infer<typeof MandatedReporterCaseRecordSchema>;

export const MandatedReporterCaseResponseSchema = z
  .object({ case: MandatedReporterCaseRecordSchema })
  .strict();
export type MandatedReporterCaseResponse = z.infer<typeof MandatedReporterCaseResponseSchema>;

// ─── Case queue (TS-303c2a) ─────────────────────────────────────────────

/**
 * A queue row. Deliberately NOT `MandatedReporterCaseRecord`: this shape
 * drops `determinationNotes` and `reviewerNotes`.
 *
 * Those two fields are an operator's free-text account of a named senior's
 * suspected abuse — the highest-sensitivity text the platform holds. The
 * detail read carries them because someone working the case needs them; a
 * queue does not. Sending 200 of them to render a list would put that text
 * in a browser cache, a Next.js RSC payload, and any log or error report
 * that captures a response body, for no operator benefit (CLAUDE.md §3.9).
 *
 * Everything an operator triages ON is here: which state, how the clock
 * stands, whether it has been filed, and who has touched it.
 */
export const MandatedReporterCaseSummarySchema = z
  .object({
    id: IdSchema,
    incidentId: IdSchema,
    stateCode: z.string().length(2),
    status: MandatedReporterCaseStatusSchema,
    openedByUserId: IdSchema,
    openedAt: z.string().datetime({ offset: true }),
    /** Null when the state's statutory window is not yet established. */
    statutoryDueAt: z.string().datetime({ offset: true }).nullable(),
    filedAt: z.string().datetime({ offset: true }).nullable(),
    filingReference: z.string().nullable(),
    reviewerUserId: IdSchema.nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type MandatedReporterCaseSummary = z.infer<typeof MandatedReporterCaseSummarySchema>;

/**
 * `GET /api/v1/admin/trust-safety/mandated-reporter/cases` query.
 *
 * `status` is an exact filter. When it is ABSENT the service returns every
 * case that is not `signed_off` — the queue means live work, and a signed-off
 * case is finished. Asking for `?status=signed_off` explicitly reaches the
 * closed ones, so nothing is unreachable; the default just refuses to bury
 * this week's open cases under three years of completed ones.
 *
 * `stateCode` narrows to one jurisdiction — the scroll a compliance reviewer
 * wants after verifying (or withdrawing) a state's kit.
 */
export const ListMandatedReporterCasesQuerySchema = z
  .object({
    status: MandatedReporterCaseStatusSchema.optional(),
    stateCode: StateCodeSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MANDATED_REPORTER_CASE_QUEUE_LIMIT_MAX)
      .default(MANDATED_REPORTER_CASE_QUEUE_LIMIT_DEFAULT),
  })
  .strict();
export type ListMandatedReporterCasesQuery = z.infer<typeof ListMandatedReporterCasesQuerySchema>;

/**
 * `GET .../cases` response.
 *
 * Ordering is a contract, not an implementation detail, so it is stated
 * here: `statutoryDueAt` ascending with NULLS FIRST, then `openedAt`
 * ascending. A null deadline is not "no deadline" — it is "nobody has
 * established this state's statutory window", which is exactly the case most
 * at risk of being missed. It sorts to the top where an operator sees it,
 * rather than to the bottom where it ages quietly.
 */
export const MandatedReporterCaseListResponseSchema = z
  .object({ cases: z.array(MandatedReporterCaseSummarySchema) })
  .strict();
export type MandatedReporterCaseListResponse = z.infer<
  typeof MandatedReporterCaseListResponseSchema
>;

// ─── Jurisdiction kit (TS-303c1) ────────────────────────────────────────

/**
 * A row of the per-state workflow kit. `verified` is the load-bearing field:
 * FALSE means compliance has not reviewed this state against primary sources,
 * and the service refuses to advance any case in that state to `filing_prep`.
 *
 * The platform does not author elder-abuse reporting law — every substantive
 * field here is transcribed from a counsel-reviewed source and attributed via
 * `statuteCitation`. A row with `platformRole: 'undetermined'` is a to-do for
 * the compliance team, not a finding that no duty exists.
 */
export const MandatedReporterJurisdictionRecordSchema = z
  .object({
    stateCode: z.string().length(2),
    agencyName: z.string().nullable(),
    reportingPhone: z.string().nullable(),
    reportingUrl: z.string().nullable(),
    statutoryDeadlineHours: z.number().int().positive().nullable(),
    platformRole: MandatedReporterPlatformRoleSchema,
    statuteCitation: z.string().nullable(),
    verified: z.boolean(),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
    verifiedByUserId: IdSchema.nullable(),
    notes: z.string().nullable(),
  })
  .strict();
export type MandatedReporterJurisdictionRecord = z.infer<
  typeof MandatedReporterJurisdictionRecordSchema
>;

export const MandatedReporterJurisdictionResponseSchema = z
  .object({ jurisdiction: MandatedReporterJurisdictionRecordSchema })
  .strict();
export type MandatedReporterJurisdictionResponse = z.infer<
  typeof MandatedReporterJurisdictionResponseSchema
>;

export const MandatedReporterJurisdictionListResponseSchema = z
  .object({ jurisdictions: z.array(MandatedReporterJurisdictionRecordSchema) })
  .strict();
export type MandatedReporterJurisdictionListResponse = z.infer<
  typeof MandatedReporterJurisdictionListResponseSchema
>;

/**
 * `PUT /api/v1/admin/trust-safety/mandated-reporter/jurisdictions/{stateCode}`
 * — create or edit a state's kit.
 *
 * Every field is nullable-optional so a partially-researched state can be
 * saved in progress; `verified` is deliberately NOT settable here. Attesting
 * that a row is correct is a separate act with its own route, its own
 * attribution, and its own audit action — folding it into a general field
 * update would let it ride along on an unrelated edit.
 */
export const UpsertMandatedReporterJurisdictionRequestSchema = z
  .object({
    agencyName: z.string().trim().min(1).max(200).nullable().optional(),
    reportingPhone: z.string().trim().min(1).max(50).nullable().optional(),
    reportingUrl: z.string().trim().url().max(500).nullable().optional(),
    statutoryDeadlineHours: z.number().int().positive().max(8_760).nullable().optional(),
    platformRole: MandatedReporterPlatformRoleSchema.optional(),
    statuteCitation: z.string().trim().min(1).max(500).nullable().optional(),
    notes: z.string().trim().min(1).max(MANDATED_REPORTER_NOTES_MAX_LENGTH).nullable().optional(),
  })
  .strict();
export type UpsertMandatedReporterJurisdictionRequest = z.infer<
  typeof UpsertMandatedReporterJurisdictionRequestSchema
>;

/**
 * `POST .../jurisdictions/{stateCode}/verification` — attest that a state's
 * kit matches counsel-reviewed sources, or withdraw that attestation.
 *
 * `verified: false` is a first-class operation, not an oversight: reporting
 * law changes by legislative session, and a state whose statute has moved
 * must be pulled out of service (blocking filing prep) rather than left
 * asserting a stale window.
 */
export const SetMandatedReporterJurisdictionVerificationRequestSchema = z
  .object({
    verified: z.boolean(),
    notes: z.string().trim().min(1).max(MANDATED_REPORTER_NOTES_MAX_LENGTH).nullable().optional(),
  })
  .strict();
export type SetMandatedReporterJurisdictionVerificationRequest = z.infer<
  typeof SetMandatedReporterJurisdictionVerificationRequestSchema
>;

/** `POST .../resolution` response (200). */
export const ResolveIncidentResponseSchema = z
  .object({
    incidentId: IdSchema,
    status: z.literal('resolved'),
    resolvedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ResolveIncidentResponse = z.infer<typeof ResolveIncidentResponseSchema>;
