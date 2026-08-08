import { z } from 'zod';

import {
  ACADEMY_MODULE_ID_MAX_LENGTH,
  ACADEMY_SORT_POSITION_MAX,
  AcademyLessonRecordSchema,
} from './academy-lesson.schema';

/**
 * Academy course-module HTTP DTOs (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 * A module is the middle of the Cooking Academy catalog hierarchy
 * (course → module → lesson) — a named, ordered grouping of lessons within a
 * course. The course-catalog admin tooling manages modules within a course:
 * create / edit / delete / reorder.
 *
 * **Platform-wide catalog content.** Modules carry no tenant axis (the
 * `AcademyCourseModule` Prisma model is in service-academy's `unscopedModels`).
 *
 * **Cascade delete.** A module's lessons are removed with it (the Prisma
 * relation is `ON DELETE CASCADE`); the delete endpoint reports the count of
 * lessons removed so the admin UI can confirm the blast radius.
 *
 * **Authorisation.** Every endpoint consuming these DTOs is gated on
 * `academy:read` (the list) / `academy:write` (the mutations) via
 * `@RequirePermissions(...)` + `PermissionGuard` (CLAUDE.md §3.2).
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ─────────────────────────────────────────────

/** Module title shown in the course outline. */
export const ACADEMY_MODULE_TITLE_MAX_LENGTH = 200;

/** Optional module description / overview (Markdown). */
export const ACADEMY_MODULE_DESCRIPTION_MAX_LENGTH = 4_000;

// ─── Field schemas ─────────────────────────────────────────────────────────

const ModuleIdSchema = z.string().min(1).max(ACADEMY_MODULE_ID_MAX_LENGTH);
const CourseIdSchema = z.string().min(1).max(ACADEMY_MODULE_ID_MAX_LENGTH);
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'a title is required')
  .max(ACADEMY_MODULE_TITLE_MAX_LENGTH);
const DescriptionSchema = z.string().trim().min(1).max(ACADEMY_MODULE_DESCRIPTION_MAX_LENGTH);
const SortPositionSchema = z.number().int().min(0).max(ACADEMY_SORT_POSITION_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shapes ────────────────────────────────────────────────────────

/**
 * Module record (shallow — no nested lessons). Returned by the module list +
 * the single-module create / update envelopes.
 */
export const AcademyCourseModuleRecordSchema = z
  .object({
    id: ModuleIdSchema,
    courseId: CourseIdSchema,
    title: TitleSchema,
    description: DescriptionSchema.nullable(),
    sortPosition: SortPositionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AcademyCourseModuleRecord = z.infer<typeof AcademyCourseModuleRecordSchema>;

/**
 * Module record WITH its ordered lessons — the shape nested inside the
 * course-detail tree (`GET /api/v1/admin/academy/courses/:courseId`). Lessons
 * are ordered by `sortPosition` ascending.
 */
export const AcademyCourseModuleWithLessonsSchema = AcademyCourseModuleRecordSchema.extend({
  lessons: z.array(AcademyLessonRecordSchema),
}).strict();
export type AcademyCourseModuleWithLessons = z.infer<typeof AcademyCourseModuleWithLessonsSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/academy/courses/:courseId/modules` body — append a new
 * module to a course. `sortPosition` is OPTIONAL: omitted appends after the
 * course's current last module (max + 1); supplied inserts at that position.
 */
export const CreateAcademyModuleRequestSchema = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema.optional(),
    sortPosition: SortPositionSchema.optional(),
  })
  .strict();
export type CreateAcademyModuleRequest = z.infer<typeof CreateAcademyModuleRequestSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/academy/modules/:moduleId` body — a partial update. At
 * least one field must be present. `description` accepts `null` to CLEAR it.
 */
export const UpdateAcademyModuleRequestSchema = z
  .object({
    title: TitleSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    sortPosition: SortPositionSchema.optional(),
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
export type UpdateAcademyModuleRequest = z.infer<typeof UpdateAcademyModuleRequestSchema>;

// ─── Response envelopes ───────────────────────────────────────────────────

/** Single-module envelope returned by create / update. */
export const AcademyModuleResponseSchema = z
  .object({ module: AcademyCourseModuleRecordSchema })
  .strict();
export type AcademyModuleResponse = z.infer<typeof AcademyModuleResponseSchema>;

/**
 * `GET /api/v1/admin/academy/courses/:courseId/modules` response — the course's
 * modules ordered by `sortPosition` ascending (shallow — no nested lessons; use
 * the course-detail endpoint for the full tree).
 */
export const AcademyModulesListResponseSchema = z
  .object({ modules: z.array(AcademyCourseModuleRecordSchema) })
  .strict();
export type AcademyModulesListResponse = z.infer<typeof AcademyModulesListResponseSchema>;

/**
 * `DELETE /api/v1/admin/academy/modules/:moduleId` response — confirms the
 * module was removed and reports how many lessons cascaded with it.
 */
export const DeleteAcademyModuleResponseSchema = z
  .object({
    deletedModuleId: ModuleIdSchema,
    deletedLessonCount: z.number().int().min(0),
  })
  .strict();
export type DeleteAcademyModuleResponse = z.infer<typeof DeleteAcademyModuleResponseSchema>;
