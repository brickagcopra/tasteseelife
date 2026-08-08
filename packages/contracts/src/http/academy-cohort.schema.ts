import { z } from 'zod';

import { ACADEMY_COURSE_ID_MAX_LENGTH } from './academy-course.schema';

/**
 * Academy cohort HTTP DTOs (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 * A cohort is a scheduled run of a cohort-based (or in-person) course — a peer
 * group moving through the course between a start and end date, optionally with
 * a live instructor (TS-253). The course-catalog admin tooling manages a
 * course's cohorts: create, edit the start / end / capacity / instructor, and
 * drive the lifecycle status.
 *
 * **Platform-wide catalog/operational content.** A cohort carries no tenant
 * axis (the `AcademyCohort` Prisma model is in service-academy's
 * `unscopedModels`) — students bind to a cohort via their per-student
 * `AcademyEnrollment` (a TS-252 concern), not by the cohort itself.
 *
 * **Instructor.** `instructorUserId` is a soft reference into `identity.users`
 * (a cross-service id, never a join) — null while unassigned. The admin tooling
 * sets it; service-academy does not validate the id exists (no cross-service
 * read; CLAUDE.md §2.3 — a stale id surfaces when the instructor surface lands
 * in TS-253).
 *
 * **Lifecycle.** `scheduled` → `open` → `in_progress` → `completed`; `canceled`
 * is reachable from any non-terminal state. `completed` + `canceled` are
 * terminal (no edits) — see `ACADEMY_COHORT_STATUS_TRANSITIONS`. Distinct from
 * the `deletedAt` soft-delete tombstone.
 *
 * **Authorisation.** Every endpoint consuming these DTOs is gated on
 * `academy:read` / `academy:write` via `@RequirePermissions(...)` +
 * `PermissionGuard` (CLAUDE.md §3.2).
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped cohort row id cap. */
export const ACADEMY_COHORT_ID_MAX_LENGTH = 36;

/** Cohort name (e.g. "Spring 2026 — Tuesday evenings"). */
export const ACADEMY_COHORT_NAME_MAX_LENGTH = 160;

/** Soft reference into `identity.users.id` — the assigned instructor. */
export const ACADEMY_COHORT_INSTRUCTOR_ID_MAX_LENGTH = 36;

/** Maximum seats in a cohort. */
export const ACADEMY_COHORT_CAPACITY_MAX = 100_000;

/** Admin cohorts-list caps. Bounded, no cursor at Phase-1 volume. */
export const ACADEMY_COHORTS_LIST_LIMIT_DEFAULT = 50;
export const ACADEMY_COHORTS_LIST_LIMIT_MAX = 200;

// ─── Enum (mirrors the Prisma enum) ──────────────────────────────────────

/**
 * Cohort run lifecycle — mirrors the `AcademyCohortStatus` Prisma enum (PRD
 * §9.1). `scheduled` (dates set, enrollment not yet open) → `open` (accepting
 * enrollments) → `in_progress` (running) → `completed` (terminal); `canceled`
 * is terminal and reachable from any non-terminal state. Additive only.
 */
export const AcademyCohortStatusSchema = z.enum([
  'scheduled',
  'open',
  'in_progress',
  'completed',
  'canceled',
]);
export type AcademyCohortStatus = z.infer<typeof AcademyCohortStatusSchema>;

/**
 * The status a cohort may be CREATED in — `scheduled` (the default) or `open`
 * (create-and-open-for-enrollment). A cohort cannot be created straight into a
 * running / terminal state.
 */
export const InitialAcademyCohortStatusSchema = z.enum(['scheduled', 'open']);
export type InitialAcademyCohortStatus = z.infer<typeof InitialAcademyCohortStatusSchema>;

// ─── Status-transition policy ───────────────────────────────────────────

/**
 * Allowed cohort status transitions, keyed by the current status. `completed`
 * + `canceled` are terminal (no outbound transitions, no field edits). Shared
 * between the service (enforces the matrix) and the web-admin UI (renders only
 * the valid actions) so the two never drift.
 */
export const ACADEMY_COHORT_STATUS_TRANSITIONS = {
  scheduled: ['open', 'canceled'],
  open: ['in_progress', 'canceled'],
  in_progress: ['completed', 'canceled'],
  completed: [],
  canceled: [],
} as const satisfies Record<AcademyCohortStatus, readonly AcademyCohortStatus[]>;

/** `true` when `from → to` is an allowed cohort status transition. */
export function canTransitionAcademyCohort(
  from: AcademyCohortStatus,
  to: AcademyCohortStatus,
): boolean {
  return (ACADEMY_COHORT_STATUS_TRANSITIONS[from] as readonly AcademyCohortStatus[]).includes(to);
}

/** Terminal statuses — no further transition, no field edits. */
export const ACADEMY_COHORT_TERMINAL_STATUSES = ['completed', 'canceled'] as const;

/** `true` when the cohort can no longer be acted on (completed / canceled). */
export function isAcademyCohortTerminal(status: AcademyCohortStatus): boolean {
  return (ACADEMY_COHORT_TERMINAL_STATUSES as readonly AcademyCohortStatus[]).includes(status);
}

// ─── Field schemas ─────────────────────────────────────────────────────────

const CohortIdSchema = z.string().min(1).max(ACADEMY_COHORT_ID_MAX_LENGTH);
const CourseIdSchema = z.string().min(1).max(ACADEMY_COURSE_ID_MAX_LENGTH);
const NameSchema = z
  .string()
  .trim()
  .min(1, 'a name is required')
  .max(ACADEMY_COHORT_NAME_MAX_LENGTH);
const InstructorUserIdSchema = z.string().min(1).max(ACADEMY_COHORT_INSTRUCTOR_ID_MAX_LENGTH);
const CapacitySchema = z.number().int().min(1).max(ACADEMY_COHORT_CAPACITY_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shape ───────────────────────────────────────────────────────

/**
 * Full cohort record returned by the list + the single-cohort create / update
 * / delete envelopes.
 *
 *   - `startsAt` / `endsAt` — the run window; `endsAt` is null when only a
 *     start is known.
 *   - `capacity` — max seats; null = uncapped.
 *   - `instructorUserId` — soft reference into `identity.users`; null while
 *     unassigned.
 *   - `deletedAt` — soft-delete tombstone (null for a live cohort).
 */
export const AcademyCohortRecordSchema = z
  .object({
    id: CohortIdSchema,
    courseId: CourseIdSchema,
    name: NameSchema,
    status: AcademyCohortStatusSchema,
    startsAt: TimestampSchema,
    endsAt: TimestampSchema.nullable(),
    capacity: CapacitySchema.nullable(),
    instructorUserId: InstructorUserIdSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: TimestampSchema.nullable(),
  })
  .strict();
export type AcademyCohortRecord = z.infer<typeof AcademyCohortRecordSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/academy/courses/:courseId/cohorts` body — schedule a new
 * cohort for a course. `status` defaults to `scheduled`; a cohort may be
 * created directly as `open`. When `endsAt` is supplied it must be after
 * `startsAt`.
 */
export const CreateAcademyCohortRequestSchema = z
  .object({
    name: NameSchema,
    startsAt: TimestampSchema,
    endsAt: TimestampSchema.optional(),
    capacity: CapacitySchema.optional(),
    instructorUserId: InstructorUserIdSchema.optional(),
    status: InitialAcademyCohortStatusSchema.default('scheduled'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endsAt !== undefined && !isAfter(value.endsAt, value.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'endsAt must be after startsAt',
      });
    }
  });
export type CreateAcademyCohortRequest = z.infer<typeof CreateAcademyCohortRequestSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/academy/cohorts/:cohortId` body — a partial update. At
 * least one field must be present. Nullable fields (`endsAt`, `capacity`,
 * `instructorUserId`) accept `null` to CLEAR the value. A `status` change must
 * be an allowed transition from the cohort's current status (validated
 * server-side; a disallowed move is a 409); a terminal (completed / canceled)
 * cohort rejects all edits (409). When both `startsAt` and `endsAt` are present
 * `endsAt` must be after `startsAt`; the service re-checks the merged pair.
 */
export const UpdateAcademyCohortRequestSchema = z
  .object({
    name: NameSchema.optional(),
    startsAt: TimestampSchema.optional(),
    endsAt: TimestampSchema.nullable().optional(),
    capacity: CapacitySchema.nullable().optional(),
    instructorUserId: InstructorUserIdSchema.nullable().optional(),
    status: AcademyCohortStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one field must be supplied',
      });
    }
    if (
      value.startsAt !== undefined &&
      value.endsAt !== undefined &&
      value.endsAt !== null &&
      !isAfter(value.endsAt, value.startsAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'endsAt must be after startsAt',
      });
    }
  });
export type UpdateAcademyCohortRequest = z.infer<typeof UpdateAcademyCohortRequestSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/academy/courses/:courseId/cohorts` query. With no filters
 * the list returns the course's live cohorts ordered by `startsAt` ascending
 * (soonest first). `status` narrows by lifecycle; `includeDeleted=true` widens
 * to include soft-deleted cohorts.
 */
export const ListAcademyCohortsQuerySchema = z
  .object({
    status: AcademyCohortStatusSchema.optional(),
    includeDeleted: z.coerce.boolean().optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ACADEMY_COHORTS_LIST_LIMIT_MAX)
      .default(ACADEMY_COHORTS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListAcademyCohortsQuery = z.infer<typeof ListAcademyCohortsQuerySchema>;

// ─── Response envelopes ───────────────────────────────────────────────────

/** Single-cohort envelope returned by create / update / delete. */
export const AcademyCohortResponseSchema = z.object({ cohort: AcademyCohortRecordSchema }).strict();
export type AcademyCohortResponse = z.infer<typeof AcademyCohortResponseSchema>;

/** `GET .../courses/:courseId/cohorts` response — the course's cohorts. */
export const AcademyCohortsListResponseSchema = z
  .object({ cohorts: z.array(AcademyCohortRecordSchema) })
  .strict();
export type AcademyCohortsListResponse = z.infer<typeof AcademyCohortsListResponseSchema>;

/** `true` when ISO timestamp `a` is strictly after ISO timestamp `b`. */
function isAfter(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}
