import { Injectable, Logger } from '@nestjs/common';
import {
  SEARCH_RELEVANCE_DETAIL_MAX_ROWS,
  SEARCH_RELEVANCE_RANGE_MAX_ROWS,
  type ListSearchRelevanceDailyResponse,
  type SearchRelevanceClickPositionStat,
  type SearchRelevanceDailySummary,
  type SearchRelevanceDayDetailResponse,
  type SearchRelevanceQueryStat,
  type SearchRelevanceSortStat,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { rateToPpm, toUtcDayWindow, utcDateKey } from './search-relevance-math';

/**
 * Explicit projection of `SearchRelevanceDaily` for the dashboard read — no
 * `SELECT *` (CLAUDE.md §4.1). The rate ppm fields are NOT stored; they are
 * re-derived from these counts on read.
 */
const SUMMARY_ROW_SELECT = {
  metricDate: true,
  totalSearches: true,
  zeroResultSearches: true,
  distinctSearchers: true,
  bookingsCreated: true,
  attributedBookings: true,
  computedAt: true,
} as const;

/** Slim row shape returned by `SUMMARY_ROW_SELECT`. */
interface SummaryRow {
  readonly metricDate: Date;
  readonly totalSearches: number;
  readonly zeroResultSearches: number;
  readonly distinctSearchers: number;
  readonly bookingsCreated: number;
  readonly attributedBookings: number;
  readonly computedAt: Date;
}

interface QueryRow {
  readonly queryText: string;
  readonly searchCount: number;
  readonly zeroResultCount: number;
}

interface SortRow {
  readonly sort: string;
  readonly searchCount: number;
  readonly zeroResultCount: number;
}

interface ClickPositionRow {
  readonly position: number;
  readonly clickCount: number;
  readonly impressionCount: number;
}

/**
 * Map a persisted daily summary row to the `SearchRelevanceDailySummary` wire
 * shape — the read-side inverse of `SearchRelevanceService.computeForDate`'s
 * summary projection. The three rate ppm fields are re-derived with the SAME
 * `rateToPpm` helper the compute path uses, so the compute response and the
 * dashboard read agree exactly (no stored rounding artifact — the prep-3b
 * discipline of storing raw counts only).
 */
function toSummary(row: SummaryRow): SearchRelevanceDailySummary {
  return {
    metricDate: utcDateKey(row.metricDate),
    totalSearches: row.totalSearches,
    zeroResultSearches: row.zeroResultSearches,
    distinctSearchers: row.distinctSearchers,
    bookingsCreated: row.bookingsCreated,
    attributedBookings: row.attributedBookings,
    zeroResultRatePpm: rateToPpm(row.zeroResultSearches, row.totalSearches),
    approxConversionPpm: rateToPpm(row.bookingsCreated, row.distinctSearchers),
    attributedConversionPpm: rateToPpm(row.attributedBookings, row.totalSearches),
    computedAt: row.computedAt.toISOString(),
  };
}

/**
 * `SearchRelevanceReadService` — backs the web-admin search-relevance
 * dashboard (TS-217a; PRD §10.1, PDD §23.1/§23.2).
 *
 * Read-only inverse of the prep-3b/4b/4c aggregation. The compute service
 * (`SearchRelevanceService`) WRITES the four marts; this service READS them
 * for the dashboard. Kept a separate provider so the heavy compute service
 * stays focused — the module wires both.
 *
 * **No tenant data.** The marts are platform-wide read-side data (declared
 * `unscopedModels` in `app.module.ts`). The reads run under the caller's
 * scoped frame seeded by `AccessTokenGuard` — same posture as the admin
 * compute trigger and the SaaS-metrics dashboard read (TS-266).
 *
 * **Bounded scans (CLAUDE.md §7.2/§7.3).** The summary range read takes at
 * most `SEARCH_RELEVANCE_RANGE_MAX_ROWS` newest-first off the `metric_date`
 * PK b-tree; each detail list takes at most `SEARCH_RELEVANCE_DETAIL_MAX_ROWS`
 * off the per-mart covering indexes (`*_date_count_idx` for top queries,
 * `*_date_clicks_idx` for click positions).
 */
@Injectable()
export class SearchRelevanceReadService {
  private readonly logger = new Logger(SearchRelevanceReadService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the daily search-relevance summary series for the dashboard's trend
   * chart + headline KPIs. Both bounds optional + inclusive; scans newest-first
   * and caps the row count, then reverses to ascending `metricDate` (oldest
   * first, ready to plot left-to-right). The echoed `from`/`to` report the
   * EFFECTIVE window actually returned. Mirrors `SaasMetricsService.listForDateRange`.
   */
  async listDailySummaries(range: {
    readonly from?: Date;
    readonly to?: Date;
  }): Promise<ListSearchRelevanceDailyResponse> {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (range.from !== undefined) dateFilter.gte = toUtcDayWindow(range.from).dayStart;
    if (range.to !== undefined) dateFilter.lte = toUtcDayWindow(range.to).dayStart;

    const rows = (await this.prisma.searchRelevanceDaily.findMany({
      ...(Object.keys(dateFilter).length > 0 && { where: { metricDate: dateFilter } }),
      select: SUMMARY_ROW_SELECT,
      orderBy: { metricDate: 'desc' },
      take: SEARCH_RELEVANCE_RANGE_MAX_ROWS,
    })) as SummaryRow[];

    // Newest-first off the b-tree → ascending for left-to-right plotting.
    const summaries = [...rows].reverse().map(toSummary);

    const from = summaries.at(0)?.metricDate ?? null;
    const to = summaries.at(-1)?.metricDate ?? null;

    this.logger.log(
      { days: summaries.length, from, to },
      'search-relevance.dashboard.summary-read',
    );

    return { summaries, from, to };
  }

  /**
   * Read a single UTC day's drill-down: the summary row + the four detail
   * marts (top queries, zero-result queries, searches-per-sort,
   * CTR-by-position). `summary` is null when the day was never aggregated.
   * Each list is capped + pre-sorted for the dashboard (busiest-first for
   * queries/sorts, highest-zero-count-first for zero-result queries, ascending
   * position for click positions). CTR ppm is derived per position.
   */
  async getDayDetail(date: Date): Promise<SearchRelevanceDayDetailResponse> {
    const { dayStart, dateKey } = toUtcDayWindow(date);

    const [summaryRow, queryRows, zeroQueryRows, sortRows, clickRows] = await Promise.all([
      this.prisma.searchRelevanceDaily.findUnique({
        where: { metricDate: dayStart },
        select: SUMMARY_ROW_SELECT,
      }) as Promise<SummaryRow | null>,
      this.prisma.searchQueryDaily.findMany({
        where: { metricDate: dayStart },
        select: { queryText: true, searchCount: true, zeroResultCount: true },
        orderBy: [{ searchCount: 'desc' }, { queryText: 'asc' }],
        take: SEARCH_RELEVANCE_DETAIL_MAX_ROWS,
      }) as Promise<QueryRow[]>,
      this.prisma.searchQueryDaily.findMany({
        where: { metricDate: dayStart, zeroResultCount: { gt: 0 } },
        select: { queryText: true, searchCount: true, zeroResultCount: true },
        orderBy: [{ zeroResultCount: 'desc' }, { queryText: 'asc' }],
        take: SEARCH_RELEVANCE_DETAIL_MAX_ROWS,
      }) as Promise<QueryRow[]>,
      this.prisma.searchSortDaily.findMany({
        where: { metricDate: dayStart },
        select: { sort: true, searchCount: true, zeroResultCount: true },
        orderBy: [{ searchCount: 'desc' }, { sort: 'asc' }],
        take: SEARCH_RELEVANCE_DETAIL_MAX_ROWS,
      }) as Promise<SortRow[]>,
      this.prisma.searchClickPositionDaily.findMany({
        where: { metricDate: dayStart },
        select: { position: true, clickCount: true, impressionCount: true },
        orderBy: { position: 'asc' },
        take: SEARCH_RELEVANCE_DETAIL_MAX_ROWS,
      }) as Promise<ClickPositionRow[]>,
    ]);

    const topQueries: SearchRelevanceQueryStat[] = queryRows.map(toQueryStat);
    const zeroResultQueries: SearchRelevanceQueryStat[] = zeroQueryRows.map(toQueryStat);
    const sortBreakdown: SearchRelevanceSortStat[] = sortRows.map((row) => ({
      sort: row.sort,
      searchCount: row.searchCount,
      zeroResultCount: row.zeroResultCount,
    }));
    const clickPositions: SearchRelevanceClickPositionStat[] = clickRows.map((row) => ({
      position: row.position,
      clickCount: row.clickCount,
      impressionCount: row.impressionCount,
      ctrPpm: rateToPpm(row.clickCount, row.impressionCount),
    }));

    this.logger.log(
      {
        metricDate: dateKey,
        hasSummary: summaryRow !== null,
        topQueries: topQueries.length,
        zeroResultQueries: zeroResultQueries.length,
        sortBuckets: sortBreakdown.length,
        clickPositions: clickPositions.length,
      },
      'search-relevance.dashboard.detail-read',
    );

    return {
      metricDate: dateKey,
      summary: summaryRow === null ? null : toSummary(summaryRow),
      topQueries,
      zeroResultQueries,
      sortBreakdown,
      clickPositions,
    };
  }
}

function toQueryStat(row: QueryRow): SearchRelevanceQueryStat {
  return {
    queryText: row.queryText,
    searchCount: row.searchCount,
    zeroResultCount: row.zeroResultCount,
  };
}
