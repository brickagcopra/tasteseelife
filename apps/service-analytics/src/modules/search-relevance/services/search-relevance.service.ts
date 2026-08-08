import { Injectable, Logger } from '@nestjs/common';
import type { ComputeSearchRelevanceMetricsResponse } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  countAttributedBookings,
  impressionsForPositions,
  rateToPpm,
  type ResultCountBucket,
  toUtcDayWindow,
} from './search-relevance-math';

/** The job-name stamped on each `analytics_aggregation_runs` row. */
export const SEARCH_RELEVANCE_JOB_NAME = 'search-relevance-daily';

/** Cap on the redacted failure reason persisted to `error_summary`. */
const ERROR_SUMMARY_MAX_LENGTH = 500;

/** First-page filter — the distinct-search grain shared by every aggregation. */
const FIRST_PAGE = 'first' as const;

/** One per-query aggregation row (the durable `search_query_daily` shape). */
interface QueryDailyRow {
  readonly queryText: string;
  readonly searchCount: number;
  readonly zeroResultCount: number;
}

/** One per-sort aggregation row (the durable `search_sort_daily` shape). */
interface SortDailyRow {
  readonly sort: string;
  readonly searchCount: number;
  readonly zeroResultCount: number;
}

/**
 * Projection of a `searchEvent.groupBy({ by: ['queryText'], _count })` row. The
 * `wrapWithTenantScope` proxy degrades Prisma's groupBy generics to a broad
 * type, so results are cast to this shape (the `trial-balance.service`
 * pattern). `queryText` is nullable — the column is — though the `not: null`
 * filter means every returned row carries a value.
 */
interface QueryGroupRow {
  readonly queryText: string | null;
  readonly _count: { readonly _all: number };
}

/** Projection of a `searchEvent.groupBy({ by: ['sort'], _count })` row. */
interface SortGroupRow {
  readonly sort: string;
  readonly _count: { readonly _all: number };
}

/**
 * Projection of a `searchClickEvent.groupBy({ by: ['position'], _count })`
 * row (TS-217-prep-4b-followup-1).
 */
interface PositionGroupRow {
  readonly position: number;
  readonly _count: { readonly _all: number };
}

/**
 * Projection of a `searchEvent.groupBy({ by: ['resultCount'], _count })` row —
 * the first-page result-count histogram that backs the per-position impression
 * denominator (TS-217-prep-4b-followup-1).
 */
interface ResultCountGroupRow {
  readonly resultCount: number;
  readonly _count: { readonly _all: number };
}

/**
 * One per-position CTR aggregation row (the durable
 * `search_click_position_daily` shape). `clickCount` is the per-position click
 * tally; `impressionCount` is the first-page-search impression denominator.
 */
interface ClickPositionDailyRow {
  readonly position: number;
  readonly clickCount: number;
  readonly impressionCount: number;
}

/**
 * `SearchRelevanceService` — computes the nightly search-relevance marts from
 * the raw `analytics.search_events` (+ `analytics.booking_created_events`)
 * landing tables (TS-217-prep-3b; PDD §23.1 + §23.2).
 *
 * **What it computes (per UTC calendar day).** Reading the raw landing tables
 * for the half-open `[dayStart, dayEnd)` window:
 *   - `search_query_daily` — per non-null query text: search count +
 *     zero-result count (powers "top queries").
 *   - `search_sort_daily` — per sort: search count + zero-result count
 *     (powers "searches-per-sort").
 *   - `search_relevance_daily` — the day summary: total searches, zero-result
 *     searches, distinct searchers, bookings created, attributed bookings
 *     (powers the zero-result RATE + the precise per-search conversion +
 *     the retained approximate conversion funnel).
 *   - `search_click_position_daily` — per clicked result position: click count
 *     (from `analytics.search_click_events`, TS-217-prep-4b) + a first-page
 *     impression denominator (positions a first-page search rendered, derived
 *     from `search_events.result_count`), so the dashboard renders CTR by
 *     result position (TS-217-prep-4b-followup-1).
 *
 * **First-page grain.** All search aggregations filter `page = 'first'` so a
 * deep-scroll pagination follow-up is not double-counted as a new search (the
 * `SearchPagePosition` contract note). A zero-result search has no pages to
 * scroll, so filtering to `first` loses no zero-result signal. The daily
 * total / zero-result counts are derived by summing the per-sort buckets —
 * every first-page search has exactly one sort — so they always reconcile.
 *
 * **Typed aggregation.** Counts use Prisma `groupBy` / `count` (the repo
 * convention — no hand-rolled SQL in module services; see
 * `trial-balance.service`). Conditional zero-result counts are a second
 * `groupBy` filtered to `zeroResults = true`, merged in-process; distinct
 * searchers are a `groupBy` over `actorUserId` (Prisma has no typed
 * `COUNT(DISTINCT)`) — bounded by the per-day searcher cardinality (Phase-1
 * scale: hundreds/day, PDD §27).
 *
 * **Conversion (precise + approximate).** `booking.created` now echoes the
 * originating search's correlation token (`searchId`, TS-217-prep-4c), landed
 * on `booking_created_events.search_id`. `attributedConversionPpm` is the
 * PRECISE per-search funnel — bookings whose `search_id` joins a same-window
 * `search_events.event_id`, over `totalSearches` (TS-217-prep-4c-followup-1).
 * `approxConversionPpm` is RETAINED as the coarse platform-wide cross-check
 * (`bookingsCreated / distinctSearchers`): a booking that did not arrive from a
 * search carries no token, so it counts toward `bookingsCreated` but never
 * `attributedBookings`.
 *
 * **Idempotent recompute.** Re-running for the same UTC date deletes that
 * date's rows across all four marts and re-inserts them in ONE transaction,
 * so a same-day re-run (missed nightly tick, ops back-fill) reproduces the
 * marts deterministically against current raw state.
 *
 * **Run audit.** Each compute stamps one `analytics_aggregation_runs` row
 * (`running` → `succeeded`/`failed`). The run row is created + committed
 * BEFORE the read/aggregate work so a crash mid-run leaves an honest
 * `running` record; the terminal state is stamped after.
 *
 * **Tenant-scoping.** The mart + run + raw models are platform-wide read-side
 * data (declared `unscopedModels` in `app.module.ts`). The internal compute
 * endpoint additionally wraps the whole call in `runWithoutTenantContext`
 * (belt-and-braces — see the controller).
 */
@Injectable()
export class SearchRelevanceService {
  private readonly logger = new Logger(SearchRelevanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compute + persist the search-relevance marts for the UTC calendar date of
   * `asOf`. Returns the daily summary primitives + the derived rate ppm
   * fields + the stamped run id.
   */
  async computeForDate(asOf: Date): Promise<ComputeSearchRelevanceMetricsResponse> {
    const { dayStart, dayEnd, dateKey } = toUtcDayWindow(asOf);
    const computedAt = new Date();

    const run = await this.prisma.analyticsAggregationRun.create({
      data: {
        jobName: SEARCH_RELEVANCE_JOB_NAME,
        status: 'running',
        windowStart: dayStart,
        windowEnd: dayEnd,
      },
      select: { id: true },
    });

    try {
      const [
        queryRows,
        sortRows,
        distinctSearchers,
        bookingsCreated,
        attributedBookings,
        clickRows,
      ] = await Promise.all([
        this.aggregateQueries(dayStart, dayEnd),
        this.aggregateSorts(dayStart, dayEnd),
        this.countDistinctSearchers(dayStart, dayEnd),
        this.prisma.bookingCreatedEvent.count({
          where: { occurredAt: { gte: dayStart, lt: dayEnd } },
        }),
        this.countAttributedBookings(dayStart, dayEnd),
        this.aggregateClickPositions(dayStart, dayEnd),
      ]);

      // Every first-page search carries exactly one sort, so the per-sort
      // buckets sum to the daily totals (no separate count() needed).
      const totalSearches = sortRows.reduce((acc, row) => acc + row.searchCount, 0);
      const zeroResultSearches = sortRows.reduce((acc, row) => acc + row.zeroResultCount, 0);
      const totalClicks = clickRows.reduce((acc, row) => acc + row.clickCount, 0);

      await this.persistMarts({
        dayStart,
        computedAt,
        totalSearches,
        zeroResultSearches,
        distinctSearchers,
        bookingsCreated,
        attributedBookings,
        queryRows,
        sortRows,
        clickRows,
      });

      const eventCount = totalSearches + bookingsCreated + totalClicks;
      await this.prisma.analyticsAggregationRun.update({
        where: { id: run.id },
        data: { status: 'succeeded', eventCount, completedAt: new Date() },
      });

      this.logger.log(
        {
          runId: run.id,
          metricDate: dateKey,
          totalSearches,
          zeroResultSearches,
          distinctSearchers,
          bookingsCreated,
          attributedBookings,
          totalClicks,
          clickPositionBucketCount: clickRows.length,
          topQueryCount: queryRows.length,
          sortBucketCount: sortRows.length,
        },
        'search-relevance.compute.persisted',
      );

      return {
        metricDate: dateKey,
        totalSearches,
        zeroResultSearches,
        distinctSearchers,
        bookingsCreated,
        attributedBookings,
        topQueryCount: queryRows.length,
        sortBucketCount: sortRows.length,
        zeroResultRatePpm: rateToPpm(zeroResultSearches, totalSearches),
        approxConversionPpm: rateToPpm(bookingsCreated, distinctSearchers),
        attributedConversionPpm: rateToPpm(attributedBookings, totalSearches),
        runId: run.id,
        computedAt: computedAt.toISOString(),
      };
    } catch (err) {
      await this.prisma.analyticsAggregationRun
        .update({
          where: { id: run.id },
          data: {
            status: 'failed',
            errorSummary: summarizeError(err),
            completedAt: new Date(),
          },
        })
        .catch((updateErr: unknown) => {
          // Don't mask the original failure if the bookkeeping update also
          // fails — log + swallow the secondary error (CLAUDE.md §3.9).
          this.logger.error(
            { runId: run.id, error: errMessage(updateErr) },
            'search-relevance.compute.run-status-update-failed',
          );
        });
      this.logger.error(
        { runId: run.id, metricDate: dateKey, error: errMessage(err) },
        'search-relevance.compute.failed',
      );
      throw err;
    }
  }

  /**
   * Per-query first-page aggregation (non-null query text only — a no-text
   * discovery browse has no query to rank). Two `groupBy`s — total + the
   * `zeroResults` subset — merged by query text so each row carries its
   * zero-result count.
   */
  private async aggregateQueries(dayStart: Date, dayEnd: Date): Promise<QueryDailyRow[]> {
    const baseWhere = {
      occurredAt: { gte: dayStart, lt: dayEnd },
      page: FIRST_PAGE,
      queryText: { not: null },
    };
    // The `wrapWithTenantScope` proxy degrades Prisma's groupBy generics to a
    // broad type, so the result is cast to the known projection (the same
    // pattern as `trial-balance.service`).
    const [totals, zeros] = (await Promise.all([
      this.prisma.searchEvent.groupBy({
        by: ['queryText'],
        where: baseWhere,
        _count: { _all: true },
      }),
      this.prisma.searchEvent.groupBy({
        by: ['queryText'],
        where: { ...baseWhere, zeroResults: true },
        _count: { _all: true },
      }),
    ])) as [ReadonlyArray<QueryGroupRow>, ReadonlyArray<QueryGroupRow>];
    const zeroByQuery = new Map<string, number>();
    for (const row of zeros) {
      if (row.queryText !== null) zeroByQuery.set(row.queryText, row._count._all);
    }
    const out: QueryDailyRow[] = [];
    for (const row of totals) {
      if (row.queryText === null) continue;
      out.push({
        queryText: row.queryText,
        searchCount: row._count._all,
        zeroResultCount: zeroByQuery.get(row.queryText) ?? 0,
      });
    }
    return out;
  }

  /** Per-sort first-page aggregation (total + zero-result per sort). */
  private async aggregateSorts(dayStart: Date, dayEnd: Date): Promise<SortDailyRow[]> {
    const baseWhere = { occurredAt: { gte: dayStart, lt: dayEnd }, page: FIRST_PAGE };
    const [totals, zeros] = (await Promise.all([
      this.prisma.searchEvent.groupBy({ by: ['sort'], where: baseWhere, _count: { _all: true } }),
      this.prisma.searchEvent.groupBy({
        by: ['sort'],
        where: { ...baseWhere, zeroResults: true },
        _count: { _all: true },
      }),
    ])) as [ReadonlyArray<SortGroupRow>, ReadonlyArray<SortGroupRow>];
    const zeroBySort = new Map<string, number>();
    for (const row of zeros) {
      zeroBySort.set(row.sort, row._count._all);
    }
    return totals.map((row) => ({
      sort: row.sort,
      searchCount: row._count._all,
      zeroResultCount: zeroBySort.get(row.sort) ?? 0,
    }));
  }

  /**
   * Distinct first-page searchers in the window. Prisma has no typed
   * `COUNT(DISTINCT)`, so this groups by `actorUserId` and counts the groups —
   * bounded by the per-day searcher cardinality (Phase-1 scale, PDD §27).
   */
  private async countDistinctSearchers(dayStart: Date, dayEnd: Date): Promise<number> {
    // No `as` cast on the result — `groupBy`'s return type is conditional
    // on its own generic, so an assertion flows backwards into inference
    // and TypeScript then demands the ARGUMENT be that array type too
    // (TS-501). The generated payload already types `actorUserId`.
    const groups = await this.prisma.searchEvent.groupBy({
      by: ['actorUserId'],
      where: { occurredAt: { gte: dayStart, lt: dayEnd }, page: FIRST_PAGE },
    });
    return groups.length;
  }

  /**
   * Precise per-search query→booking attribution numerator
   * (TS-217-prep-4c-followup-1). Counts `booking_created_events` rows in the
   * window whose `search_id` joins a same-window `search_events.event_id` (the
   * correlation token threaded by TS-217-prep-4c).
   *
   * Two bounded same-window reads, no hand-rolled SQL (the repo convention —
   * see `trial-balance.service`): first the booking tokens (bounded by
   * bookings/day, Phase-1 hundreds), then the subset of `search_events` whose
   * `event_id` is one of those tokens (the `in` clause is bounded by the
   * distinct booking-token count). The intersection count is the pure
   * `countAttributedBookings` helper. A booking with a null `search_id` (did
   * not arrive from a search) never matches.
   */
  private async countAttributedBookings(dayStart: Date, dayEnd: Date): Promise<number> {
    // The `wrapWithTenantScope` proxy degrades Prisma generics to a broad type,
    // so results are cast to the known projections (the same pattern the
    // groupBy reads use above).
    const bookingRows = (await this.prisma.bookingCreatedEvent.findMany({
      where: { occurredAt: { gte: dayStart, lt: dayEnd }, searchId: { not: null } },
      select: { searchId: true },
    })) as ReadonlyArray<{ readonly searchId: string | null }>;
    if (bookingRows.length === 0) {
      return 0;
    }

    const candidateTokens = [...new Set(bookingRows.map((row) => row.searchId))].filter(
      (token): token is string => token !== null,
    );
    const matchingSearches = (await this.prisma.searchEvent.findMany({
      where: { occurredAt: { gte: dayStart, lt: dayEnd }, eventId: { in: candidateTokens } },
      select: { eventId: true },
    })) as ReadonlyArray<{ readonly eventId: string }>;

    return countAttributedBookings(
      bookingRows.map((row) => row.searchId),
      matchingSearches.map((row) => row.eventId),
    );
  }

  /**
   * Per-position CTR aggregation (TS-217-prep-4b-followup-1). Groups
   * `search_click_events` by `position` for the window (the click numerator),
   * then attaches a first-page IMPRESSION denominator per clicked position
   * derived from the `search_events` result-count histogram
   * (`impressionsForPositions`). Only positions that received a click that day
   * yield a row — mirroring the per-query / per-sort marts, which only emit
   * rows for values that occurred.
   */
  private async aggregateClickPositions(
    dayStart: Date,
    dayEnd: Date,
  ): Promise<ClickPositionDailyRow[]> {
    // Click numerator + the first-page result-count histogram (impression
    // denominator source) read in parallel — independent reads on two tables.
    const [clickGroups, resultCountBuckets] = (await Promise.all([
      this.prisma.searchClickEvent.groupBy({
        by: ['position'],
        where: { occurredAt: { gte: dayStart, lt: dayEnd } },
        _count: { _all: true },
      }),
      this.prisma.searchEvent.groupBy({
        by: ['resultCount'],
        where: { occurredAt: { gte: dayStart, lt: dayEnd }, page: FIRST_PAGE },
        _count: { _all: true },
      }),
    ])) as [ReadonlyArray<PositionGroupRow>, ReadonlyArray<ResultCountGroupRow>];

    if (clickGroups.length === 0) {
      return [];
    }

    const buckets: ResultCountBucket[] = resultCountBuckets.map((row) => ({
      resultCount: row.resultCount,
      searchCount: row._count._all,
    }));
    const positions = clickGroups.map((row) => row.position);
    const impressions = impressionsForPositions(buckets, positions);

    return clickGroups.map((row) => ({
      position: row.position,
      clickCount: row._count._all,
      impressionCount: impressions.get(row.position) ?? 0,
    }));
  }

  /**
   * Delete-and-reinsert the four marts for `dayStart` in one transaction so a
   * recompute is atomic + idempotent (no partially-rebuilt day is ever
   * visible).
   */
  private async persistMarts(args: {
    readonly dayStart: Date;
    readonly computedAt: Date;
    readonly totalSearches: number;
    readonly zeroResultSearches: number;
    readonly distinctSearchers: number;
    readonly bookingsCreated: number;
    readonly attributedBookings: number;
    readonly queryRows: readonly QueryDailyRow[];
    readonly sortRows: readonly SortDailyRow[];
    readonly clickRows: readonly ClickPositionDailyRow[];
  }): Promise<void> {
    const {
      dayStart,
      computedAt,
      totalSearches,
      zeroResultSearches,
      distinctSearchers,
      bookingsCreated,
      attributedBookings,
      queryRows,
      sortRows,
      clickRows,
    } = args;

    await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.searchRelevanceDaily.deleteMany({ where: { metricDate: dayStart } });
      await tx.searchQueryDaily.deleteMany({ where: { metricDate: dayStart } });
      await tx.searchSortDaily.deleteMany({ where: { metricDate: dayStart } });
      await tx.searchClickPositionDaily.deleteMany({ where: { metricDate: dayStart } });

      await tx.searchRelevanceDaily.create({
        data: {
          metricDate: dayStart,
          totalSearches,
          zeroResultSearches,
          distinctSearchers,
          bookingsCreated,
          attributedBookings,
          computedAt,
        },
      });

      if (queryRows.length > 0) {
        await tx.searchQueryDaily.createMany({
          data: queryRows.map((row) => ({
            metricDate: dayStart,
            queryText: row.queryText,
            searchCount: row.searchCount,
            zeroResultCount: row.zeroResultCount,
            computedAt,
          })),
        });
      }

      if (sortRows.length > 0) {
        await tx.searchSortDaily.createMany({
          data: sortRows.map((row) => ({
            metricDate: dayStart,
            sort: row.sort,
            searchCount: row.searchCount,
            zeroResultCount: row.zeroResultCount,
            computedAt,
          })),
        });
      }

      if (clickRows.length > 0) {
        await tx.searchClickPositionDaily.createMany({
          data: clickRows.map((row) => ({
            metricDate: dayStart,
            position: row.position,
            clickCount: row.clickCount,
            impressionCount: row.impressionCount,
            computedAt,
          })),
        });
      }
    });
  }
}

function summarizeError(err: unknown): string {
  return errMessage(err).slice(0, ERROR_SUMMARY_MAX_LENGTH);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
