import { z } from 'zod';

import { AcademyCourseTrackSchema } from './academy-course.schema';

/**
 * Academy certification HTTP DTOs (TS-255; PRD §9.3; PDD §15.2).
 *
 * Three surfaces share this file:
 *
 *   - ADMIN issuance / management (`academy:read` / `academy:write`): issue a
 *     certification for a student who completed a course, list / read the full
 *     records, and revoke. These carry the full record shape (including the
 *     `studentUserId`, the `certificatePdfKey`, and the internal ids).
 *
 *   - PUBLIC verification (`GET /verify/cert/:token`, no auth): the limited,
 *     PII-minimised view a third party sees when they scan the verification URL
 *     on a certificate. It surfaces ONLY what a diploma-style credential check
 *     needs — the holder's name, the course title + track, the status, and the
 *     issue / expiry dates. It deliberately NEVER carries the `studentUserId`,
 *     the PDF S3 key, the enrollment id, or any internal identifier.
 *
 * The split is the load-bearing security property of this file: the public
 * shape is a strict subset, asserted in the contract test + the controller.
 *
 * **`.strict()` everywhere** (CLAUDE.md §3.3 — reject unknown fields).
 */

// ─── Bounded constants ───────────────────────────────────────────────────────

export const ACADEMY_CERTIFICATION_ID_MAX_LENGTH = 36;
/** Soft FK into `identity.users.id` — bounded like the other student-id fields. */
export const ACADEMY_CERTIFICATION_STUDENT_USER_ID_MAX_LENGTH = 64;
export const ACADEMY_CERTIFICATION_COURSE_ID_MAX_LENGTH = 36;
export const ACADEMY_CERTIFICATION_ENROLLMENT_ID_MAX_LENGTH = 36;
/** Course title snapshot — mirrors the course title cap (academy-course.schema). */
export const ACADEMY_CERTIFICATION_TITLE_MAX_LENGTH = 200;
/** Holder display name snapshot — generous cap for full legal names. */
export const ACADEMY_CERTIFICATION_HOLDER_NAME_MAX_LENGTH = 160;
/** Verification token — url-safe; the public `/verify/cert/{token}` key. */
export const ACADEMY_CERTIFICATION_VERIFICATION_TOKEN_MAX_LENGTH = 64;
/** `media-svc` S3 object key for the rendered PDF. */
export const ACADEMY_CERTIFICATION_PDF_KEY_MAX_LENGTH = 512;
/** Revocation reason free-text cap (audit memo). */
export const ACADEMY_CERTIFICATION_REVOKE_REASON_MAX_LENGTH = 500;
/** Renewal window bounds (months) — PDD §15.2 default is 24 months. */
export const ACADEMY_CERTIFICATION_EXPIRES_IN_MONTHS_DEFAULT = 24;
export const ACADEMY_CERTIFICATION_EXPIRES_IN_MONTHS_MAX = 120;
export const ACADEMY_CERTIFICATIONS_LIST_LIMIT_DEFAULT = 50;
export const ACADEMY_CERTIFICATIONS_LIST_LIMIT_MAX = 200;

// ─── Enum ────────────────────────────────────────────────────────────────────

/** Certification lifecycle — mirrors the `AcademyCertificationStatus` Prisma enum. */
export const AcademyCertificationStatusSchema = z.enum(['active', 'expired', 'revoked']);
export type AcademyCertificationStatus = z.infer<typeof AcademyCertificationStatusSchema>;

// ─── Field schemas ───────────────────────────────────────────────────────────

const CertificationIdSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_ID_MAX_LENGTH);
const StudentUserIdSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_STUDENT_USER_ID_MAX_LENGTH);
const CourseIdSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_COURSE_ID_MAX_LENGTH);
const EnrollmentIdSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_ENROLLMENT_ID_MAX_LENGTH);
const TitleSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_TITLE_MAX_LENGTH);
const HolderNameSchema = z.string().min(1).max(ACADEMY_CERTIFICATION_HOLDER_NAME_MAX_LENGTH);
const VerificationTokenSchema = z
  .string()
  .min(1)
  .max(ACADEMY_CERTIFICATION_VERIFICATION_TOKEN_MAX_LENGTH);
const PdfKeySchema = z.string().min(1).max(ACADEMY_CERTIFICATION_PDF_KEY_MAX_LENGTH);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/academy/certifications` — issue a certification.
 *
 * The admin (or the future automatic completion trigger, TS-254-followup-6)
 * names the student + course + holder name; the service snapshots the course
 * `title` + `track`, mints the verification token, renders the PDF, and stamps
 * the renewal expiry. `enrollmentId` is optional — when present the service
 * verifies the enrollment is `completed` and belongs to the student+course;
 * when absent the admin is asserting completion out-of-band. `expiresInMonths`
 * defaults to 24 (PDD §15.2). Honour `Idempotency-Key`.
 */
export const IssueAcademyCertificationRequestSchema = z
  .object({
    studentUserId: StudentUserIdSchema,
    courseId: CourseIdSchema,
    enrollmentId: EnrollmentIdSchema.optional(),
    holderName: HolderNameSchema,
    expiresInMonths: z
      .number()
      .int()
      .min(1)
      .max(ACADEMY_CERTIFICATION_EXPIRES_IN_MONTHS_MAX)
      .optional(),
  })
  .strict();
export type IssueAcademyCertificationRequest = z.infer<
  typeof IssueAcademyCertificationRequestSchema
>;

/**
 * `POST /api/v1/admin/academy/certifications/:certificationId/revocation` —
 * revoke a certification (status → `revoked`, stamps `revokedAt`). Append-only:
 * a certification is never deleted (CLAUDE.md §3.6). Optional audit memo.
 */
export const RevokeAcademyCertificationRequestSchema = z
  .object({
    reason: z.string().min(1).max(ACADEMY_CERTIFICATION_REVOKE_REASON_MAX_LENGTH).optional(),
  })
  .strict();
export type RevokeAcademyCertificationRequest = z.infer<
  typeof RevokeAcademyCertificationRequestSchema
>;

/**
 * `GET /api/v1/admin/academy/certifications` query — admin filter. All optional;
 * an empty query lists the newest certifications across the catalog.
 */
export const ListAcademyCertificationsQuerySchema = z
  .object({
    studentUserId: StudentUserIdSchema.optional(),
    courseId: CourseIdSchema.optional(),
    status: AcademyCertificationStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ACADEMY_CERTIFICATIONS_LIST_LIMIT_MAX)
      .default(ACADEMY_CERTIFICATIONS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListAcademyCertificationsQuery = z.infer<typeof ListAcademyCertificationsQuerySchema>;

// ─── Admin record (full) ─────────────────────────────────────────────────────

/**
 * The full certification record returned by the admin surfaces. Carries the
 * internal ids + the PDF key — admin-only; the public verification view
 * (below) is a strict subset.
 */
export const AcademyCertificationRecordSchema = z
  .object({
    id: CertificationIdSchema,
    studentUserId: StudentUserIdSchema,
    courseId: CourseIdSchema,
    enrollmentId: EnrollmentIdSchema.nullable(),
    title: TitleSchema,
    track: AcademyCourseTrackSchema,
    holderName: HolderNameSchema.nullable(),
    status: AcademyCertificationStatusSchema,
    verificationToken: VerificationTokenSchema,
    certificatePdfKey: PdfKeySchema.nullable(),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AcademyCertificationRecord = z.infer<typeof AcademyCertificationRecordSchema>;

/** Single-record envelope returned by issue / get / revoke. */
export const AcademyCertificationResponseSchema = z
  .object({ certification: AcademyCertificationRecordSchema })
  .strict();
export type AcademyCertificationResponse = z.infer<typeof AcademyCertificationResponseSchema>;

/** List envelope returned by `GET /api/v1/admin/academy/certifications`. */
export const AcademyCertificationsListResponseSchema = z
  .object({ certifications: z.array(AcademyCertificationRecordSchema) })
  .strict();
export type AcademyCertificationsListResponse = z.infer<
  typeof AcademyCertificationsListResponseSchema
>;

// ─── Public verification view (PII-minimised subset) ─────────────────────────

/**
 * The PUBLIC verification view (`GET /verify/cert/:token`). A strict subset of
 * the record: holder + course + track + dates + status + a derived `valid`
 * flag. NEVER carries `studentUserId`, `certificatePdfKey`, `enrollmentId`, or
 * the certification `id` — a third party verifying a credential learns only
 * what the certificate itself shows (PRD §9.3). `valid` is true iff the
 * certification is `active` AND not past `expiresAt` at the verification moment.
 */
export const PublicCertificationVerificationSchema = z
  .object({
    holderName: HolderNameSchema.nullable(),
    courseTitle: TitleSchema,
    track: AcademyCourseTrackSchema,
    status: AcademyCertificationStatusSchema,
    valid: z.boolean(),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
  })
  .strict();
export type PublicCertificationVerification = z.infer<typeof PublicCertificationVerificationSchema>;

/** Envelope for the public verification response. */
export const PublicCertificationVerificationResponseSchema = z
  .object({ verification: PublicCertificationVerificationSchema })
  .strict();
export type PublicCertificationVerificationResponse = z.infer<
  typeof PublicCertificationVerificationResponseSchema
>;
