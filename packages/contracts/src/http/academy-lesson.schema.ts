import { z } from 'zod';

/**
 * Academy lesson HTTP DTOs (TS-251; PRD §9.1–§9.2, §9.5; PDD §15.1).
 *
 * A lesson is the leaf of the Cooking Academy catalog hierarchy
 * (course → module → lesson). The course-catalog admin tooling manages
 * lessons within a module: create / edit / delete / reorder, choosing the
 * lesson `kind` (video / reading / quiz / assignment — PDD §15.1) and
 * attaching content.
 *
 * **Platform-wide catalog content.** Lessons carry no tenant axis — the same
 * lesson renders for every student (the `AcademyLesson` Prisma model is in
 * service-academy's `unscopedModels`). Per-student progress is a TS-252
 * (lesson player) concern, not here.
 *
 * **Content seam.** `contentKey` references a `media-svc` (TS-110) S3 asset by
 * key — the video served via a signed CloudFront URL per PDD §15.1 — never a
 * URL or a Prisma relation. `bodyMarkdown` holds inline content for `reading`
 * lessons. Both are nullable / optional: a lesson is created first and its
 * content authored incrementally, so no cross-field requirement is enforced at
 * the contract boundary (the lesson player TS-252 gates on content presence at
 * render time).
 *
 * **Authorisation.** Every endpoint consuming these DTOs is gated on
 * `academy:read` (the list) / `academy:write` (the mutations) via
 * `@RequirePermissions(...)` + `PermissionGuard` (CLAUDE.md §3.2). The gateway
 * BFF + service-academy both enforce the gate (defence-in-depth).
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a silently
 * dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped lesson row id cap. */
export const ACADEMY_LESSON_ID_MAX_LENGTH = 36;

/** CUID-shaped parent module id cap (mirrors the lesson id cap). */
export const ACADEMY_MODULE_ID_MAX_LENGTH = 36;

/** Lesson title shown in the module outline + lesson player nav. */
export const ACADEMY_LESSON_TITLE_MAX_LENGTH = 200;

/**
 * `media-svc` S3 asset key for a `video` lesson. Generous cap — S3 keys can be
 * long (prefix + uuid + extension). Shared with the course hero-image key cap.
 */
export const ACADEMY_MEDIA_KEY_MAX_LENGTH = 512;

/** Inline Markdown body for a `reading` lesson. */
export const ACADEMY_LESSON_BODY_MARKDOWN_MAX_LENGTH = 50_000;

/** Lesson `sortPosition` upper bound — a module never holds this many lessons. */
export const ACADEMY_SORT_POSITION_MAX = 100_000;

/** Lesson duration in minutes (video length / estimated reading time). */
export const ACADEMY_LESSON_DURATION_MINUTES_MAX = 100_000;

// ─── Enum ────────────────────────────────────────────────────────────────

/**
 * Lesson content type — mirrors the `AcademyLessonKind` Prisma enum (PDD
 * §15.1). The lesson player (TS-252) branches on this to pick a renderer;
 * `quiz` lessons bind to the TS-254 quiz engine. Additive only — new kinds
 * arrive via `ALTER TYPE … ADD VALUE`.
 */
export const AcademyLessonKindSchema = z.enum(['video', 'reading', 'quiz', 'assignment']);
export type AcademyLessonKind = z.infer<typeof AcademyLessonKindSchema>;

// ─── Field schemas ─────────────────────────────────────────────────────────

const LessonIdSchema = z.string().min(1).max(ACADEMY_LESSON_ID_MAX_LENGTH);
const ModuleIdSchema = z.string().min(1).max(ACADEMY_MODULE_ID_MAX_LENGTH);
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'a title is required')
  .max(ACADEMY_LESSON_TITLE_MAX_LENGTH);
const ContentKeySchema = z.string().trim().min(1).max(ACADEMY_MEDIA_KEY_MAX_LENGTH);
const BodyMarkdownSchema = z.string().trim().min(1).max(ACADEMY_LESSON_BODY_MARKDOWN_MAX_LENGTH);
const SortPositionSchema = z.number().int().min(0).max(ACADEMY_SORT_POSITION_MAX);
const DurationMinutesSchema = z.number().int().min(1).max(ACADEMY_LESSON_DURATION_MINUTES_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shape ───────────────────────────────────────────────────────

/**
 * Full lesson record returned by the lesson endpoints and nested inside the
 * course-detail tree.
 *
 *   - `contentKey` — `media-svc` S3 key for `video` lessons; null otherwise.
 *   - `bodyMarkdown` — inline content for `reading` lessons; null otherwise.
 *   - `sortPosition` — 0-based ordering within the module.
 */
export const AcademyLessonRecordSchema = z
  .object({
    id: LessonIdSchema,
    moduleId: ModuleIdSchema,
    title: TitleSchema,
    kind: AcademyLessonKindSchema,
    contentKey: ContentKeySchema.nullable(),
    bodyMarkdown: BodyMarkdownSchema.nullable(),
    sortPosition: SortPositionSchema,
    durationMinutes: DurationMinutesSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AcademyLessonRecord = z.infer<typeof AcademyLessonRecordSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/academy/modules/:moduleId/lessons` body — append a new
 * lesson to a module. `sortPosition` is OPTIONAL: when omitted the service
 * appends after the module's current last lesson (max + 1); when supplied the
 * lesson is inserted at that position (the caller owns reconciling other rows'
 * positions). Content fields are optional — a lesson is authored incrementally.
 */
export const CreateAcademyLessonRequestSchema = z
  .object({
    title: TitleSchema,
    kind: AcademyLessonKindSchema,
    contentKey: ContentKeySchema.optional(),
    bodyMarkdown: BodyMarkdownSchema.optional(),
    sortPosition: SortPositionSchema.optional(),
    durationMinutes: DurationMinutesSchema.optional(),
  })
  .strict();
export type CreateAcademyLessonRequest = z.infer<typeof CreateAcademyLessonRequestSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/academy/lessons/:lessonId` body — a partial update. At
 * least one field must be present. Nullable fields (`contentKey`,
 * `bodyMarkdown`, `durationMinutes`) accept `null` to CLEAR the value.
 */
export const UpdateAcademyLessonRequestSchema = z
  .object({
    title: TitleSchema.optional(),
    kind: AcademyLessonKindSchema.optional(),
    contentKey: ContentKeySchema.nullable().optional(),
    bodyMarkdown: BodyMarkdownSchema.nullable().optional(),
    sortPosition: SortPositionSchema.optional(),
    durationMinutes: DurationMinutesSchema.nullable().optional(),
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
export type UpdateAcademyLessonRequest = z.infer<typeof UpdateAcademyLessonRequestSchema>;

// ─── Response envelopes ───────────────────────────────────────────────────

/** Single-lesson envelope returned by create / update / get. */
export const AcademyLessonResponseSchema = z.object({ lesson: AcademyLessonRecordSchema }).strict();
export type AcademyLessonResponse = z.infer<typeof AcademyLessonResponseSchema>;

/**
 * `GET /api/v1/admin/academy/modules/:moduleId/lessons` response — the module's
 * lessons ordered by `sortPosition` ascending. Bounded by the module's lesson
 * count; no cursor (a module never holds enough lessons to need one).
 */
export const AcademyLessonsListResponseSchema = z
  .object({ lessons: z.array(AcademyLessonRecordSchema) })
  .strict();
export type AcademyLessonsListResponse = z.infer<typeof AcademyLessonsListResponseSchema>;
