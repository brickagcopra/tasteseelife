import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionConciergeEnrichmentSummary,
  type ConciergeEnrichmentSummaryRecord,
  type ConciergeEnrichmentSummaryStatus,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the Prisma-generated row, narrowed to the columns this module
 * reads / writes. Same TS-021-followup-3 rationale documented across the
 * codebase — Prisma's row types resolve inconsistently under our tsconfig, so
 * we project shapes by hand (dropped on the next Prisma bump — followup).
 */
interface ConciergeEnrichmentSummaryRow {
  readonly id: string;
  readonly householdId: string;
  readonly weekStartDate: Date;
  readonly status: ConciergeEnrichmentSummaryStatus;
  readonly headline: string;
  readonly visitHighlights: string;
  readonly wellnessSignals: string;
  readonly socialEngagement: string;
  readonly additionalNotes: string | null;
  readonly authoredByUserId: string | null;
  readonly publishedAt: Date | null;
  readonly publishedByUserId: string | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const SUMMARY_SELECT = {
  id: true,
  householdId: true,
  weekStartDate: true,
  status: true,
  headline: true,
  visitHighlights: true,
  wellnessSignals: true,
  socialEngagement: true,
  additionalNotes: true,
  authoredByUserId: true,
  publishedAt: true,
  publishedByUserId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Postgres unique-violation error code surfaced by Prisma as `P2002`. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

export interface CreateSummaryInput {
  readonly householdId: string;
  /** Monday-anchored `YYYY-MM-DD` (validated at the controller boundary). */
  readonly weekStartDate: string;
  readonly headline: string;
  readonly visitHighlights: string;
  readonly wellnessSignals: string;
  readonly socialEngagement: string;
  readonly additionalNotes?: string | undefined;
  /** The concierge authoring the summary — from the verified token. */
  readonly actorUserId: string;
}

export interface ListSummariesInput {
  readonly householdId?: string | undefined;
  readonly status?: ConciergeEnrichmentSummaryStatus | undefined;
  readonly limit: number;
}

export interface UpdateSummaryInput {
  readonly summaryId: string;
  readonly headline?: string | undefined;
  readonly visitHighlights?: string | undefined;
  readonly wellnessSignals?: string | undefined;
  readonly socialEngagement?: string | undefined;
  /** `undefined` = leave; `null` = clear; string = set. */
  readonly additionalNotes?: string | null | undefined;
  /** `undefined` = leave the status; otherwise drive the lifecycle transition. */
  readonly status?: ConciergeEnrichmentSummaryStatus | undefined;
  /** The concierge making the edit — from the verified token. */
  readonly actorUserId: string;
}

export type CreateSummaryOutcome =
  | { readonly ok: true; readonly summary: ConciergeEnrichmentSummaryRecord }
  | { readonly ok: false; readonly reason: 'week_taken' };

export type UpdateSummaryOutcome =
  | { readonly ok: true; readonly summary: ConciergeEnrichmentSummaryRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: ConciergeEnrichmentSummaryStatus;
      readonly to: ConciergeEnrichmentSummaryStatus;
    };

/**
 * Tier-3 weekly enrichment-summary service (TS-229; PRD §5.1 Tier 3, §6.9; PDD
 * §12.1).
 *
 * Owns the summary lifecycle:
 *   - `createSummary`  — open a new weekly summary as a `draft`. The
 *     one-per-household-week partial unique index rejects a second summary for
 *     the same week (`week_taken`).
 *   - `listSummaries`  — admin ops list (newest-week-first, filterable by
 *     household / status).
 *   - `getSummary`     — admin detail read by id, or `null`.
 *   - `updateSummary`  — edit the narrative fields + drive the status
 *     transition (publish / unpublish / archive), stamping `published_at` /
 *     `published_by_user_id` / `archived_at` accordingly.
 *   - `listPublishedForHousehold` — the family dashboard read (PUBLISHED only).
 *   - `getPublishedForHousehold`  — the family permalink read (one PUBLISHED
 *     summary scoped to the household; `null` otherwise — no oracle).
 *
 * Authorisation lives at the controller boundary: the admin surfaces gate on
 * `concierge:read` / `concierge:write`; the family reads are household-scoped
 * via the token. The service trusts the household / actor ids it is handed.
 */
@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a new weekly summary as a `draft`. Returns `week_taken` when the
   * household already has a non-deleted summary for the same week (the partial
   * unique index trips → P2002).
   */
  async createSummary(input: CreateSummaryInput): Promise<CreateSummaryOutcome> {
    try {
      const created = (await this.prisma.conciergeEnrichmentSummary.create({
        data: {
          householdId: input.householdId,
          weekStartDate: weekStartToDate(input.weekStartDate),
          status: 'draft',
          headline: input.headline,
          visitHighlights: input.visitHighlights,
          wellnessSignals: input.wellnessSignals,
          socialEngagement: input.socialEngagement,
          additionalNotes: input.additionalNotes ?? null,
          authoredByUserId: input.actorUserId,
        },
        select: SUMMARY_SELECT,
      })) as ConciergeEnrichmentSummaryRow;

      this.logger.log(
        {
          summaryId: created.id,
          householdId: input.householdId,
          weekStartDate: input.weekStartDate,
          actorUserId: input.actorUserId,
        },
        'concierge enrichment summary created (draft)',
      );
      return { ok: true, summary: toRecord(created) };
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        this.logger.warn(
          { householdId: input.householdId, weekStartDate: input.weekStartDate },
          'concierge enrichment summary create rejected — household already has a summary for this week (P2002)',
        );
        return { ok: false, reason: 'week_taken' };
      }
      throw cause;
    }
  }

  /** Admin list — matching summaries, newest-week-first. */
  async listSummaries(
    input: ListSummariesInput,
  ): Promise<readonly ConciergeEnrichmentSummaryRecord[]> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (input.householdId !== undefined) where['householdId'] = input.householdId;
    if (input.status !== undefined) where['status'] = input.status;

    const rows = (await this.prisma.conciergeEnrichmentSummary.findMany({
      where,
      orderBy: [{ weekStartDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      select: SUMMARY_SELECT,
    })) as ConciergeEnrichmentSummaryRow[];

    return rows.map(toRecord);
  }

  /** Admin detail read by id — or `null` when missing / soft-deleted. */
  async getSummary(summaryId: string): Promise<ConciergeEnrichmentSummaryRecord | null> {
    const row = (await this.prisma.conciergeEnrichmentSummary.findFirst({
      where: { id: summaryId, deletedAt: null },
      select: SUMMARY_SELECT,
    })) as ConciergeEnrichmentSummaryRow | null;
    return row === null ? null : toRecord(row);
  }

  /**
   * Edit the narrative fields and/or drive a status transition. Resolution
   * order:
   *   1. `not_found` — the summary does not resolve (or is soft-deleted).
   *   2. `invalid_transition` — the requested `status` is not reachable from
   *      the current state (today every distinct transition is allowed; the
   *      guard is defence-in-depth + future-proofing).
   * Then the write fires. Publishing stamps `published_at` +
   * `published_by_user_id`; archiving stamps `archived_at`; unpublishing back
   * to `draft` clears both. A `status` equal to the current state is a no-op
   * (the stamps are left untouched).
   */
  async updateSummary(input: UpdateSummaryInput): Promise<UpdateSummaryOutcome> {
    const current = (await this.prisma.conciergeEnrichmentSummary.findFirst({
      where: { id: input.summaryId, deletedAt: null },
      select: { id: true, status: true },
    })) as { id: string; status: ConciergeEnrichmentSummaryStatus } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const data: Record<string, unknown> = {};
    if (input.headline !== undefined) data['headline'] = input.headline;
    if (input.visitHighlights !== undefined) data['visitHighlights'] = input.visitHighlights;
    if (input.wellnessSignals !== undefined) data['wellnessSignals'] = input.wellnessSignals;
    if (input.socialEngagement !== undefined) data['socialEngagement'] = input.socialEngagement;
    if (input.additionalNotes !== undefined) data['additionalNotes'] = input.additionalNotes;

    const transitioning = input.status !== undefined && input.status !== current.status;
    if (transitioning) {
      const to = input.status as ConciergeEnrichmentSummaryStatus;
      if (!canTransitionConciergeEnrichmentSummary(current.status, to)) {
        return { ok: false, reason: 'invalid_transition', from: current.status, to };
      }
      data['status'] = to;
      const now = new Date();
      if (to === 'published') {
        data['publishedAt'] = now;
        data['publishedByUserId'] = input.actorUserId;
        data['archivedAt'] = null;
      } else if (to === 'archived') {
        data['archivedAt'] = now;
      } else {
        // Back to draft — withdraw from the family view entirely.
        data['publishedAt'] = null;
        data['publishedByUserId'] = null;
        data['archivedAt'] = null;
      }
    }

    const updated = (await this.prisma.conciergeEnrichmentSummary.update({
      where: { id: input.summaryId },
      data,
      select: SUMMARY_SELECT,
    })) as ConciergeEnrichmentSummaryRow;

    this.logger.log(
      {
        summaryId: input.summaryId,
        actorUserId: input.actorUserId,
        transitionedTo: transitioning ? input.status : undefined,
        fields: Object.keys(data),
      },
      'concierge enrichment summary updated',
    );
    return { ok: true, summary: toRecord(updated) };
  }

  /** Family dashboard read — the household's PUBLISHED summaries, newest-week-first. */
  async listPublishedForHousehold(
    householdId: string,
    limit: number,
  ): Promise<readonly ConciergeEnrichmentSummaryRecord[]> {
    const rows = (await this.prisma.conciergeEnrichmentSummary.findMany({
      where: { householdId, status: 'published', deletedAt: null },
      orderBy: [{ weekStartDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: SUMMARY_SELECT,
    })) as ConciergeEnrichmentSummaryRow[];
    return rows.map(toRecord);
  }

  /**
   * Family permalink read — one PUBLISHED summary scoped to the household, or
   * `null`. A draft / archived / foreign / missing id all return `null` so the
   * permalink leaks no oracle.
   */
  async getPublishedForHousehold(
    householdId: string,
    summaryId: string,
  ): Promise<ConciergeEnrichmentSummaryRecord | null> {
    const row = (await this.prisma.conciergeEnrichmentSummary.findFirst({
      where: { id: summaryId, householdId, status: 'published', deletedAt: null },
      select: SUMMARY_SELECT,
    })) as ConciergeEnrichmentSummaryRow | null;
    return row === null ? null : toRecord(row);
  }
}

/** Parse a Monday-anchored `YYYY-MM-DD` into a UTC-midnight `Date` for the `@db.Date` column. */
function weekStartToDate(weekStartDate: string): Date {
  return new Date(`${weekStartDate}T00:00:00.000Z`);
}

/** Project the `@db.Date` column back to the `YYYY-MM-DD` wire form. */
function dateToWeekStart(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Project a summary row into the wire record. */
function toRecord(row: ConciergeEnrichmentSummaryRow): ConciergeEnrichmentSummaryRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    weekStartDate: dateToWeekStart(row.weekStartDate),
    status: row.status,
    headline: row.headline,
    visitHighlights: row.visitHighlights,
    wellnessSignals: row.wellnessSignals,
    socialEngagement: row.socialEngagement,
    additionalNotes: row.additionalNotes,
    authoredByUserId: row.authoredByUserId,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    publishedByUserId: row.publishedByUserId,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Narrow an unknown thrown value to a Prisma unique-constraint violation
 * (`P2002`) without importing `Prisma.PrismaClientKnownRequestError`
 * (TS-021-followup-2 — the instanceof check resolves inconsistently under our
 * tsconfig, so we duck-type the `code` property).
 */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}
