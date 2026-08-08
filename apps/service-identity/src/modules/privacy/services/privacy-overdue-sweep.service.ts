import { Injectable } from '@nestjs/common';
import {
  TERMINAL_DATA_SUBJECT_REQUEST_STATUSES,
  type DataSubjectKind,
  type DataSubjectRequestKind,
  type DataSubjectRequestStatus,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The slice of an overdue request that may be logged.
 *
 * **What is absent is the design.** No `note`, no `verificationMethod`, no
 * `refusalNote` — three free-text fields written by people, which the
 * lifecycle service already refuses to log or put on an event (CLAUDE.md
 * §3.9). No `subjectId` and no `requesterUserId` either: an operator
 * following up opens the request by `id` in the console, where the read is
 * gated `privacy:read`, and a log stream replicates far wider than that
 * table does. What is here answers "how late, and how bad" without naming
 * anybody.
 */
export interface OverdueRequestRow {
  readonly id: string;
  readonly kind: DataSubjectRequestKind;
  readonly status: DataSubjectRequestStatus;
  readonly subjectKind: DataSubjectKind;
  readonly selfService: boolean;
  readonly dueAt: Date;
  readonly daysOverdue: number;
  /** True when the single permitted extension was already taken — the deadline cannot move again. */
  readonly extended: boolean;
}

export interface OverdueSweepResult {
  /** Live requests past `due_at`. NEVER capped — a separate count, not a length. */
  readonly overdueCount: number;
  /** Live requests inside the lead-time window. The number still actionable. */
  readonly dueSoonCount: number;
  /** The oldest `maxLogged` overdue rows, deadline-soonest first. */
  readonly rows: readonly OverdueRequestRow[];
  /** True when `overdueCount` exceeds what was enumerated. Stated, never silent. */
  readonly truncated: boolean;
}

export interface OverdueSweepInput {
  readonly now: Date;
  readonly dueSoonDays: number;
  readonly maxLogged: number;
}

/**
 * The overdue data-subject-request scan (TS-309a-followup-2).
 *
 * TS-309a stamps `due_at` at intake and cut a partial index over the live
 * statuses for exactly this query — but nothing read it, so a statutory
 * request could pass its deadline with no signal anywhere. This is that
 * reader.
 *
 * **It is READ-ONLY, and that is a decision rather than a shortcut.** There
 * is no `overdue` status and there should not be one: "overdue" is a
 * function of `due_at` and the current clock, so a stored flag would be
 * wrong the moment an extension moved the deadline, and wrong in the
 * direction that matters (a row still labelled late after it no longer
 * is). The sweep therefore emits observability — a count, a lead-time
 * count, and a bounded enumeration — and changes nothing.
 *
 * **The count and the enumeration are separate queries on purpose.** The
 * count is never capped, so a truncated enumeration cannot make the metric
 * under-report; the enumeration is capped so a backlog cannot flood the
 * log with one line per request. When the cap bites, the result says so.
 *
 * **Language.** The window is the one this platform has CONFIGURED
 * (`DATA_SUBJECT_REQUEST_RESPONSE_DAYS`, shipped as an unconfirmed
 * constant — TS-309a). Nothing here calls a breach unlawful, and nothing
 * should: whether a given request was late in the legal sense depends on
 * jurisdiction and record class, which is reference data this codebase
 * does not author (the TS-303a precedent).
 *
 * Terminal rows are excluded by the same `notIn` the operator queue uses,
 * expressed as a NOT rather than a whitelist of live statuses — a
 * whitelist would silently drop a status added later, and on a statutory
 * queue that means losing work.
 */
@Injectable()
export class PrivacyOverdueSweepService {
  constructor(private readonly prisma: PrismaService) {}

  async sweep(input: OverdueSweepInput): Promise<OverdueSweepResult> {
    // No `as const` here: it would widen the spread copy back to a
    // `readonly` array, and Prisma's generated `WhereInput` accepts only a
    // mutable `notIn`. The spread already detaches us from the frozen
    // source constant, which is the isolation this line actually needs.
    const live = { status: { notIn: [...TERMINAL_DATA_SUBJECT_REQUEST_STATUSES] } };
    const dueSoonBefore = new Date(input.now.getTime() + input.dueSoonDays * DAY_MS);

    const [overdueCount, dueSoonCount, rows] = await Promise.all([
      this.prisma.dataSubjectRequest.count({
        where: { ...live, dueAt: { lt: input.now } },
      }),
      // Half-open on both ends: a request exactly at `now` is overdue, not
      // due-soon, so the two counts partition the live set instead of
      // double-counting the row that matters most.
      this.prisma.dataSubjectRequest.count({
        where: { ...live, dueAt: { gte: input.now, lt: dueSoonBefore } },
      }),
      this.prisma.dataSubjectRequest.findMany({
        where: { ...live, dueAt: { lt: input.now } },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: input.maxLogged,
        select: {
          id: true,
          kind: true,
          status: true,
          subjectKind: true,
          selfService: true,
          dueAt: true,
          extendedAt: true,
        },
      }),
    ]);

    const typedRows = rows as ReadonlyArray<{
      id: string;
      kind: DataSubjectRequestKind;
      status: DataSubjectRequestStatus;
      subjectKind: DataSubjectKind;
      selfService: boolean;
      dueAt: Date;
      extendedAt: Date | null;
    }>;

    return {
      overdueCount,
      dueSoonCount,
      truncated: overdueCount > typedRows.length,
      rows: typedRows.map(
        (row): OverdueRequestRow => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          subjectKind: row.subjectKind,
          selfService: row.selfService,
          dueAt: row.dueAt,
          daysOverdue: Math.floor((input.now.getTime() - row.dueAt.getTime()) / DAY_MS),
          extended: row.extendedAt !== null,
        }),
      ),
    };
  }
}
