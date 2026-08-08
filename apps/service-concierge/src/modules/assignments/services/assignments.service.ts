import { Injectable, Logger } from '@nestjs/common';
import type { ConciergeAssignmentRecord } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `concierge_assignments` row,
 * narrowed to the columns this module reads / writes. Same
 * TS-021-followup-3 rationale documented across the codebase — Prisma's
 * row types resolve inconsistently under our tsconfig so we project
 * shapes by hand.
 */
export interface ConciergeAssignmentRow {
  readonly id: string;
  readonly householdId: string;
  readonly primaryConciergeUserId: string;
  readonly primaryConciergeDisplayName: string;
  readonly backupConciergeUserId: string | null;
  readonly backupConciergeDisplayName: string | null;
  readonly status: 'active' | 'ended';
  readonly assignedByUserId: string | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const ASSIGNMENT_SELECT = {
  id: true,
  householdId: true,
  primaryConciergeUserId: true,
  primaryConciergeDisplayName: true,
  backupConciergeUserId: true,
  backupConciergeDisplayName: true,
  status: true,
  assignedByUserId: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

export interface CreateAssignmentInput {
  readonly householdId: string;
  readonly primaryConciergeUserId: string;
  readonly primaryConciergeDisplayName: string;
  readonly backupConciergeUserId: string | null;
  readonly backupConciergeDisplayName: string | null;
  /** The admin (super_admin) who made the assignment; null for direct internal calls. */
  readonly assignedByUserId: string | null;
}

export interface ListAssignmentsInput {
  readonly householdId: string;
  readonly activeOnly: boolean;
  readonly limit: number;
}

export type CreateAssignmentFailure = { readonly reason: 'conflict' };

/** Result of ending an assignment — idempotent. */
export type EndAssignmentOutcome = 'ended' | 'already_ended' | 'not_found';

/** Postgres unique-violation error code surfaced by Prisma as `P2002`. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Dedicated culinary-concierge assignment service (TS-222; PRD §5.1
 * Tier 3, §6.6; PDD §10.6).
 *
 * Owns the assignment lifecycle:
 *   - `create` — assign (or replace) the dedicated concierge for a
 *     household. Ends any prior active row and inserts a fresh active row
 *     in one transaction so the single-active invariant holds and the
 *     history is preserved (PDD §17).
 *   - `getActiveForHousehold` — the family "Your concierge" card read.
 *   - `listForHousehold` — the admin per-household history read.
 *   - `endAssignment` — end the active row without a replacement (e.g. a
 *     household downgrades out of Tier 3). Idempotent.
 *
 * Row-level authorisation lives at the controller boundary (admin gate
 * for the write surfaces; the household-scoped token for the family
 * read). The service trusts the household id it is handed.
 */
@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Assign (or replace) the household's dedicated concierge. Ends any
   * prior active assignment and inserts a fresh active row atomically.
   * Returns `conflict` only on the rare create/create race that trips the
   * partial unique index (the in-transaction end-then-insert resolves the
   * common reassignment path cleanly).
   */
  async create(
    input: CreateAssignmentInput,
  ): Promise<Result<ConciergeAssignmentRecord, CreateAssignmentFailure>> {
    const now = new Date();
    try {
      const created = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<ConciergeAssignmentRow> => {
          // End every prior active assignment for the household so the
          // single-active invariant holds before we insert the new row.
          await tx.conciergeAssignment.updateMany({
            where: { householdId: input.householdId, status: 'active', deletedAt: null },
            data: { status: 'ended', endedAt: now },
          });

          const row = (await tx.conciergeAssignment.create({
            data: {
              householdId: input.householdId,
              primaryConciergeUserId: input.primaryConciergeUserId,
              primaryConciergeDisplayName: input.primaryConciergeDisplayName,
              backupConciergeUserId: input.backupConciergeUserId,
              backupConciergeDisplayName: input.backupConciergeDisplayName,
              status: 'active',
              assignedByUserId: input.assignedByUserId,
              startedAt: now,
            },
            select: ASSIGNMENT_SELECT,
          })) as ConciergeAssignmentRow;
          return row;
        },
      );

      this.logger.log(
        { householdId: input.householdId, assignmentId: created.id },
        'concierge assignment created',
      );
      return ok(toRecord(created));
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        this.logger.warn(
          { householdId: input.householdId },
          'concierge assignment create lost a single-active race (P2002)',
        );
        return err({ reason: 'conflict' });
      }
      throw cause;
    }
  }

  /** The household's single active assignment, or `null`. */
  async getActiveForHousehold(householdId: string): Promise<ConciergeAssignmentRecord | null> {
    const row = (await this.prisma.conciergeAssignment.findFirst({
      where: { householdId, status: 'active', deletedAt: null },
      select: ASSIGNMENT_SELECT,
    })) as ConciergeAssignmentRow | null;
    return row === null ? null : toRecord(row);
  }

  /**
   * The household's assignment history ordered active-first then by
   * `started_at` descending. `activeOnly` restricts to the single active
   * row.
   */
  async listForHousehold(
    input: ListAssignmentsInput,
  ): Promise<readonly ConciergeAssignmentRecord[]> {
    const rows = (await this.prisma.conciergeAssignment.findMany({
      where: {
        householdId: input.householdId,
        deletedAt: null,
        ...(input.activeOnly ? { status: 'active' } : {}),
      },
      // `active` sorts before `ended` alphabetically, so a status ASC sort
      // pins the live row to the top; ties broken by recency.
      orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
      take: input.limit,
      select: ASSIGNMENT_SELECT,
    })) as ConciergeAssignmentRow[];
    return rows.map(toRecord);
  }

  /**
   * End an assignment by id. Idempotent: ending an already-ended row
   * returns `already_ended`; an unknown / soft-deleted id returns
   * `not_found`.
   */
  async endAssignment(assignmentId: string): Promise<EndAssignmentOutcome> {
    const existing = (await this.prisma.conciergeAssignment.findFirst({
      where: { id: assignmentId, deletedAt: null },
      select: { id: true, status: true },
    })) as { id: string; status: 'active' | 'ended' } | null;

    if (existing === null) return 'not_found';
    if (existing.status === 'ended') return 'already_ended';

    await this.prisma.conciergeAssignment.update({
      where: { id: assignmentId },
      data: { status: 'ended', endedAt: new Date() },
      select: { id: true },
    });
    this.logger.log({ assignmentId }, 'concierge assignment ended');
    return 'ended';
  }
}

/** Project a persisted row into the wire `ConciergeAssignmentRecord`. */
function toRecord(row: ConciergeAssignmentRow): ConciergeAssignmentRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    primaryConciergeUserId: row.primaryConciergeUserId,
    primaryConciergeDisplayName: row.primaryConciergeDisplayName,
    backupConciergeUserId: row.backupConciergeUserId,
    backupConciergeDisplayName: row.backupConciergeDisplayName,
    status: row.status,
    assignedByUserId: row.assignedByUserId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Narrow an unknown thrown value to a Prisma unique-constraint violation
 * (`P2002`) without importing `Prisma.PrismaClientKnownRequestError`
 * (TS-021-followup-2 — the instanceof check resolves inconsistently under
 * our tsconfig, so we duck-type the `code` property).
 */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}
