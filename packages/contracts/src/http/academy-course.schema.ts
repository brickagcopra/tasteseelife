import { z } from 'zod';

import { ACADEMY_MEDIA_KEY_MAX_LENGTH } from './academy-lesson.schema';
import { AcademyCourseModuleWithLessonsSchema } from './academy-module.schema';

/**
 * Academy course HTTP DTOs (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 * A course is the top of the Cooking Academy catalog hierarchy
 * (course → module → lesson). The course-catalog admin tooling creates / edits
 * / archives courses, and reads the full course-detail tree (course + ordered
 * modules + their ordered lessons) for the catalog editor.
 *
 * **Platform-wide catalog content.** A course carries no tenant axis — the same
 * course is the same for every student (the `AcademyCourse` Prisma model is in
 * service-academy's `unscopedModels`, mirroring `Plan` in service-subscription).
 *
 * **Lifecycle.** `draft` (the admin compose buffer) → `published` (live on the
 * public catalog) → `archived` (retired from the catalog while preserved for
 * existing enrollments + certifications). All three are reversible admin states
 * — see `ACADEMY_COURSE_STATUS_TRANSITIONS`. Distinct from the `deletedAt`
 * soft-delete tombstone, which removes a course from admin lists entirely
 * (the `DELETE` endpoint; guarded server-side against courses with cohorts).
 *
 * **Media seam.** `heroImageKey` references a `media-svc` (TS-110) S3 asset by
 * key — never a URL or a Prisma relation (CLAUDE.md §2.3).
 *
 * **Assessment.** `passingScorePercent` (0–100) is the quiz threshold that
 * gates certification issuance (TS-254 / TS-255); null when the course has no
 * graded assessment.
 *
 * **Authorisation.** Every endpoint consuming these DTOs is gated on
 * `academy:read` / `academy:write` via `@RequirePermissions(...)` +
 * `PermissionGuard` (CLAUDE.md §3.2). The gateway BFF + service-academy both
 * enforce the gate (defence-in-depth).
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped course row id cap. */
export const ACADEMY_COURSE_ID_MAX_LENGTH = 36;

/** Public catalog slug (web-academy URL). */
export const ACADEMY_COURSE_SLUG_MAX_LENGTH = 160;

/**
 * Lowercase kebab-case slug: alphanumeric segments joined by single hyphens.
 * No leading / trailing / doubled hyphens. Keeps catalog URLs clean + stable.
 */
export const ACADEMY_COURSE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Course title shown on the catalog card + course header. */
export const ACADEMY_COURSE_TITLE_MAX_LENGTH = 200;

/** Short catalog blurb shown on the course card. */
export const ACADEMY_COURSE_SUMMARY_MAX_LENGTH = 500;

/** Full course description (Markdown). */
export const ACADEMY_COURSE_DESCRIPTION_MAX_LENGTH = 20_000;

/** Free-text difficulty label (e.g. "beginner" / "intermediate"). */
export const ACADEMY_COURSE_LEVEL_MAX_LENGTH = 40;

/** Total estimated course duration in minutes. */
export const ACADEMY_COURSE_ESTIMATED_MINUTES_MAX = 1_000_000;

/** Quiz pass threshold bounds (percent). */
export const ACADEMY_PASSING_SCORE_MIN = 0;
export const ACADEMY_PASSING_SCORE_MAX = 100;

/** Admin courses-list caps. Bounded, no cursor at Phase-1 catalog volume. */
export const ACADEMY_COURSES_LIST_LIMIT_DEFAULT = 50;
export const ACADEMY_COURSES_LIST_LIMIT_MAX = 200;

// ─── Enums (mirror the Prisma enums) ─────────────────────────────────────

/**
 * Course delivery format — mirrors the `AcademyCourseKind` Prisma enum (PRD
 * §9.1). `self_paced` (on-demand, no cohort window) · `cohort_based`
 * (scheduled run with a peer group) · `in_person_workshop` (the Elite
 * in-person certification). Additive only.
 */
export const AcademyCourseKindSchema = z.enum(['self_paced', 'cohort_based', 'in_person_workshop']);
export type AcademyCourseKind = z.infer<typeof AcademyCourseKindSchema>;

/**
 * Specialty track — mirrors the `AcademyCourseTrack` Prisma enum (PRD §9.1).
 * The track a certification carries gates provider tier eligibility (PDD
 * §15.2). Additive only.
 */
export const AcademyCourseTrackSchema = z.enum([
  'general',
  'dementia_sensitive',
  'therapeutic_meals',
  'luxury_in_home',
  'cultural_comfort_cuisine',
]);
export type AcademyCourseTrack = z.infer<typeof AcademyCourseTrackSchema>;

/**
 * Publication lifecycle — mirrors the `AcademyCourseStatus` Prisma enum (PRD
 * §9.5). `draft` · `published` · `archived`.
 */
export const AcademyCourseStatusSchema = z.enum(['draft', 'published', 'archived']);
export type AcademyCourseStatus = z.infer<typeof AcademyCourseStatusSchema>;

/**
 * The status a course may be CREATED in — `draft` (the default) or `published`
 * (create-and-publish). A course cannot be created straight into `archived`
 * (archival is a transition off a live/draft course).
 */
export const InitialAcademyCourseStatusSchema = z.enum(['draft', 'published']);
export type InitialAcademyCourseStatus = z.infer<typeof InitialAcademyCourseStatusSchema>;

// ─── Status-transition policy ───────────────────────────────────────────

/**
 * Allowed course status transitions, keyed by the current status. All three
 * states are reversible admin states (an archived course can be revived to a
 * draft, a published course unpublished, etc.) — there is no terminal status,
 * unlike the cohort lifecycle. Shared between the service (which enforces the
 * matrix) and the web-admin UI (which renders only the valid actions) so the
 * two never drift. A no-op same-status PATCH is allowed (handled before the
 * matrix is consulted).
 */
export const ACADEMY_COURSE_STATUS_TRANSITIONS = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft', 'published'],
} as const satisfies Record<AcademyCourseStatus, readonly AcademyCourseStatus[]>;

/** `true` when `from → to` is an allowed course status transition. */
export function canTransitionAcademyCourse(
  from: AcademyCourseStatus,
  to: AcademyCourseStatus,
): boolean {
  return (ACADEMY_COURSE_STATUS_TRANSITIONS[from] as readonly AcademyCourseStatus[]).includes(to);
}

// ─── Field schemas ─────────────────────────────────────────────────────────

const CourseIdSchema = z.string().min(1).max(ACADEMY_COURSE_ID_MAX_LENGTH);
const SlugSchema = z
  .string()
  .trim()
  .min(1, 'a slug is required')
  .max(ACADEMY_COURSE_SLUG_MAX_LENGTH)
  .regex(ACADEMY_COURSE_SLUG_REGEX, 'slug must be lowercase kebab-case (a-z, 0-9, single hyphens)');
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'a title is required')
  .max(ACADEMY_COURSE_TITLE_MAX_LENGTH);
const SummarySchema = z
  .string()
  .trim()
  .min(1, 'a summary is required')
  .max(ACADEMY_COURSE_SUMMARY_MAX_LENGTH);
const DescriptionSchema = z.string().trim().min(1).max(ACADEMY_COURSE_DESCRIPTION_MAX_LENGTH);
const LevelSchema = z.string().trim().min(1).max(ACADEMY_COURSE_LEVEL_MAX_LENGTH);
const EstimatedMinutesSchema = z.number().int().min(0).max(ACADEMY_COURSE_ESTIMATED_MINUTES_MAX);
const HeroImageKeySchema = z.string().trim().min(1).max(ACADEMY_MEDIA_KEY_MAX_LENGTH);
const PassingScoreSchema = z
  .number()
  .int()
  .min(ACADEMY_PASSING_SCORE_MIN)
  .max(ACADEMY_PASSING_SCORE_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shapes ────────────────────────────────────────────────────────

/**
 * Full course record (shallow — no nested modules). Returned by the list +
 * the single-course create / update / delete envelopes. `deletedAt` is the
 * soft-delete tombstone (null for a live course); admin reads see it so a
 * retired course is distinguishable.
 */
export const AcademyCourseRecordSchema = z
  .object({
    id: CourseIdSchema,
    slug: SlugSchema,
    title: TitleSchema,
    summary: SummarySchema,
    description: DescriptionSchema.nullable(),
    kind: AcademyCourseKindSchema,
    track: AcademyCourseTrackSchema,
    status: AcademyCourseStatusSchema,
    level: LevelSchema.nullable(),
    estimatedMinutes: EstimatedMinutesSchema.nullable(),
    heroImageKey: HeroImageKeySchema.nullable(),
    passingScorePercent: PassingScoreSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: TimestampSchema.nullable(),
  })
  .strict();
export type AcademyCourseRecord = z.infer<typeof AcademyCourseRecordSchema>;

/**
 * Course record WITH its full catalog tree — ordered modules, each with their
 * ordered lessons. Returned by `GET /api/v1/admin/academy/courses/:courseId`
 * (the catalog editor's hydration read).
 */
export const AcademyCourseDetailSchema = AcademyCourseRecordSchema.extend({
  modules: z.array(AcademyCourseModuleWithLessonsSchema),
}).strict();
export type AcademyCourseDetail = z.infer<typeof AcademyCourseDetailSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/academy/courses` body — create a new course. `slug` is
 * unique across the catalog (a collision is a 409). `status` defaults to
 * `draft`; a course may be created directly as `published`. `track` defaults
 * to `general`.
 */
export const CreateAcademyCourseRequestSchema = z
  .object({
    slug: SlugSchema,
    title: TitleSchema,
    summary: SummarySchema,
    description: DescriptionSchema.optional(),
    kind: AcademyCourseKindSchema,
    track: AcademyCourseTrackSchema.default('general'),
    level: LevelSchema.optional(),
    estimatedMinutes: EstimatedMinutesSchema.optional(),
    heroImageKey: HeroImageKeySchema.optional(),
    passingScorePercent: PassingScoreSchema.optional(),
    status: InitialAcademyCourseStatusSchema.default('draft'),
  })
  .strict();
export type CreateAcademyCourseRequest = z.infer<typeof CreateAcademyCourseRequestSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/academy/courses/:courseId` body — a partial update. At
 * least one field must be present. Nullable fields (`description`, `level`,
 * `estimatedMinutes`, `heroImageKey`, `passingScorePercent`) accept `null` to
 * CLEAR the value. A `status` change must be an allowed transition from the
 * course's current status (validated server-side; a disallowed move is a 409).
 * `slug` edits keep the unique constraint (a collision is a 409).
 */
export const UpdateAcademyCourseRequestSchema = z
  .object({
    slug: SlugSchema.optional(),
    title: TitleSchema.optional(),
    summary: SummarySchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    kind: AcademyCourseKindSchema.optional(),
    track: AcademyCourseTrackSchema.optional(),
    level: LevelSchema.nullable().optional(),
    estimatedMinutes: EstimatedMinutesSchema.nullable().optional(),
    heroImageKey: HeroImageKeySchema.nullable().optional(),
    passingScorePercent: PassingScoreSchema.nullable().optional(),
    status: AcademyCourseStatusSchema.optional(),
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
export type UpdateAcademyCourseRequest = z.infer<typeof UpdateAcademyCourseRequestSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/academy/courses` query. With no filters the list returns
 * live (non-soft-deleted) courses ordered by `createdAt` descending.
 * `status` / `track` / `kind` narrow the result; `includeDeleted=true` widens
 * to include soft-deleted courses (admin audit view).
 */
export const ListAcademyCoursesQuerySchema = z
  .object({
    status: AcademyCourseStatusSchema.optional(),
    track: AcademyCourseTrackSchema.optional(),
    kind: AcademyCourseKindSchema.optional(),
    includeDeleted: z.coerce.boolean().optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ACADEMY_COURSES_LIST_LIMIT_MAX)
      .default(ACADEMY_COURSES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListAcademyCoursesQuery = z.infer<typeof ListAcademyCoursesQuerySchema>;

// ─── Response envelopes ───────────────────────────────────────────────────

/** Single-course envelope returned by create / update / delete. */
export const AcademyCourseResponseSchema = z.object({ course: AcademyCourseRecordSchema }).strict();
export type AcademyCourseResponse = z.infer<typeof AcademyCourseResponseSchema>;

/** Course-detail envelope returned by `GET .../courses/:courseId` (full tree). */
export const AcademyCourseDetailResponseSchema = z
  .object({ course: AcademyCourseDetailSchema })
  .strict();
export type AcademyCourseDetailResponse = z.infer<typeof AcademyCourseDetailResponseSchema>;

/** `GET /api/v1/admin/academy/courses` response — the matching courses. */
export const AcademyCoursesListResponseSchema = z
  .object({ courses: z.array(AcademyCourseRecordSchema) })
  .strict();
export type AcademyCoursesListResponse = z.infer<typeof AcademyCoursesListResponseSchema>;
