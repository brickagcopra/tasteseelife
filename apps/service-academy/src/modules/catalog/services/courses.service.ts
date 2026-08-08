import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionAcademyCourse,
  type AcademyCourseDetail,
  type AcademyCourseKind,
  type AcademyCourseRecord,
  type AcademyCourseStatus,
  type AcademyCourseTrack,
  type AcademyLessonKind,
  type CreateAcademyCourseRequest,
  type UpdateAcademyCourseRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the Prisma-generated `academy_courses` row, narrowed to the
 * columns this module reads / writes. Same TS-021-followup-3 rationale
 * documented across the codebase — Prisma's row types resolve inconsistently
 * under our tsconfig so we project shapes by hand (dropped on the next Prisma
 * bump — TS-251-followup-x).
 */
export interface AcademyCourseRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string | null;
  readonly kind: AcademyCourseKind;
  readonly track: AcademyCourseTrack;
  readonly status: AcademyCourseStatus;
  readonly level: string | null;
  readonly estimatedMinutes: number | null;
  readonly heroImageKey: string | null;
  readonly passingScorePercent: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

interface AcademyModuleRow {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly description: string | null;
  readonly sortPosition: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface AcademyLessonRow {
  readonly id: string;
  readonly moduleId: string;
  readonly title: string;
  readonly kind: AcademyLessonKind;
  readonly contentKey: string | null;
  readonly bodyMarkdown: string | null;
  readonly sortPosition: number;
  readonly durationMinutes: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const COURSE_SELECT = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  description: true,
  kind: true,
  track: true,
  status: true,
  level: true,
  estimatedMinutes: true,
  heroImageKey: true,
  passingScorePercent: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const MODULE_SELECT = {
  id: true,
  courseId: true,
  title: true,
  description: true,
  sortPosition: true,
  createdAt: true,
  updatedAt: true,
} as const;

const LESSON_SELECT = {
  id: true,
  moduleId: true,
  title: true,
  kind: true,
  contentKey: true,
  bodyMarkdown: true,
  sortPosition: true,
  durationMinutes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateCourseInput extends CreateAcademyCourseRequest {
  readonly actorUserId: string;
}

export interface ListCoursesInput {
  readonly status?: AcademyCourseStatus | undefined;
  readonly track?: AcademyCourseTrack | undefined;
  readonly kind?: AcademyCourseKind | undefined;
  readonly includeDeleted?: boolean | undefined;
  readonly limit: number;
}

export interface UpdateCourseInput extends UpdateAcademyCourseRequest {
  readonly courseId: string;
  readonly actorUserId: string;
}

export type CreateCourseOutcome =
  | { readonly ok: true; readonly course: AcademyCourseRecord }
  | { readonly ok: false; readonly reason: 'slug_conflict' };

export type GetCourseOutcome =
  | { readonly ok: true; readonly course: AcademyCourseDetail }
  | { readonly ok: false; readonly reason: 'not_found' };

export type UpdateCourseOutcome =
  | { readonly ok: true; readonly course: AcademyCourseRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'slug_conflict' }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: AcademyCourseStatus;
      readonly to: AcademyCourseStatus;
    };

export type DeleteCourseOutcome =
  | { readonly ok: true; readonly course: AcademyCourseRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'has_cohorts' };

/**
 * Academy course-catalog service (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 * Owns the top of the catalog hierarchy: create / list / detail-tree / edit /
 * archive (via status) / soft-delete a course. The course → module → lesson
 * tree is platform-wide catalog content (no tenant axis) so reads + writes do
 * not consult the TS-141 gate (the models are in `unscopedModels`).
 *
 * Authorisation lives at the controller boundary: every surface sits behind
 * `AccessTokenGuard` + `PermissionGuard` (`academy:read` / `academy:write`).
 * The service trusts the actor id it is handed (resolved from the verified
 * token), the same shape as the concierge `ScheduledEventsService`.
 */
@Injectable()
export class CoursesService {
  private readonly logger = new Logger(CoursesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Create a course. A slug already in use (incl. by a soft-deleted course) is a `slug_conflict`. */
  async createCourse(input: CreateCourseInput): Promise<CreateCourseOutcome> {
    const existing = (await this.prisma.academyCourse.findFirst({
      where: { slug: input.slug },
      select: { id: true },
    })) as { id: string } | null;
    if (existing !== null) return { ok: false, reason: 'slug_conflict' };

    let created: AcademyCourseRow;
    try {
      created = (await this.prisma.academyCourse.create({
        data: {
          slug: input.slug,
          title: input.title,
          summary: input.summary,
          description: input.description ?? null,
          kind: input.kind,
          track: input.track,
          status: input.status,
          level: input.level ?? null,
          estimatedMinutes: input.estimatedMinutes ?? null,
          heroImageKey: input.heroImageKey ?? null,
          passingScorePercent: input.passingScorePercent ?? null,
        },
        select: COURSE_SELECT,
      })) as AcademyCourseRow;
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'slug_conflict' };
      throw err;
    }

    this.logger.log(
      {
        courseId: created.id,
        slug: created.slug,
        status: created.status,
        actorUserId: input.actorUserId,
      },
      'academy course created',
    );
    return { ok: true, course: toCourseRecord(created) };
  }

  /** Matching courses ordered by `createdAt` descending (newest first). */
  async listCourses(input: ListCoursesInput): Promise<readonly AcademyCourseRecord[]> {
    const where: Record<string, unknown> = {};
    if (input.includeDeleted !== true) where['deletedAt'] = null;
    if (input.status !== undefined) where['status'] = input.status;
    if (input.track !== undefined) where['track'] = input.track;
    if (input.kind !== undefined) where['kind'] = input.kind;

    const rows = (await this.prisma.academyCourse.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      select: COURSE_SELECT,
    })) as AcademyCourseRow[];
    return rows.map(toCourseRecord);
  }

  /**
   * Course detail with its full module → lesson tree. Three bounded queries
   * (course, its modules, the modules' lessons) — never an N+1. A soft-deleted
   * course is `not_found` (use the list with `includeDeleted` to audit it).
   */
  async getCourseDetail(courseId: string): Promise<GetCourseOutcome> {
    const course = (await this.prisma.academyCourse.findFirst({
      where: { id: courseId, deletedAt: null },
      select: COURSE_SELECT,
    })) as AcademyCourseRow | null;
    if (course === null) return { ok: false, reason: 'not_found' };

    const modules = (await this.prisma.academyCourseModule.findMany({
      where: { courseId },
      orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
      select: MODULE_SELECT,
    })) as AcademyModuleRow[];

    const moduleIds = modules.map((m) => m.id);
    const lessons =
      moduleIds.length === 0
        ? []
        : ((await this.prisma.academyLesson.findMany({
            where: { moduleId: { in: moduleIds } },
            orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
            select: LESSON_SELECT,
          })) as AcademyLessonRow[]);

    const lessonsByModule = new Map<string, AcademyLessonRow[]>();
    for (const lesson of lessons) {
      const bucket = lessonsByModule.get(lesson.moduleId);
      if (bucket === undefined) lessonsByModule.set(lesson.moduleId, [lesson]);
      else bucket.push(lesson);
    }

    const detail: AcademyCourseDetail = {
      ...toCourseRecord(course),
      modules: modules.map((m) => ({
        ...toModuleRecord(m),
        lessons: (lessonsByModule.get(m.id) ?? []).map(toLessonRecord),
      })),
    };
    return { ok: true, course: detail };
  }

  /**
   * Apply a partial update. Resolution order:
   *   1. `not_found` — the course does not resolve (or is soft-deleted).
   *   2. `invalid_transition` — a `status` change disallowed by the matrix.
   *   3. `slug_conflict` — a `slug` edit collides with another course.
   * Only then does the write fire.
   */
  async updateCourse(input: UpdateCourseInput): Promise<UpdateCourseOutcome> {
    const current = (await this.prisma.academyCourse.findFirst({
      where: { id: input.courseId, deletedAt: null },
      select: { status: true, slug: true },
    })) as { status: AcademyCourseStatus; slug: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    if (input.status !== undefined && input.status !== current.status) {
      if (!canTransitionAcademyCourse(current.status, input.status)) {
        return { ok: false, reason: 'invalid_transition', from: current.status, to: input.status };
      }
    }

    if (input.slug !== undefined && input.slug !== current.slug) {
      const clash = (await this.prisma.academyCourse.findFirst({
        where: { slug: input.slug },
        select: { id: true },
      })) as { id: string } | null;
      if (clash !== null) return { ok: false, reason: 'slug_conflict' };
    }

    const data: Record<string, unknown> = {};
    if (input.slug !== undefined) data['slug'] = input.slug;
    if (input.title !== undefined) data['title'] = input.title;
    if (input.summary !== undefined) data['summary'] = input.summary;
    if (input.description !== undefined) data['description'] = input.description;
    if (input.kind !== undefined) data['kind'] = input.kind;
    if (input.track !== undefined) data['track'] = input.track;
    if (input.level !== undefined) data['level'] = input.level;
    if (input.estimatedMinutes !== undefined) data['estimatedMinutes'] = input.estimatedMinutes;
    if (input.heroImageKey !== undefined) data['heroImageKey'] = input.heroImageKey;
    if (input.passingScorePercent !== undefined)
      data['passingScorePercent'] = input.passingScorePercent;
    if (input.status !== undefined && input.status !== current.status)
      data['status'] = input.status;

    let updated: AcademyCourseRow;
    try {
      updated = (await this.prisma.academyCourse.update({
        where: { id: input.courseId },
        data,
        select: COURSE_SELECT,
      })) as AcademyCourseRow;
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'slug_conflict' };
      throw err;
    }

    this.logger.log(
      {
        courseId: input.courseId,
        actorUserId: input.actorUserId,
        from: current.status,
        to: updated.status,
        fields: Object.keys(data),
      },
      'academy course updated',
    );
    return { ok: true, course: toCourseRecord(updated) };
  }

  /**
   * Soft-delete a course (set `deletedAt`). Rejected with `has_cohorts` when a
   * non-deleted cohort still references it — a cohort run is a record we
   * preserve; archive (status) the course instead of deleting it. The status
   * lifecycle (`archived`) is the routine retire-from-catalog path; this is the
   * harder remove-from-admin-lists path.
   */
  async softDeleteCourse(courseId: string, actorUserId: string): Promise<DeleteCourseOutcome> {
    const current = (await this.prisma.academyCourse.findFirst({
      where: { id: courseId, deletedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const cohortCount = await this.prisma.academyCohort.count({
      where: { courseId, deletedAt: null },
    });
    if (cohortCount > 0) return { ok: false, reason: 'has_cohorts' };

    const deleted = (await this.prisma.academyCourse.update({
      where: { id: courseId },
      data: { deletedAt: new Date() },
      select: COURSE_SELECT,
    })) as AcademyCourseRow;

    this.logger.log({ courseId, actorUserId }, 'academy course soft-deleted');
    return { ok: true, course: toCourseRecord(deleted) };
  }
}

/** Project a persisted course row into the wire `AcademyCourseRecord`. */
export function toCourseRecord(row: AcademyCourseRow): AcademyCourseRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    description: row.description,
    kind: row.kind,
    track: row.track,
    status: row.status,
    level: row.level,
    estimatedMinutes: row.estimatedMinutes,
    heroImageKey: row.heroImageKey,
    passingScorePercent: row.passingScorePercent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

function toModuleRecord(row: AcademyModuleRow): {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  sortPosition: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    courseId: row.courseId,
    title: row.title,
    description: row.description,
    sortPosition: row.sortPosition,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toLessonRecord(row: AcademyLessonRow): {
  id: string;
  moduleId: string;
  title: string;
  kind: AcademyLessonKind;
  contentKey: string | null;
  bodyMarkdown: string | null;
  sortPosition: number;
  durationMinutes: number | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    moduleId: row.moduleId,
    title: row.title,
    kind: row.kind,
    contentKey: row.contentKey,
    bodyMarkdown: row.bodyMarkdown,
    sortPosition: row.sortPosition,
    durationMinutes: row.durationMinutes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Duck-typed Prisma unique-violation (P2002) narrowing — TS-021-followup-2
 * captures the cleanup to the canonical `instanceof
 * Prisma.PrismaClientKnownRequestError` check once the namespace value-side
 * resolves cleanly on the Prisma minor bump.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; name?: unknown };
  return candidate.code === 'P2002' && candidate.name === 'PrismaClientKnownRequestError';
}
