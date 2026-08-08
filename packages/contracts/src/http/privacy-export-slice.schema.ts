import { z } from 'zod';

import { DataSubjectKindSchema } from './privacy-data-subject-request.schema';

/**
 * Privacy export **contribution seam** (TS-309b; PRD §11.4; PDD §16.3;
 * CLAUDE.md §2.3, §3.5, §7.2).
 *
 * TS-309a modelled the *request*. This models the *answer*: the shape every
 * owning service returns when asked "everything you hold about this subject",
 * over an internal, shared-secret-gated route
 * (`GET /api/v1/internal/privacy/export/{subjectKind}/{subjectId}`) — the same
 * convention the visit-prep snapshot and the certification-renewal projector
 * already use.
 *
 * **Why a seam at all.** Personal data on this platform is spread across ~21
 * services and CLAUDE.md §2.3 forbids reaching across their schemas, so an
 * export is necessarily a fan-out: each service answers for its own tables and
 * an aggregator assembles the artefact (TS-309b's second half). This contract
 * is the thing that has to be right ONCE, because every service will mirror it.
 *
 * Three properties are deliberately built into the shape rather than left to
 * each service's discretion:
 *
 * 1. **"Nothing" has two meanings and they are not interchangeable.** A service
 *    that has never held data about seniors is a different fact from one that
 *    holds senior data and found none for *this* senior. The first is
 *    structural and the aggregator can note it once; the second is an answer to
 *    the request. Collapsing them into "empty array" loses the distinction a
 *    regulator is actually asking about, so `outcome` is a discriminator.
 *
 * 2. **A withholding is declared, never silent.** Some columns must not travel
 *    into an export ZIP — password hashes, MFA secrets, an encrypted identity
 *    document, another person's user id. Dropping them quietly produces an
 *    export that *reads* as complete and is not, which is the same lie as
 *    shipping a partial ZIP. So every omission is an entry in `withheld` with a
 *    categorical reason, and the requester can see that something was held back
 *    and why without being handed the thing itself.
 *
 * 3. **A truncated slice is unrepresentable.** `recordCount` is computed
 *    independently of `records` and the schema refines that they agree, so a
 *    service that cannot serve a subject's rows in one response fails loudly
 *    instead of returning a page and letting the aggregator call it the whole
 *    story. Paginating high-volume slices (messages, activity events) is a
 *    known followup, and it has to change this contract to happen — which is
 *    the point.
 */

/**
 * Version of the slice shape itself, carried in every response and into the
 * assembled artefact. An export is a document someone may open years later;
 * one that does not name its own schema cannot be read back with confidence.
 */
export const PRIVACY_EXPORT_SLICE_SCHEMA_VERSION = 1;

export const PRIVACY_EXPORT_SERVICE_SLUG_MAX_LENGTH = 64;
export const PRIVACY_EXPORT_SECTION_KEY_MAX_LENGTH = 64;
export const PRIVACY_EXPORT_LABEL_MAX_LENGTH = 160;
export const PRIVACY_EXPORT_SUBJECT_ID_MAX_LENGTH = 64;

/**
 * Per-section record ceiling.
 *
 * Not a page size — see property 3 above: a service whose section would exceed
 * this must FAIL, because returning the first `n` rows of someone's data under
 * a heading that says "your messages" is worse than an error. The number is a
 * sanity bound on a single HTTP response, deliberately generous.
 */
export const PRIVACY_EXPORT_MAX_RECORDS_PER_SECTION = 10_000;

/** Sanity bound on how many sections one service may declare. */
export const PRIVACY_EXPORT_MAX_SECTIONS = 40;

/**
 * Service identifier, as a slug (`service-identity`, `service-booking`).
 *
 * Left as a bounded slug rather than an enum: the registry of which services
 * are EXPECTED to answer belongs with the aggregator (it is the thing that
 * decides an export is complete), not with the shape of one answer.
 */
export const PrivacyExportServiceSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(PRIVACY_EXPORT_SERVICE_SLUG_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9-]*$/u, 'service must be a lowercase slug');

/**
 * One exported row, as JSON.
 *
 * Untyped by necessity — the seam is shared by ~21 services whose tables have
 * nothing in common — but bounded to an object so the artefact is a document
 * of records, not an arbitrary value.
 */
export const PrivacyExportRecordSchema = z.record(z.string(), z.unknown());
export type PrivacyExportRecord = z.infer<typeof PrivacyExportRecordSchema>;

/**
 * A named group of records within one service's slice — "sign-in sessions",
 * "bookings", "visit notes". `label` is what a human reading the ZIP sees, so
 * it is authored by the owning service in plain language (CLAUDE.md §12), not
 * derived from a table name.
 */
export const PrivacyExportSectionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(PRIVACY_EXPORT_SECTION_KEY_MAX_LENGTH)
      .regex(/^[a-z][a-z0-9_]*$/u, 'section key must be a lowercase identifier'),
    label: z.string().trim().min(1).max(PRIVACY_EXPORT_LABEL_MAX_LENGTH),
    /**
     * Counted independently of `records` — a `count` query, not
     * `records.length`. The refinement below cross-checks the two, so a
     * projection that silently drops rows surfaces here rather than in an
     * export the subject has no way to audit.
     */
    recordCount: z.number().int().min(0).max(PRIVACY_EXPORT_MAX_RECORDS_PER_SECTION),
    records: z.array(PrivacyExportRecordSchema).max(PRIVACY_EXPORT_MAX_RECORDS_PER_SECTION),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.records.length !== value.recordCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recordCount must equal the number of records returned',
        path: ['recordCount'],
      });
    }
  });
export type PrivacyExportSection = z.infer<typeof PrivacyExportSectionSchema>;

/**
 * Why something the service holds is not in the export.
 *
 * Categorical, because the requester is entitled to know that data was held
 * back and on what basis — and because free text here would drift into 21
 * services each explaining the same four situations differently.
 *
 *   - `credential_material` — password hashes, refresh-token hashes, MFA
 *     secrets, recovery codes. Returning them creates a fresh compromise path
 *     through the export channel, and they are not a fact about the subject in
 *     any sense the subject can use.
 *   - `identity_evidence` — encrypted identity/background-check payloads the
 *     subject themselves supplied. Re-emitting government-ID data through a new
 *     channel needs its own verified-delivery decision; TS-305a already
 *     established that these columns do not leave the database on read paths.
 *   - `security_control` — how a verification was performed, and similar.
 *     TS-309a's schema already says it: publishing the method teaches how to
 *     defeat it.
 *   - `third_party_data` — the record names another person (the staff member
 *     who approved a grant, the admin who impersonated a session). Their
 *     identity is not the subject's personal data, and handing it over on a
 *     privacy request would be a disclosure in the opposite direction.
 */
export const PrivacyExportWithholdingReasonSchema = z.enum([
  'credential_material',
  'identity_evidence',
  'security_control',
  'third_party_data',
]);
export type PrivacyExportWithholdingReason = z.infer<typeof PrivacyExportWithholdingReasonSchema>;

export const PrivacyExportWithholdingSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(PRIVACY_EXPORT_SECTION_KEY_MAX_LENGTH)
      .regex(/^[a-z][a-z0-9_]*$/u, 'withholding key must be a lowercase identifier'),
    label: z.string().trim().min(1).max(PRIVACY_EXPORT_LABEL_MAX_LENGTH),
    reason: PrivacyExportWithholdingReasonSchema,
  })
  .strict();
export type PrivacyExportWithholding = z.infer<typeof PrivacyExportWithholdingSchema>;

/**
 * Fields every outcome carries. `generatedAt` is the producing service's own
 * clock: the artefact records when each contributor answered, not when the job
 * started, so a slice assembled from a stale cache would be visible as one.
 */
const privacyExportSliceBaseShape = {
  schemaVersion: z.literal(PRIVACY_EXPORT_SLICE_SCHEMA_VERSION),
  service: PrivacyExportServiceSlugSchema,
  subjectKind: DataSubjectKindSchema,
  subjectId: z.string().trim().min(1).max(PRIVACY_EXPORT_SUBJECT_ID_MAX_LENGTH),
  generatedAt: z.string().datetime({ offset: true }),
} as const;

/**
 * One service's answer.
 *
 * A discriminated union rather than "sections, possibly empty", for the reason
 * in property 1 above:
 *
 *   - `held` — this service holds data about this subject. At least one
 *     section, and every omission declared.
 *   - `no_records` — this service holds data about subjects of this kind and
 *     found none for this one. A real answer to the request.
 *   - `not_applicable` — this service never holds data about this KIND of
 *     subject (service-identity knows accounts, not seniors). Structural, and
 *     not a fact about the person named.
 */
export const PrivacyExportSliceSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...privacyExportSliceBaseShape,
      outcome: z.literal('held'),
      sections: z.array(PrivacyExportSectionSchema).min(1).max(PRIVACY_EXPORT_MAX_SECTIONS),
      withheld: z.array(PrivacyExportWithholdingSchema).max(PRIVACY_EXPORT_MAX_SECTIONS),
    })
    .strict(),
  z
    .object({
      ...privacyExportSliceBaseShape,
      outcome: z.literal('no_records'),
    })
    .strict(),
  z
    .object({
      ...privacyExportSliceBaseShape,
      outcome: z.literal('not_applicable'),
    })
    .strict(),
]);
export type PrivacyExportSlice = z.infer<typeof PrivacyExportSliceSchema>;

/** The slice IS the response body; named for symmetry with the other surfaces. */
export const PrivacyExportSliceResponseSchema = PrivacyExportSliceSchema;
export type PrivacyExportSliceResponse = PrivacyExportSlice;

/**
 * Path parameters of the internal route. Validated at the boundary like any
 * other input — the shared secret says the caller is in-cluster, not that the
 * ids it carries are well-formed.
 */
export const PrivacyExportSliceParamsSchema = z
  .object({
    subjectKind: DataSubjectKindSchema,
    subjectId: z.string().trim().min(1).max(PRIVACY_EXPORT_SUBJECT_ID_MAX_LENGTH),
  })
  .strict();
export type PrivacyExportSliceParams = z.infer<typeof PrivacyExportSliceParamsSchema>;
