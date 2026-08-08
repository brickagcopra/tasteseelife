import { Injectable, Logger } from '@nestjs/common';
import type {
  AcademyCourseModuleRecord,
  CreateAcademyModuleRequest,
  UpdateAcademyModuleRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the `academy_course_modules` row (TS-021-followup-3
 * convention).
 */
export interface AcademyModuleRow {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly description: string | null;
  readonly sortPosition: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const MODULE_SELECT = {
  id: true,
  courseId: true,
  title: true,
  description: true,
  sortPosition: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateModuleInput extends CreateAcademyModuleRequest {
  readonly courseId: string;
  readonly actorUserId: string;
}

export interface UpdateModuleInput extends UpdateAcademyModuleRequest {
  readonly moduleId: string;
  readonly actorUserId: string;
}

export type CreateModuleOutcome =
  | { readonly ok: true; readonly module: AcademyCourseModuleRecord }
  | { readonly ok: false; readonly reason: 'course_not_found' };

export type ListModulesOutcome =
  | { readonly ok: true; readonly modules: readonly AcademyCourseModuleRecord[] }
  | { readonly ok: false; readonly reason: 'course_not_found' };

export type UpdateModuleOutcome =
  | { readonly ok: true; readonly module: AcademyCourseModuleRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

export type DeleteModuleOutcome =
  | { readonly ok: true; readonly deletedModuleId: string; readonly deletedLessonCount: number }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Academy course-module service (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 * The middle of the catalog hierarchy: create / list / edit / delete the
 * ordered modules within a course. A module delete cascades to its lessons
 * (the Prisma relation is `ON DELETE CASCADE`); the count is reported back.
 * Platform-wide catalog content (no tenant axis). Authorisation
 * (`academy:read` / `academy:write`) is enforced at the controller boundary.
 */
@Injectable()
export class ModulesService {
  private readonly logger = new Logger(ModulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Append (or insert) a module. The parent course must exist + be live. */
  async createModule(input: CreateModuleInput): Promise<CreateModuleOutcome> {
    if (!(await this.courseExists(input.courseId))) {
      return { ok: false, reason: 'course_not_found' };
    }

    const sortPosition = input.sortPosition ?? (await this.nextSortPosition(input.courseId));

    const created = (await this.prisma.academyCourseModule.create({
      data: {
        courseId: input.courseId,
        title: input.title,
        description: input.description ?? null,
        sortPosition,
      },
      select: MODULE_SELECT,
    })) as AcademyModuleRow;

    this.logger.log(
      { moduleId: created.id, courseId: input.courseId, actorUserId: input.actorUserId },
      'academy module created',
    );
    return { ok: true, module: toModuleRecord(created) };
  }

  /** The course's modules ordered by `sortPosition` ascending. */
  async listModules(courseId: string): Promise<ListModulesOutcome> {
    if (!(await this.courseExists(courseId))) {
      return { ok: false, reason: 'course_not_found' };
    }
    const rows = (await this.prisma.academyCourseModule.findMany({
      where: { courseId },
      orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
      select: MODULE_SELECT,
    })) as AcademyModuleRow[];
    return { ok: true, modules: rows.map(toModuleRecord) };
  }

  /** Partial update of a module. */
  async updateModule(input: UpdateModuleInput): Promise<UpdateModuleOutcome> {
    const current = (await this.prisma.academyCourseModule.findFirst({
      where: { id: input.moduleId },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data['title'] = input.title;
    if (input.description !== undefined) data['description'] = input.description;
    if (input.sortPosition !== undefined) data['sortPosition'] = input.sortPosition;

    const updated = (await this.prisma.academyCourseModule.update({
      where: { id: input.moduleId },
      data,
      select: MODULE_SELECT,
    })) as AcademyModuleRow;

    this.logger.log(
      { moduleId: input.moduleId, actorUserId: input.actorUserId, fields: Object.keys(data) },
      'academy module updated',
    );
    return { ok: true, module: toModuleRecord(updated) };
  }

  /** Delete a module; its lessons cascade. Reports the cascaded lesson count. */
  async deleteModule(moduleId: string, actorUserId: string): Promise<DeleteModuleOutcome> {
    const current = (await this.prisma.academyCourseModule.findFirst({
      where: { id: moduleId },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const deletedLessonCount = await this.prisma.academyLesson.count({ where: { moduleId } });
    await this.prisma.academyCourseModule.delete({ where: { id: moduleId } });

    this.logger.log(
      { moduleId, deletedLessonCount, actorUserId },
      'academy module deleted (lessons cascaded)',
    );
    return { ok: true, deletedModuleId: moduleId, deletedLessonCount };
  }

  /** `true` when a live (non-soft-deleted) course with this id exists. */
  private async courseExists(courseId: string): Promise<boolean> {
    const row = (await this.prisma.academyCourse.findFirst({
      where: { id: courseId, deletedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    return row !== null;
  }

  /** Next 0-based append position for the course's modules. */
  private async nextSortPosition(courseId: string): Promise<number> {
    const last = (await this.prisma.academyCourseModule.findFirst({
      where: { courseId },
      orderBy: { sortPosition: 'desc' },
      select: { sortPosition: true },
    })) as { sortPosition: number } | null;
    return last === null ? 0 : last.sortPosition + 1;
  }
}

/** Project a persisted module row into the wire `AcademyCourseModuleRecord`. */
export function toModuleRecord(row: AcademyModuleRow): AcademyCourseModuleRecord {
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
