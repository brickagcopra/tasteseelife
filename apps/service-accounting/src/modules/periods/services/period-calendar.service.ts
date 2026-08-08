import { Injectable, Logger } from '@nestjs/common';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { toPeriodResponse, type PersistedPeriod } from '../mappers/period.mapper';

import type { PeriodResponse } from '@taste-and-see/contracts';

/**
 * Failure variants from `PeriodCalendarService.generateMonthly`.
 *
 * - `range_inverted`     → 422 (start > end). Defensive — the contract
 *                          layer rejects this at parse time via
 *                          `superRefine`.
 * - `range_exceeds_cap`  → 422 (the requested range covers more than
 *                          `GENERATE_PERIODS_MAX_COUNT` months — guards
 *                          against runaway admin scripts).
 * - `malformed_name`     → 422 (defensive — the contract layer's regex
 *                          rejects this).
 */
export type GenerateCalendarFailure =
  | {
      readonly kind: 'range_inverted';
      readonly startYearMonth: string;
      readonly endYearMonth: string;
    }
  | {
      readonly kind: 'range_exceeds_cap';
      readonly requestedCount: number;
      readonly maxCount: number;
    }
  | { readonly kind: 'malformed_name'; readonly yearMonth: string };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(failure: E): Result<never, E> => ({ ok: false, failure });

/**
 * Output of the calendar generator.
 *
 * Surfaces both the newly-created rows + the pre-existing rows so the
 * caller can render the resulting calendar without a follow-up GET.
 * `requestedCount`/`createdCount`/`existedCount` sum to the size of
 * the requested range.
 */
export interface GenerateCalendarOutput {
  readonly startYearMonth: string;
  readonly endYearMonth: string;
  readonly requestedCount: number;
  readonly createdCount: number;
  readonly existedCount: number;
  readonly created: readonly PeriodResponse[];
  readonly existed: readonly PeriodResponse[];
}

/**
 * Output of `PeriodCalendarService.list`. Cursor-based pagination.
 */
export interface ListPeriodsOutput {
  readonly periods: readonly PeriodResponse[];
  readonly nextCursor: string | null;
}

/**
 * `PeriodCalendarService` — explicit ahead-of-time generation +
 * listing of accounting periods.
 *
 * **Why this exists.** TS-081's `AccountingPeriodService` lazy-creates
 * monthly periods on first post, which keeps journal posting working
 * without ops attention but produces the period at the wrong moment
 * (during a hot path) and without the audit envelope an explicit
 * admin action carries. This service is the ops-side equivalent: an
 * admin runs `POST /api/v1/admin/periods/generate` ahead of the
 * fiscal year to populate the calendar with a known shape. The
 * lazy-create path remains as the safety net (retirement captured in
 * TS-081-followup-8).
 *
 * **Monthly cadence only.** Phase 1 + the bulk of the system are
 * monthly. Quarterly / custom-fiscal generators land as separate
 * methods on this service when the time comes.
 *
 * **Idempotency.** Re-running the generator with the same range is a
 * no-op — every requested name already exists. The service inserts
 * only the missing rows; the existing ones are reported in `existed`.
 * The Prisma transaction wrapping the insert batch is sized to fit
 * the `GENERATE_PERIODS_MAX_COUNT` cap; bigger ranges are rejected
 * at the input layer.
 */
@Injectable()
export class PeriodCalendarService {
  private readonly logger = new Logger(PeriodCalendarService.name);

  /**
   * Hard cap on a single `generateMonthly` invocation. Mirrors the
   * contract-layer `GENERATE_PERIODS_MAX_COUNT` (60 months = 5
   * years). Larger ranges chunk via multiple calls.
   */
  static readonly MAX_RANGE_MONTHS = 60;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate monthly periods covering the inclusive
   * `[startYearMonth, endYearMonth]` range. Idempotent — only inserts
   * names that don't already exist.
   *
   * Returns the full list of rows (created + existed) in calendar
   * order.
   */
  async generateMonthly(
    startYearMonth: string,
    endYearMonth: string,
  ): Promise<Result<GenerateCalendarOutput, GenerateCalendarFailure>> {
    const startParsed = parseYearMonth(startYearMonth);
    if (startParsed === null) {
      return fail({ kind: 'malformed_name', yearMonth: startYearMonth });
    }
    const endParsed = parseYearMonth(endYearMonth);
    if (endParsed === null) {
      return fail({ kind: 'malformed_name', yearMonth: endYearMonth });
    }
    if (compareYearMonth(startYearMonth, endYearMonth) > 0) {
      return fail({
        kind: 'range_inverted',
        startYearMonth,
        endYearMonth,
      });
    }

    const requested = enumerateMonths(startParsed, endParsed);
    if (requested.length > PeriodCalendarService.MAX_RANGE_MONTHS) {
      return fail({
        kind: 'range_exceeds_cap',
        requestedCount: requested.length,
        maxCount: PeriodCalendarService.MAX_RANGE_MONTHS,
      });
    }

    const requestedNames = requested.map((m) => m.name);

    // Look up the existing rows for the requested range. The `name`
    // UNIQUE index makes this an index range scan + an `IN` filter;
    // bounded by the 60-month cap.
    const existingRows = (await this.prisma.accountingPeriod.findMany({
      where: { name: { in: requestedNames } },
      select: PERIOD_FULL_SELECT,
      orderBy: { startDate: 'asc' },
    })) as readonly PersistedPeriod[];
    const existingByName = new Map<string, PersistedPeriod>(existingRows.map((r) => [r.name, r]));

    const missing = requested.filter((m) => !existingByName.has(m.name));

    if (missing.length === 0) {
      this.logger.log(
        {
          startYearMonth,
          endYearMonth,
          createdCount: 0,
          existedCount: existingRows.length,
        },
        'period-calendar.generate.all-pre-existing',
      );
      return ok({
        startYearMonth,
        endYearMonth,
        requestedCount: requested.length,
        createdCount: 0,
        existedCount: existingRows.length,
        created: [],
        existed: existingRows.map(toPeriodResponse),
      });
    }

    // Insert missing rows inside a single transaction. Each row is
    // inserted individually so a P2002 race against a concurrent
    // generate (two admins clicking submit at the same moment) doesn't
    // abort the entire batch — we catch + refetch per-row.
    const createdRows: PersistedPeriod[] = [];
    await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      for (const month of missing) {
        try {
          const created = (await tx.accountingPeriod.create({
            data: {
              name: month.name,
              startDate: month.startDate,
              endDate: month.endDate,
              status: 'open',
            },
            select: PERIOD_FULL_SELECT,
          })) as PersistedPeriod;
          createdRows.push(created);
        } catch (err) {
          if (!isUniqueViolationOn(err, 'name')) {
            throw err;
          }
          // Concurrent generator created this row between our pre-flight
          // findMany + this insert. Refetch + treat as existed.
          const winner = (await tx.accountingPeriod.findUnique({
            where: { name: month.name },
            select: PERIOD_FULL_SELECT,
          })) as PersistedPeriod | null;
          if (winner !== null) {
            existingByName.set(month.name, winner);
          }
        }
      }
    });

    const finalExisting = Array.from(existingByName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    this.logger.warn(
      {
        startYearMonth,
        endYearMonth,
        requestedCount: requested.length,
        createdCount: createdRows.length,
        existedCount: finalExisting.length,
      },
      'period-calendar.generate.completed',
    );

    return ok({
      startYearMonth,
      endYearMonth,
      requestedCount: requested.length,
      createdCount: createdRows.length,
      existedCount: finalExisting.length,
      created: createdRows.map(toPeriodResponse),
      existed: finalExisting.map(toPeriodResponse),
    });
  }

  /**
   * Fetch a single period by name (`YYYY-MM`). Returns `null` for
   * unknown names; the controller maps that to 404.
   */
  async getByName(periodName: string): Promise<PeriodResponse | null> {
    const row = (await this.prisma.accountingPeriod.findUnique({
      where: { name: periodName },
      select: PERIOD_FULL_SELECT,
    })) as PersistedPeriod | null;
    return row === null ? null : toPeriodResponse(row);
  }

  /**
   * List periods in reverse-calendar order (newest first) with cursor
   * pagination. The cursor is the `startDate` of the last period on
   * the previous page (encoded as `YYYY-MM-DD`); decoding is
   * straightforward because the format is unambiguous.
   *
   * `status` narrows the result set to one variant when provided.
   */
  async list(filter: {
    status?: 'open' | 'closed';
    cursor?: string;
    limit?: number;
  }): Promise<ListPeriodsOutput> {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
    const cursorDate = filter.cursor !== undefined ? decodeCursor(filter.cursor) : null;

    const rows = (await this.prisma.accountingPeriod.findMany({
      where: {
        ...(filter.status !== undefined && { status: filter.status }),
        ...(cursorDate !== null && { startDate: { lt: cursorDate } }),
      },
      orderBy: { startDate: 'desc' },
      take: limit + 1,
      select: PERIOD_FULL_SELECT,
    })) as readonly PersistedPeriod[];

    const sliced = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const nextCursor =
      hasMore && sliced.length > 0
        ? encodeCursor((sliced[sliced.length - 1] as PersistedPeriod).startDate)
        : null;

    return {
      periods: sliced.map(toPeriodResponse),
      nextCursor,
    };
  }
}

const PERIOD_FULL_SELECT = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  status: true,
  closedAt: true,
  closedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Parse a `YYYY-MM` string. Returns `null` on malformed input.
 */
export function parseYearMonth(yearMonth: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(yearMonth);
  if (match === null) return null;
  return {
    year: Number.parseInt(match[1] as string, 10),
    month: Number.parseInt(match[2] as string, 10),
  };
}

/**
 * Compare two `YYYY-MM` strings as if they were Date objects. The
 * zero-padded format means lexicographic comparison matches calendar
 * order — no parsing required for the dominant code path; we use it
 * in tests + as a defensive guard in the service.
 */
export function compareYearMonth(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Enumerate the inclusive [start, end] monthly range, returning one
 * `{name, startDate, endDate}` per month. The dates are UTC midnight
 * for the first / last calendar day of the month.
 */
export function enumerateMonths(
  start: { year: number; month: number },
  end: { year: number; month: number },
): readonly { name: string; startDate: Date; endDate: Date }[] {
  const out: { name: string; startDate: Date; endDate: Date }[] = [];
  let year = start.year;
  let month = start.month;
  while (year < end.year || (year === end.year && month <= end.month)) {
    const name = `${year}-${month.toString().padStart(2, '0')}`;
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));
    out.push({ name, startDate, endDate });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * Cursor encoding/decoding. The cursor is the `startDate` of the last
 * period on the previous page, formatted as `YYYY-MM-DD`. We accept
 * either the raw `YYYY-MM-DD` form OR a base64-wrapped form for the
 * future when the cursor needs to carry more than one field.
 */
export function encodeCursor(startDate: Date): string {
  return startDate.toISOString().slice(0, 10);
}

export function decodeCursor(cursor: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor)) return null;
  const parsed = new Date(`${cursor}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as {
    code?: unknown;
    name?: unknown;
    meta?: { target?: unknown };
  };
  if (candidate.code !== 'P2002' || candidate.name !== 'PrismaClientKnownRequestError') {
    return false;
  }
  const target = candidate.meta?.target;
  if (Array.isArray(target)) {
    return target.includes(column);
  }
  if (typeof target === 'string') {
    return target.includes(column);
  }
  return false;
}
