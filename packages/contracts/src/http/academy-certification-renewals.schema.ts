import { z } from 'zod';

import {
  ACADEMY_CERTIFICATION_COURSE_ID_MAX_LENGTH,
  ACADEMY_CERTIFICATION_HOLDER_NAME_MAX_LENGTH,
  ACADEMY_CERTIFICATION_ID_MAX_LENGTH,
  ACADEMY_CERTIFICATION_STUDENT_USER_ID_MAX_LENGTH,
  ACADEMY_CERTIFICATION_TITLE_MAX_LENGTH,
  AcademyCertificationStatusSchema,
} from './academy-certification.schema';
import { AcademyCourseTrackSchema } from './academy-course.schema';
import type { NotificationCategory } from './notification-dispatch.schema';
import type {
  NotificationChannelKind,
  NotificationLocale,
  NotificationVariableEntry,
} from './notification.schema';

/**
 * Internal contract surfaces for the certification-renewal worker
 * (TS-256; PRD §9.3; PDD §15.2).
 *
 * TS-255 already stamps every issued certification with a renewal
 * `expiresAt` (default 24 months). TS-256 adds the lifecycle around that
 * expiry:
 *
 *   1. A scheduled worker emails the holder at 90 / 60 / 30 / 7 days
 *      before expiry (the renewal-reminder cadence).
 *   2. On lapse (expiry reached) the certification flips `active →
 *      expired`. That status flip is the "course.completed reversal"
 *      trigger point — the downstream provider-tier demotion (provider-svc
 *      sync, PDD §15.2) is the already-deferred TS-255-followup-4 /
 *      TS-052-followup-4; service-academy has no outbox yet, so the
 *      cross-service event is carved as TS-256-followup-1.
 *
 * The worker is a cross-service aggregator with no DB of its own. It joins
 * three shared-secret internal hops:
 *
 *   - service-academy   → `InternalCertificationRenewalsResponse` (the
 *     cursor-paginated batch of active certifications at or approaching
 *     expiry) + the per-certification `expire` write.
 *   - service-identity  → `InternalRecipientContactsResponse` (REUSED from
 *     TS-235 — resolves the holder's email + account status).
 *   - service-notification → the dispatch endpoint (REUSED from TS-073).
 *
 * Every shape here is INTERNAL — consumed only by the worker over a
 * shared-secret-pinned in-cluster call, never by a browser. They are
 * registered in the OpenAPI artifact for drift detection + partner-doc
 * completeness, the same posture as the TS-235 wellness-summary internal
 * surfaces.
 *
 * **`.strict()` everywhere** (CLAUDE.md §3.3 — reject unknown fields).
 */

// ─── Reminder thresholds + bucket resolution ────────────────────────────

/**
 * Days-before-expiry the worker sends a renewal reminder (PRD §9.3). The
 * worker resolves a candidate's `daysUntilExpiry` to the nearest of these
 * milestones via `resolveCertificationRenewalThreshold`; each milestone
 * fires exactly once per certification, enforced by a deterministic
 * dispatch idempotency key (`cert-renewal:{certificationId}:{threshold}`).
 * Declared here — not in the worker — so the cadence is a published
 * contract a partner-facing renewals API could reuse.
 */
export const ACADEMY_CERTIFICATION_RENEWAL_THRESHOLD_DAYS = [90, 60, 30, 7] as const;
export type AcademyCertificationRenewalThresholdDays =
  (typeof ACADEMY_CERTIFICATION_RENEWAL_THRESHOLD_DAYS)[number];

/** The largest reminder milestone — the default horizon the worker scans. */
export const ACADEMY_CERTIFICATION_RENEWAL_HORIZON_DAYS_DEFAULT = Math.max(
  ...ACADEMY_CERTIFICATION_RENEWAL_THRESHOLD_DAYS,
);

/**
 * Resolve a certification's `daysUntilExpiry` to the reminder milestone it
 * has reached, or `null` when no reminder applies.
 *
 * The milestone is the SMALLEST threshold `T` such that `T >= daysUntilExpiry`
 * — i.e. the nearest upcoming milestone. As the days count down, a
 * certification steps through the buckets `90 → 60 → 30 → 7`, and because
 * each bucket maps to a distinct idempotency key, every milestone email is
 * sent exactly once even though the worker scans daily.
 *
 *   - `d > 90`  → `null` (not yet inside the reminder window)
 *   - `d in (60, 90]` → 90      `d in (30, 60]` → 60
 *   - `d in (7, 30]`  → 30      `d in (0, 7]`   → 7
 *   - `d <= 0`  → `null` (lapsed — handled by the expire path, not a reminder)
 *
 * Pure + exported for unit test.
 */
export function resolveCertificationRenewalThreshold(
  daysUntilExpiry: number,
): AcademyCertificationRenewalThresholdDays | null {
  if (!Number.isFinite(daysUntilExpiry) || daysUntilExpiry <= 0) return null;
  const ascending = [...ACADEMY_CERTIFICATION_RENEWAL_THRESHOLD_DAYS].sort((a, b) => a - b);
  const milestone = ascending.find((threshold) => threshold >= daysUntilExpiry);
  return milestone ?? null;
}

// ─── Shared bounds ──────────────────────────────────────────────────────

/** Default + max page size for the renewals batch read. */
export const ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_DEFAULT = 100;
export const ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_MAX = 500;

/**
 * Max horizon (days) the worker may ask the service to scan forward. The
 * service always returns lapsed certifications (expiry already past) plus
 * those whose `expiresAt` falls within `now + horizonDays`; capping the
 * future side keeps the scan bounded. Default = the largest reminder
 * milestone.
 */
export const ACADEMY_CERTIFICATION_RENEWALS_HORIZON_DAYS_MAX = 366;

/** Opaque cursor ceiling for the renewals batch keyset pagination. */
const RENEWALS_CURSOR_MAX_LENGTH = 512;

const CertificationIdSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_ID_MAX_LENGTH);
const StudentUserIdSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_STUDENT_USER_ID_MAX_LENGTH);
const CourseIdSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_COURSE_ID_MAX_LENGTH);
const CourseTitleSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_TITLE_MAX_LENGTH);
const HolderNameSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_HOLDER_NAME_MAX_LENGTH);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── service-academy → renewals batch ───────────────────────────────────

/**
 * One certification at or approaching its renewal expiry. Carries only
 * what the worker needs to email the holder + classify the candidate:
 *
 *   - `studentUserId` → resolved to an email via the identity batch.
 *   - `holderName` → the name snapshotted on the certification at issue
 *     time (nullable), so the reminder email greets the holder by name
 *     without a cross-service identity read. The worker substitutes a warm
 *     fallback when null.
 *   - `courseTitle` + `track` → rendered into the reminder copy (snapshots
 *     captured at issue time, so no cross-service course read is needed).
 *   - `expiresAt` (always non-null — the service filters on it) → the
 *     worker derives `daysUntilExpiry` and the reminder milestone, OR
 *     (when already past) classifies the candidate as lapsed and issues
 *     the `expire` write.
 *
 * Deliberately omits the verification token + the PDF key + the enrollment
 * id — the worker has no use for them and they widen the PII surface of an
 * internal projection.
 */
export const CertificationRenewalCandidateSchema = z
  .object({
    certificationId: CertificationIdSchema,
    studentUserId: StudentUserIdSchema,
    holderName: HolderNameSchema.nullable(),
    courseId: CourseIdSchema,
    courseTitle: CourseTitleSchema,
    track: AcademyCourseTrackSchema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type CertificationRenewalCandidate = z.infer<typeof CertificationRenewalCandidateSchema>;

/**
 * Query string for `GET /api/v1/internal/academy/certifications/renewals`.
 * Keyset cursor pagination ordered by `certificationId` so the worker can
 * walk the entire at-risk population in bounded pages.
 */
export const InternalCertificationRenewalsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(RENEWALS_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_MAX)
      .default(ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_DEFAULT),
    horizonDays: z.coerce
      .number()
      .int()
      .positive()
      .max(ACADEMY_CERTIFICATION_RENEWALS_HORIZON_DAYS_MAX)
      .default(ACADEMY_CERTIFICATION_RENEWAL_HORIZON_DAYS_DEFAULT),
  })
  .strict();
export type InternalCertificationRenewalsQuery = z.infer<
  typeof InternalCertificationRenewalsQuerySchema
>;

/**
 * Response body for the renewals batch. `nextCursor` is the last
 * certification id of the page when a further page may exist, else null.
 */
export const InternalCertificationRenewalsResponseSchema = z
  .object({
    certifications: z.array(CertificationRenewalCandidateSchema),
    nextCursor: z.string().min(1).max(RENEWALS_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type InternalCertificationRenewalsResponse = z.infer<
  typeof InternalCertificationRenewalsResponseSchema
>;

// ─── service-academy → expire (lapse) write ─────────────────────────────

/**
 * Response body for
 * `POST /api/v1/internal/academy/certifications/:certificationId/expire`.
 *
 * The write is idempotent: a certification already `expired` (or terminal
 * `revoked`) is a no-op (`changed: false`); an `active` certification past
 * its expiry flips to `expired` (`changed: true`). A missing certification
 * is a 404, not a body — so `status` is always the certification's real
 * post-call lifecycle state.
 */
export const ExpireCertificationResponseSchema = z
  .object({
    certificationId: CertificationIdSchema,
    status: AcademyCertificationStatusSchema,
    changed: z.boolean(),
  })
  .strict();
export type ExpireCertificationResponse = z.infer<typeof ExpireCertificationResponseSchema>;

// ─── Notification template definition (shared seed ⇄ worker contract) ───

/**
 * The certification-renewal reminder template's identity + variable
 * contract (TS-256). Lives here — not in service-notification or the
 * worker — because PDD §12.2 mandates that template variables are
 * "strictly typed via shared contract package": the service-notification
 * seed declares EXACTLY these variables and the worker's dispatch call
 * supplies EXACTLY these variables. The render endpoint rejects a dispatch
 * that omits a required variable or sends an unknown one, so the two sides
 * MUST agree — this constant is the single source they both import.
 *
 * Mirrors the TS-235 `WELLNESS_SUMMARY_TEMPLATE_*` shape exactly.
 */
export const ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE = 'academy-certification-renewal';
export const ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_LOCALE: NotificationLocale = 'en-US';
export const ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CHANNEL: NotificationChannelKind = 'email';
/**
 * Transactional, not marketing — a credential-expiry notice is a service
 * communication tied to the holder's own certification, so it defaults
 * opt-in and is not gated by the marketing opt-out (TCPA / CAN-SPAM). It
 * still honours quiet hours unless the caller bypasses.
 */
export const ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CATEGORY: NotificationCategory =
  'transactional';

/**
 * The variables the template declares and the worker supplies. `holderName`
 * is the name snapshotted on the certification (nullable on the row, but
 * the worker substitutes a warm fallback so the rendered variable is always
 * a non-empty string). `daysUntilExpiry` is the actual remaining days at
 * send time (≈ the reminder milestone, but exact even if the worker missed
 * a day). The reminder milestone itself (90 / 60 / 30 / 7) is a
 * worker-internal concept — it drives the dispatch idempotency key, not the
 * rendered copy — so it is deliberately NOT a template variable.
 */
export const ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLES: readonly NotificationVariableEntry[] =
  [
    {
      name: 'holderName',
      type: 'string',
      required: true,
      description: 'The certification holder, or a warm fallback when unknown.',
    },
    {
      name: 'courseTitle',
      type: 'string',
      required: true,
      description: 'The certified course title.',
    },
    {
      name: 'trackLabel',
      type: 'string',
      required: true,
      description: 'Human label for the certification track.',
    },
    {
      name: 'expiresOn',
      type: 'string',
      required: true,
      description: 'Human expiry date, e.g. "June 8, 2026".',
    },
    {
      name: 'daysUntilExpiry',
      type: 'number',
      required: true,
      description: 'Exact remaining days until expiry at send time.',
    },
    {
      name: 'renewUrl',
      type: 'string',
      required: true,
      description: 'Where the holder renews / continues education.',
    },
    {
      name: 'appName',
      type: 'string',
      required: true,
      description: 'Product name for the footer, e.g. "Taste & See".',
    },
  ];

/** The variable names, as a typed tuple, for the worker's builder + tests. */
export const ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLE_NAMES = [
  'holderName',
  'courseTitle',
  'trackLabel',
  'expiresOn',
  'daysUntilExpiry',
  'renewUrl',
  'appName',
] as const;
export type AcademyCertificationRenewalTemplateVariableName =
  (typeof ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLE_NAMES)[number];
