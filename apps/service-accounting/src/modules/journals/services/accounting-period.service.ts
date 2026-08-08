import { Injectable, Logger } from '@nestjs/common';

import type { PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Slim projection of `AccountingPeriod` needed by the journal-
 * posting service. Kept narrow so the TS-021-followup-2-style
 * Prisma-namespace value-side resolution doesn't bleed in.
 */
export interface ResolvedAccountingPeriod {
  readonly id: string;
  readonly name: string;
  readonly status: 'open' | 'closed';
}

/**
 * `AccountingPeriodService` — resolves the accounting period that
 * an `occurredAt` falls inside, lazy-creating a monthly period
 * the first time a journal is posted in that month.
 *
 * **TS-081 scope.** The lazy-create path keeps journal posting
 * working without TS-085 (period close / reopen workflow + the
 * explicit calendar generator) shipped. Once TS-085 lands, the
 * lazy-create here is retired — the calendar generator
 * pre-creates every period ahead of time so the journal-posting
 * service's contract simplifies to a lookup-or-reject.
 *
 * **Monthly granularity.** Periods are `YYYY-MM` (e.g. `2026-05`)
 * covering the calendar month in UTC. The model is calendar-
 * agnostic — quarterly or fiscal periods land later by replacing
 * the calendar generator, not by changing the schema.
 *
 * **Race protection.** Two concurrent journal posts in a brand-
 * new month would both hit the lazy-create path. The UNIQUE
 * constraint on `accounting_periods.name` lets Postgres pick
 * exactly one winner; the loser refetches by name. The retry is
 * bounded to a single iteration because the `name` column is
 * deterministic from `occurredAt` (no jitter).
 *
 * **Closed-period rejection** is the caller's responsibility —
 * this service surfaces the period's status, the
 * `JournalPostingService` rejects closed periods with the
 * `period_closed` Result variant (CLAUDE.md §6).
 */
@Injectable()
export class AccountingPeriodService {
  private readonly logger = new Logger(AccountingPeriodService.name);

  /**
   * Resolve the period containing `occurredAt`. Creates the
   * monthly period if no row covers the date.
   *
   * `tx` is the surrounding Prisma transaction client — the
   * period read + create runs inside the same transaction as
   * the journal write so a rollback unwinds both. Phase-1
   * monthly cadence means lazy-create happens at most 12 times
   * a year; the cost is negligible.
   */
  async findOrCreateContaining(
    occurredAt: Date,
    tx: PrismaTransactionClient,
  ): Promise<ResolvedAccountingPeriod> {
    const name = monthlyPeriodName(occurredAt);
    const { startDate, endDate } = monthlyPeriodRange(occurredAt);

    const existing = await tx.accountingPeriod.findUnique({
      where: { name },
      select: PERIOD_PROJECTION,
    });
    if (existing !== null) {
      return existing as ResolvedAccountingPeriod;
    }

    try {
      const created = await tx.accountingPeriod.create({
        data: {
          name,
          startDate,
          endDate,
          status: 'open',
        },
        select: PERIOD_PROJECTION,
      });
      this.logger.log({ periodName: name, periodId: created.id }, 'accounting-period.lazy-create');
      return created as ResolvedAccountingPeriod;
    } catch (err) {
      // Race against a concurrent post in a brand-new month —
      // the UNIQUE constraint on `name` rejects the loser, who
      // refetches the winner's row. One retry is sufficient
      // because `name` is deterministic from `occurredAt`.
      if (isPrismaUniqueViolation(err)) {
        const fetched = await tx.accountingPeriod.findUnique({
          where: { name },
          select: PERIOD_PROJECTION,
        });
        if (fetched !== null) {
          return fetched as ResolvedAccountingPeriod;
        }
      }
      throw err;
    }
  }
}

const PERIOD_PROJECTION = {
  id: true,
  name: true,
  status: true,
} as const;

/**
 * Format `occurredAt` as the canonical monthly period name
 * (`YYYY-MM` in UTC). Conversion to UTC is critical — a senior
 * household subscribing at 2026-05-31T23:30:00-04:00 (May 31 in
 * NY, June 1 UTC) belongs to the June period; the company's
 * books are kept in UTC for cross-region consistency.
 */
export function monthlyPeriodName(occurredAt: Date): string {
  const year = occurredAt.getUTCFullYear();
  const month = occurredAt.getUTCMonth() + 1;
  return `${year}-${month.toString().padStart(2, '0')}`;
}

/**
 * Compute the calendar-month range (UTC start of month → start
 * of the next month, exclusive at the upper bound). We pass
 * `Date` objects to Prisma, which stores them as the underlying
 * `date` column (no time component); the inclusive end-date is
 * therefore the last day of the month.
 */
export function monthlyPeriodRange(occurredAt: Date): {
  readonly startDate: Date;
  readonly endDate: Date;
} {
  const year = occurredAt.getUTCFullYear();
  const month = occurredAt.getUTCMonth();
  // First instant of the month, midnight UTC.
  const startDate = new Date(Date.UTC(year, month, 1));
  // Last calendar day of the month (e.g. May 31).
  const endDate = new Date(Date.UTC(year, month + 1, 0));
  return { startDate, endDate };
}

function isPrismaUniqueViolation(err: unknown): boolean {
  // Duck-typed Prisma error narrowing — TS-021-followup-2 captures
  // the cleanup to the canonical `instanceof
  // Prisma.PrismaClientKnownRequestError` check once the namespace
  // value-side resolves cleanly on the Prisma minor bump.
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; name?: unknown };
  return candidate.code === 'P2002' && candidate.name === 'PrismaClientKnownRequestError';
}
