import { Injectable, Logger } from '@nestjs/common';
import type {
  AcademyLessonKind,
  AcademyLessonRecord,
  CreateAcademyLessonRequest,
  UpdateAcademyLessonRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/** Local mirror of the `academy_lessons` row (TS-021-followup-3 convention). */
export interface AcademyLessonRow {
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

export interface CreateLessonInput extends CreateAcademyLessonRequest {
  readonly moduleId: string;
  readonly actorUserId: string;
}

export interface UpdateLessonInput extends UpdateAcademyLessonRequest {
  readonly lessonId: string;
  readonly actorUserId: string;
}

export type CreateLessonOutcome =
  | { readonly ok: true; readonly lesson: AcademyLessonRecord }
  | { readonly ok: false; readonly reason: 'module_not_found' };

export type ListLessonsOutcome =
  | { readonly ok: true; readonly lessons: readonly AcademyLessonRecord[] }
  | { readonly ok: false; readonly reason: 'module_not_found' };

export type UpdateLessonOutcome =
  | { readonly ok: true; readonly lesson: AcademyLessonRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

export type DeleteLessonOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Academy lesson service (TS-251; PRD §9.2, §9.5; PDD §15.1).
 *
 * The leaf of the catalog hierarchy: create / list / edit / delete the ordered
 * lessons within a module. Content (`contentKey` for video; `bodyMarkdown` for
 * reading) is authored incrementally — no cross-field requirement is enforced.
 * Platform-wide catalog content (no tenant axis). Authorisation
 * (`academy:read` / `academy:write`) is enforced at the controller boundary.
 */
@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Append (or insert) a lesson. The parent module must exist. */
  async createLesson(input: CreateLessonInput): Promise<CreateLessonOutcome> {
    if (!(await this.moduleExists(input.moduleId))) {
      return { ok: false, reason: 'module_not_found' };
    }

    const sortPosition = input.sortPosition ?? (await this.nextSortPosition(input.moduleId));

    const created = (await this.prisma.academyLesson.create({
      data: {
        moduleId: input.moduleId,
        title: input.title,
        kind: input.kind,
        contentKey: input.contentKey ?? null,
        bodyMarkdown: input.bodyMarkdown ?? null,
        sortPosition,
        durationMinutes: input.durationMinutes ?? null,
      },
      select: LESSON_SELECT,
    })) as AcademyLessonRow;

    this.logger.log(
      {
        lessonId: created.id,
        moduleId: input.moduleId,
        kind: created.kind,
        actorUserId: input.actorUserId,
      },
      'academy lesson created',
    );
    return { ok: true, lesson: toLessonRecord(created) };
  }

  /** The module's lessons ordered by `sortPosition` ascending. */
  async listLessons(moduleId: string): Promise<ListLessonsOutcome> {
    if (!(await this.moduleExists(moduleId))) {
      return { ok: false, reason: 'module_not_found' };
    }
    const rows = (await this.prisma.academyLesson.findMany({
      where: { moduleId },
      orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
      select: LESSON_SELECT,
    })) as AcademyLessonRow[];
    return { ok: true, lessons: rows.map(toLessonRecord) };
  }

  /** Partial update of a lesson. */
  async updateLesson(input: UpdateLessonInput): Promise<UpdateLessonOutcome> {
    const current = (await this.prisma.academyLesson.findFirst({
      where: { id: input.lessonId },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data['title'] = input.title;
    if (input.kind !== undefined) data['kind'] = input.kind;
    if (input.contentKey !== undefined) data['contentKey'] = input.contentKey;
    if (input.bodyMarkdown !== undefined) data['bodyMarkdown'] = input.bodyMarkdown;
    if (input.sortPosition !== undefined) data['sortPosition'] = input.sortPosition;
    if (input.durationMinutes !== undefined) data['durationMinutes'] = input.durationMinutes;

    const updated = (await this.prisma.academyLesson.update({
      where: { id: input.lessonId },
      data,
      select: LESSON_SELECT,
    })) as AcademyLessonRow;

    this.logger.log(
      { lessonId: input.lessonId, actorUserId: input.actorUserId, fields: Object.keys(data) },
      'academy lesson updated',
    );
    return { ok: true, lesson: toLessonRecord(updated) };
  }

  /** Hard-delete a lesson (leaf node; nothing cascades). */
  async deleteLesson(lessonId: string, actorUserId: string): Promise<DeleteLessonOutcome> {
    const current = (await this.prisma.academyLesson.findFirst({
      where: { id: lessonId },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    await this.prisma.academyLesson.delete({ where: { id: lessonId } });

    this.logger.log({ lessonId, actorUserId }, 'academy lesson deleted');
    return { ok: true };
  }

  /** `true` when a module with this id exists. */
  private async moduleExists(moduleId: string): Promise<boolean> {
    const row = (await this.prisma.academyCourseModule.findFirst({
      where: { id: moduleId },
      select: { id: true },
    })) as { id: string } | null;
    return row !== null;
  }

  /** Next 0-based append position for the module's lessons. */
  private async nextSortPosition(moduleId: string): Promise<number> {
    const last = (await this.prisma.academyLesson.findFirst({
      where: { moduleId },
      orderBy: { sortPosition: 'desc' },
      select: { sortPosition: true },
    })) as { sortPosition: number } | null;
    return last === null ? 0 : last.sortPosition + 1;
  }
}

/** Project a persisted lesson row into the wire `AcademyLessonRecord`. */
export function toLessonRecord(row: AcademyLessonRow): AcademyLessonRecord {
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
