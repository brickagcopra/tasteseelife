import { z } from 'zod';

/**
 * Provider lifecycle status — mirrors the Prisma `ProviderStatus`
 * enum on the service-provider side. Drives the family-portal /
 * search visibility of a provider.
 */
export const ProviderStatusSchema = z.enum([
  'pending',
  'in_review',
  'active',
  'suspended',
  'archived',
]);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

/**
 * Provider marketplace tier — mirrors the Prisma `ProviderTier`
 * enum. PRD §5.2 pricing & commission bands.
 */
export const ProviderTierSchema = z.enum(['basic', 'certified', 'elite']);
export type ProviderTier = z.infer<typeof ProviderTierSchema>;

/**
 * Application lifecycle status — mirrors the Prisma
 * `ApplicationStatus` enum.
 */
export const ApplicationStatusSchema = z.enum([
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'withdrawn',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

/**
 * Background-check status — mirrors the Prisma
 * `BackgroundCheckStatus` enum. Phase-1 maps Checkr's free-text
 * `report.status` strings into this nine-value union.
 */
export const BackgroundCheckStatusSchema = z.enum([
  'pending',
  'processing',
  'clear',
  'consider',
  'suspended',
  'engaged',
  'dispute',
  'canceled',
  'failed',
]);
export type BackgroundCheckStatus = z.infer<typeof BackgroundCheckStatusSchema>;

/**
 * Maximum lengths for the profile-shaped fields the application
 * carries onto the provider row. Captured as exported constants so
 * the portal can use the same caps for client-side validation.
 */
export const PROVIDER_DISPLAY_NAME_MAX_LENGTH = 120;
export const PROVIDER_HEADLINE_MAX_LENGTH = 120;
export const PROVIDER_BIO_MAX_LENGTH = 4000;
export const PROVIDER_TIME_ZONE_MAX_LENGTH = 64;
export const APPLICANT_NOTES_MAX_LENGTH = 2000;

/**
 * Applicant fields sent to Checkr. The applicant PII (name, DOB,
 * SSN-last-4) lives ONLY inside the request body and Checkr's own
 * systems — we never persist it on our side (CLAUDE.md §17.1). The
 * service-provider request handler forwards the entire object to
 * Checkr and discards it; only the opaque `checkr_candidate_id`
 * lands on the `provider_background_checks` row.
 *
 * Phone is captured as a free-text string (E.164 in practice; the
 * portal validates client-side). Checkr accepts either US-domestic
 * `+1XXXXXXXXXX` or `XXXXXXXXXX`.
 */
export const ProviderApplicantSchema = z
  .object({
    firstName: z.string().min(1).max(80),
    middleName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80),
    email: z.string().email().max(254),
    phone: z.string().min(7).max(32),
    /** ISO date string `YYYY-MM-DD`. */
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dob must be an ISO date in YYYY-MM-DD format'),
    /** Last 4 digits of SSN. */
    ssnLast4: z
      .string()
      .regex(/^\d{4}$/, 'ssnLast4 must be exactly 4 digits')
      .optional(),
    /** US ZIP code (5 digits). */
    zipcode: z.string().regex(/^\d{5}$/, 'zipcode must be exactly 5 digits'),
  })
  .strict();
export type ProviderApplicant = z.infer<typeof ProviderApplicantSchema>;

/**
 * Profile shape lifted onto the providers row at submission time.
 * The applicant supplies the public-facing identity (display name,
 * headline, bio) and the IANA timezone the availability service
 * (TS-053) needs.
 */
export const SubmitProviderApplicationProfileSchema = z
  .object({
    displayName: z.string().min(1).max(PROVIDER_DISPLAY_NAME_MAX_LENGTH),
    timeZone: z.string().min(1).max(PROVIDER_TIME_ZONE_MAX_LENGTH),
    headline: z.string().min(1).max(PROVIDER_HEADLINE_MAX_LENGTH).optional(),
    bio: z.string().min(1).max(PROVIDER_BIO_MAX_LENGTH).optional(),
  })
  .strict();
export type SubmitProviderApplicationProfile = z.infer<
  typeof SubmitProviderApplicationProfileSchema
>;

/**
 * Request body for `POST /api/v1/providers/applications`.
 *
 * `applicantNotes` is the optional free-text the applicant supplies
 * to ops ("I worked at Daniel for six years and want to make this
 * my full-time career"). Bounded so the column doesn't grow
 * unbounded; the portal surfaces a character counter.
 */
export const SubmitProviderApplicationRequestSchema = z
  .object({
    profile: SubmitProviderApplicationProfileSchema,
    applicant: ProviderApplicantSchema,
    applicantNotes: z.string().min(1).max(APPLICANT_NOTES_MAX_LENGTH).optional(),
  })
  .strict();
export type SubmitProviderApplicationRequest = z.infer<
  typeof SubmitProviderApplicationRequestSchema
>;

/**
 * Provider DTO — projects the internal `Provider` row to the
 * publicly-visible shape.
 */
export const ProviderRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    status: ProviderStatusSchema,
    tier: ProviderTierSchema,
    displayName: z.string().min(1).max(PROVIDER_DISPLAY_NAME_MAX_LENGTH),
    headline: z.string().max(PROVIDER_HEADLINE_MAX_LENGTH).nullable(),
    bio: z.string().max(PROVIDER_BIO_MAX_LENGTH).nullable(),
    profilePhotoKey: z.string().max(1024).nullable(),
    videoIntroKey: z.string().max(1024).nullable(),
    timeZone: z.string().min(1).max(PROVIDER_TIME_ZONE_MAX_LENGTH),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderRecord = z.infer<typeof ProviderRecordSchema>;

/**
 * Application DTO — projects the internal `ProviderApplication` row
 * to the publicly-visible shape. Reviewer-side notes are surfaced
 * here too (the applicant sees ops feedback on the portal once a
 * reviewer fills `reviewNotes` in).
 */
export const ProviderApplicationRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    status: ApplicationStatusSchema,
    applicantNotes: z.string().max(APPLICANT_NOTES_MAX_LENGTH).nullable(),
    reviewNotes: z.string().max(4000).nullable(),
    submittedAt: z.string().datetime(),
    reviewedAt: z.string().datetime().nullable(),
    withdrawnAt: z.string().datetime().nullable(),
  })
  .strict();
export type ProviderApplicationRecord = z.infer<typeof ProviderApplicationRecordSchema>;

/**
 * Background-check DTO — projects the internal
 * `ProviderBackgroundCheck` row. The encrypted payload columns are
 * deliberately omitted (raw Checkr payloads are internal-only;
 * surface them via admin tooling, not the user-facing API).
 */
export const ProviderBackgroundCheckRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    status: BackgroundCheckStatusSchema,
    checkrCandidateId: z.string().min(1).max(64),
    checkrReportId: z.string().min(1).max(64).nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderBackgroundCheckRecord = z.infer<typeof ProviderBackgroundCheckRecordSchema>;

/**
 * Response body for `POST /api/v1/providers/applications`.
 */
export const SubmitProviderApplicationResponseSchema = z
  .object({
    provider: ProviderRecordSchema,
    application: ProviderApplicationRecordSchema,
    backgroundCheck: ProviderBackgroundCheckRecordSchema,
  })
  .strict();
export type SubmitProviderApplicationResponse = z.infer<
  typeof SubmitProviderApplicationResponseSchema
>;

/**
 * Response body for `GET /api/v1/providers/applications/me`.
 * Each field is null when nothing exists.
 */
export const ProviderApplicationStatusResponseSchema = z
  .object({
    provider: ProviderRecordSchema.nullable(),
    application: ProviderApplicationRecordSchema.nullable(),
    backgroundCheck: ProviderBackgroundCheckRecordSchema.nullable(),
  })
  .strict();
export type ProviderApplicationStatusResponse = z.infer<
  typeof ProviderApplicationStatusResponseSchema
>;

/**
 * Internal dispatch payload — the body service-webhook POSTs to
 * `POST /api/v1/internal/providers/background-check-events`. Not
 * part of the public REST surface; documented here so both ends of
 * the cross-service contract share a single typed shape.
 *
 * - `eventId`            — Checkr `event.id`. Used for idempotency.
 * - `eventType`          — Checkr `event.type` (e.g. `report.completed`).
 * - `eventCreatedSeconds` — Checkr `event.created_at` (Unix
 *                          seconds). Used to stamp `completedAt`
 *                          on the terminal transition.
 * - `report`             — projection of the Checkr `report` data
 *                          the event carried. Status is free-text
 *                          Checkr string — the service maps it.
 * - `rawPayload`         — JSON-stringified copy of the raw Checkr
 *                          event payload, persisted at rest under
 *                          the payload cipher. Bounded to defend
 *                          against an unbounded blob.
 */
export const ProviderBackgroundCheckInternalWebhookEventSchema = z
  .object({
    eventId: z.string().min(1).max(255),
    eventType: z.string().min(1).max(255),
    eventCreatedSeconds: z.number().int().min(0),
    report: z
      .object({
        id: z.string().min(1).max(64),
        candidateId: z.string().min(1).max(64),
        status: z.string().min(1).max(64),
      })
      .strict(),
    rawPayload: z.string().min(1).max(65_536),
  })
  .strict();
export type ProviderBackgroundCheckInternalWebhookEvent = z.infer<
  typeof ProviderBackgroundCheckInternalWebhookEventSchema
>;

/**
 * Internal dispatch response. Surfaces the persisted record (or
 * `null` if the event was a replay we short-circuited) plus an
 * outcome string so the dispatcher's metrics can distinguish
 * applied / replayed / report-mismatch outcomes.
 */
export const ProviderBackgroundCheckInternalWebhookResponseSchema = z
  .object({
    outcome: z.enum(['applied', 'replayed', 'report_mismatch']),
    record: ProviderBackgroundCheckRecordSchema.nullable(),
  })
  .strict();
export type ProviderBackgroundCheckInternalWebhookResponse = z.infer<
  typeof ProviderBackgroundCheckInternalWebhookResponseSchema
>;
