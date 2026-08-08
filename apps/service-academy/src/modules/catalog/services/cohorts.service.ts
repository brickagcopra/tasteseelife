import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionAcademyCohort,
  isAcademyCohortTerminal,
  type AcademyCohortRecord,
  type AcademyCohortStatus,
  type CreateAcademyCohortRequest,
  type UpdateAcademyCohortRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/** Local mirror of the `academy_cohorts` row (TS-021-followup-3 convention). */
export interface AcademyCohortRow {
  readonly id: string;
  readonly courseId: string;
  readonly name: string;
  readonly status: AcademyCohortStatus;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly capacity: number | null;
  readonly instructorUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const COHORT_SELECT = {
  id: true,
  courseId: true,
  name: true,
  status: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
  instructorUserId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

export interface CreateCohortInput extends CreateAcademyCohortRequest {
  readonly courseId: string;
  readonly actorUserId: string;
}

export interface ListCohortsInput {
  readonly courseId: string;
  readonly status?: AcademyCohortStatus | undefined;
  readonly includeDeleted?: boolean | undefined;
  readonly limit: number;
}

export interface UpdateCohortInput extends UpdateAcademyCohortRequest {
  readonly cohortId: string;
  readonly actorUserId: string;
}

export type CreateCohortOutcome =
  | { readonly ok: true; readonly cohort: AcademyCohortRecord }
  | { readonly ok: false; readonly reason: 'course_not_found' };

export type ListCohortsOutcome =
  | { readonly ok: true; readonly cohorts: readonly AcademyCohortRecord[] }
  | { readonly ok: false; readonly reason: 'course_not_found' };

export type UpdateCohortOutcome =
  | { readonly ok: true; readonly cohort: AcademyCohortRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'terminal'; readonly status: AcademyCohortStatus }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: AcademyCohortStatus;
      readonly to: AcademyCohortStatus;
    }
  | { readonly ok: false; readonly reason: 'invalid_time_range' };

export type DeleteCohortOutcome =
  | { readonly ok: true; readonly cohort: AcademyCohortRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Academy cohort service (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 * A scheduled run of a cohort-based course: create / list / edit / soft-delete
 * a cohort, with a status-transition matrix (scheduled → open → in_progress →
 * completed; canceled) and a merged start/end monotonicity check. Platform-wide
 * catalog/operational content (no tenant axis). Authorisation (`academy:read` /
 * `academy:write`) is enforced at the controller boundary.
 */
@Injectable()
export class CohortsService {
  private readonly logger = new Logger(CohortsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Schedule a cohort for a course. The parent course must exist + be live. */
  async createCohort(input: CreateCohortInput): Promise<CreateCohortOutcome> {
    const course = (await this.prisma.academyCourse.findFirst({
      where: { id: input.courseId, deletedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    if (course === null) return { ok: false, reason: 'course_not_found' };

    const created = (await this.prisma.academyCohort.create({
      data: {
        courseId: input.courseId,
        name: input.name,
        status: input.status,
        startsAt: new Date(input.startsAt),
        endsAt: input.endsAt === undefined ? null : new Date(input.endsAt),
        capacity: input.capacity ?? null,
        instructorUserId: input.instructorUserId ?? null,
      },
      select: COHORT_SELECT,
    })) as AcademyCohortRow;

    this.logger.log(
      {
        cohortId: created.id,
        courseId: input.courseId,
        status: created.status,
        actorUserId: input.actorUserId,
      },
      'academy cohort created',
    );
    return { ok: true, cohort: toCohortRecord(created) };
  }

  /** The course's cohorts ordered by `startsAt` ascending (soonest first). */
  async listCohorts(input: ListCohortsInput): Promise<ListCohortsOutcome> {
    const course = (await this.prisma.academyCourse.findFirst({
      where: { id: input.courseId, deletedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    if (course === null) return { ok: false, reason: 'course_not_found' };

    const where: Record<string, unknown> = { courseId: input.courseId };
    if (input.includeDeleted !== true) where['deletedAt'] = null;
    if (input.status !== undefined) where['status'] = input.status;

    const rows = (await this.prisma.academyCohort.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: COHORT_SELECT,
    })) as AcademyCohortRow[];
    return { ok: true, cohorts: rows.map(toCohortRecord) };
  }

  /**
   * Apply a partial update. Resolution order:
   *   1. `not_found` — the cohort does not resolve (or is soft-deleted).
   *   2. `terminal` — a completed / canceled cohort rejects all edits.
   *   3. `invalid_transition` — a `status` change disallowed by the matrix.
   *   4. `invalid_time_range` — the merged start/end pair is non-monotonic.
   */
  async updateCohort(input: UpdateCohortInput): Promise<UpdateCohortOutcome> {
    const current = (await this.prisma.academyCohort.findFirst({
      where: { id: input.cohortId, deletedAt: null },
      select: { status: true, startsAt: true, endsAt: true },
    })) as { status: AcademyCohortStatus; startsAt: Date; endsAt: Date | null } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    if (isAcademyCohortTerminal(current.status)) {
      return { ok: false, reason: 'terminal', status: current.status };
    }

    if (input.status !== undefined && input.status !== current.status) {
      if (!canTransitionAcademyCohort(current.status, input.status)) {
        return { ok: false, reason: 'invalid_transition', from: current.status, to: input.status };
      }
    }

    const effectiveStart =
      input.startsAt !== undefined ? new Date(input.startsAt) : current.startsAt;
    const effectiveEnd =
      input.endsAt !== undefined
        ? input.endsAt === null
          ? null
          : new Date(input.endsAt)
        : current.endsAt;
    if (effectiveEnd !== null && effectiveEnd.getTime() <= effectiveStart.getTime()) {
      return { ok: false, reason: 'invalid_time_range' };
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.startsAt !== undefined) data['startsAt'] = new Date(input.startsAt);
    if (input.endsAt !== undefined) {
      data['endsAt'] = input.endsAt === null ? null : new Date(input.endsAt);
    }
    if (input.capacity !== undefined) data['capacity'] = input.capacity;
    if (input.instructorUserId !== undefined) data['instructorUserId'] = input.instructorUserId;
    if (input.status !== undefined && input.status !== current.status)
      data['status'] = input.status;

    const updated = (await this.prisma.academyCohort.update({
      where: { id: input.cohortId },
      data,
      select: COHORT_SELECT,
    })) as AcademyCohortRow;

    this.logger.log(
      {
        cohortId: input.cohortId,
        actorUserId: input.actorUserId,
        from: current.status,
        to: updated.status,
        fields: Object.keys(data),
      },
      'academy cohort updated',
    );
    return { ok: true, cohort: toCohortRecord(updated) };
  }

  /** Soft-delete a cohort (set `deletedAt`), preserving its run history. */
  async softDeleteCohort(cohortId: string, actorUserId: string): Promise<DeleteCohortOutcome> {
    const current = (await this.prisma.academyCohort.findFirst({
      where: { id: cohortId, deletedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const deleted = (await this.prisma.academyCohort.update({
      where: { id: cohortId },
      data: { deletedAt: new Date() },
      select: COHORT_SELECT,
    })) as AcademyCohortRow;

    this.logger.log({ cohortId, actorUserId }, 'academy cohort soft-deleted');
    return { ok: true, cohort: toCohortRecord(deleted) };
  }
}

/** Project a persisted cohort row into the wire `AcademyCohortRecord`. */
export function toCohortRecord(row: AcademyCohortRow): AcademyCohortRecord {
  return {
    id: row.id,
    courseId: row.courseId,
    name: row.name,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
    capacity: row.capacity,
    instructorUserId: row.instructorUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}
