import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import type { IncidentCategory, IncidentSeverity, IncidentStatus } from '../incident-enums';
import { SLA_BUDGET_MINUTES } from '../sla';

const MINUTE_MS = 60_000;

/**
 * The slice of a breached incident that may be logged.
 *
 * **What is absent is the design**, exactly as on the DSAR sweep
 * (TS-309a-followup-2). No `description` — that field is a family's
 * account of a named senior, and this whole track exists because such
 * text must not leak into channels that replicate more widely than the
 * `trust_safety:write`-gated detail page. No subject ids either: an
 * operator following up opens the incident by `id` in the console, where
 * the permission gate already lives.
 */
export interface BreachedIncidentRow {
  readonly id: string;
  readonly severity: IncidentSeverity;
  readonly category: IncidentCategory;
  readonly status: IncidentStatus;
  readonly slaDueAt: Date;
  readonly minutesOverdue: number;
  /** The budget in force for this severity, so the log states the measurement AND its threshold. */
  readonly budgetMinutes: number;
}

export interface SlaBreachSweepResult {
  /** Unresolved incidents past `sla_due_at`. NEVER capped — a count, not a length. */
  readonly breachedCount: number;
  /** Unresolved incidents due within `dueSoonMinutes`. The ones still actionable. */
  readonly dueSoonCount: number;
  /** The oldest `maxLogged` breaches, deadline-soonest first. */
  readonly rows: readonly BreachedIncidentRow[];
  /** True when `breachedCount` exceeds what was enumerated. Stated, never silent. */
  readonly truncated: boolean;
}

export interface SlaBreachSweepInput {
  readonly now: Date;
  readonly maxLogged: number;
}

/**
 * How far ahead of `sla_due_at` an incident counts as "due soon".
 *
 * Pinned to the **shortest budget in force** rather than a round number:
 * a lead-time longer than a severity's whole budget would mean every
 * `critical` incident is "due soon" from the moment it opens, which is
 * the same as saying nothing. Deriving it keeps the two in step if the
 * budgets are ever confirmed and changed (TS-300-followup-3).
 */
export const SLA_DUE_SOON_MINUTES = Math.min(...Object.values(SLA_BUDGET_MINUTES));

/**
 * The SLA-breach scan (TS-306-followup-1a).
 *
 * TS-300 stamped `sla_due_at` at insert and cut
 * `trust_safety_incidents_unresolved_sla_idx` for exactly this query —
 * and nothing ever read it, so an incident could sit untouched past its
 * deadline with no signal anywhere. TS-306 covered the OTHER signal:
 * paging the moment a `critical` incident arrives. The two are genuinely
 * different, and this is the one nobody gets woken for: "something
 * critical just came in" versus "something has been sitting since
 * Tuesday".
 *
 * **It SURFACES; it does not page, and that split is the task.** Paging
 * on breach is TS-306-followup-1b and is blocked on TS-300-followup-3:
 * `SLA_BUDGET_MINUTES` are placeholder engineering defaults nobody with
 * standing has confirmed, and waking a responder at 3am against a
 * made-up deadline is worse than not waking them — it is the fastest way
 * to teach a team that these pages can be ignored. A metric and a WARN
 * cost nothing if the number turns out to be wrong.
 *
 * **Read-only**, for the same reason the DSAR sweep is: there is no
 * `breached` status and there should not be one. Breach is a function of
 * `sla_due_at` and the clock, so a stored flag would be wrong the moment
 * a re-triage moved the deadline.
 *
 * **The count and the enumeration are separate queries** — the count is
 * never capped, so a truncated enumeration cannot make the metric
 * under-report; the enumeration is capped so a backlog cannot flood the
 * log.
 *
 * Unresolved is expressed as `status != 'resolved'`, matching the
 * repository's own predicate and the partial index — a whitelist of live
 * statuses would silently drop one added later, and on a safety queue
 * that means losing work.
 */
@Injectable()
export class SlaBreachSweepService {
  constructor(private readonly prisma: PrismaService) {}

  async sweep(input: SlaBreachSweepInput): Promise<SlaBreachSweepResult> {
    const unresolved = { status: { not: 'resolved' } } as const;
    const dueSoonBefore = new Date(input.now.getTime() + SLA_DUE_SOON_MINUTES * MINUTE_MS);

    const [breachedCount, dueSoonCount, rows] = await Promise.all([
      this.prisma.incident.count({
        where: { ...unresolved, slaDueAt: { lt: input.now } },
      }),
      // Half-open on both ends: an incident exactly at its deadline is
      // breached, not due-soon, so the two counts partition the
      // unresolved set instead of double-counting the row that matters.
      this.prisma.incident.count({
        where: { ...unresolved, slaDueAt: { gte: input.now, lt: dueSoonBefore } },
      }),
      this.prisma.incident.findMany({
        where: { ...unresolved, slaDueAt: { lt: input.now } },
        orderBy: [{ slaDueAt: 'asc' }, { id: 'asc' }],
        take: input.maxLogged,
        select: { id: true, severity: true, category: true, status: true, slaDueAt: true },
      }),
    ]);

    const typedRows = rows as ReadonlyArray<{
      id: string;
      severity: IncidentSeverity;
      category: IncidentCategory;
      status: IncidentStatus;
      slaDueAt: Date;
    }>;

    return {
      breachedCount,
      dueSoonCount,
      truncated: breachedCount > typedRows.length,
      rows: typedRows.map(
        (row): BreachedIncidentRow => ({
          id: row.id,
          severity: row.severity,
          category: row.category,
          status: row.status,
          slaDueAt: row.slaDueAt,
          minutesOverdue: Math.floor((input.now.getTime() - row.slaDueAt.getTime()) / MINUTE_MS),
          budgetMinutes: SLA_BUDGET_MINUTES[row.severity],
        }),
      ),
    };
  }
}
