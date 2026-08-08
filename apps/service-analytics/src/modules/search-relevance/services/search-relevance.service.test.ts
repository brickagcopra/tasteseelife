import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { SEARCH_RELEVANCE_JOB_NAME, SearchRelevanceService } from './search-relevance.service';

/**
 * A fake tenant-scoped `PrismaService`. `searchEvent.groupBy` dispatches on the
 * `by` field + the presence of a `zeroResults` filter (more robust than
 * call-order); `$transaction` invokes the callback with a fake transaction
 * client whose mart-model spies record the writes.
 */
interface FakeTx {
  searchRelevanceDaily: { deleteMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  searchQueryDaily: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  searchSortDaily: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  searchClickPositionDaily: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
}

function makeTx(): FakeTx {
  return {
    searchRelevanceDaily: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
    },
    searchQueryDaily: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    searchSortDaily: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    searchClickPositionDaily: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

interface GroupByArgs {
  readonly by: readonly string[];
  readonly where?: { readonly zeroResults?: boolean };
}

function makePrisma(opts: {
  readonly queryTotals?: unknown[];
  readonly queryZeros?: unknown[];
  readonly sortTotals?: unknown[];
  readonly sortZeros?: unknown[];
  readonly distinctSearcherGroups?: unknown[];
  readonly bookingsCreated?: number;
  /** `bookingCreatedEvent.findMany` rows — booking `search_id` tokens. */
  readonly attributedBookingRows?: unknown[];
  /** `searchEvent.findMany` rows — same-window search `event_id`s. */
  readonly matchingSearchEventRows?: unknown[];
  /** `searchClickEvent.groupBy({ by: ['position'] })` rows. */
  readonly clickPositions?: unknown[];
  /** `searchEvent.groupBy({ by: ['resultCount'] })` rows (impression source). */
  readonly resultCountBuckets?: unknown[];
  readonly tx?: FakeTx;
  readonly transactionThrows?: Error;
}): {
  prisma: PrismaService;
  runCreate: ReturnType<typeof vi.fn>;
  runUpdate: ReturnType<typeof vi.fn>;
  tx: FakeTx;
} {
  const tx = opts.tx ?? makeTx();
  const runCreate = vi.fn(async () => ({ id: 'run_test_1' }));
  const runUpdate = vi.fn(async () => ({}));

  const groupBy = vi.fn(async (args: GroupByArgs) => {
    const field = args.by[0];
    const isZero = args.where?.zeroResults === true;
    if (field === 'queryText') return isZero ? (opts.queryZeros ?? []) : (opts.queryTotals ?? []);
    if (field === 'sort') return isZero ? (opts.sortZeros ?? []) : (opts.sortTotals ?? []);
    if (field === 'actorUserId') return opts.distinctSearcherGroups ?? [];
    if (field === 'resultCount') return opts.resultCountBuckets ?? [];
    return [];
  });

  const clickGroupBy = vi.fn(async () => opts.clickPositions ?? []);

  const transaction = vi.fn(async (cb: (t: FakeTx) => Promise<unknown>) => {
    if (opts.transactionThrows) {
      throw opts.transactionThrows;
    }
    return cb(tx);
  });

  const prisma = {
    analyticsAggregationRun: { create: runCreate, update: runUpdate },
    searchEvent: {
      groupBy,
      findMany: vi.fn(async () => opts.matchingSearchEventRows ?? []),
    },
    searchClickEvent: { groupBy: clickGroupBy },
    bookingCreatedEvent: {
      count: vi.fn(async () => opts.bookingsCreated ?? 0),
      findMany: vi.fn(async () => opts.attributedBookingRows ?? []),
    },
    $transaction: transaction,
  } as unknown as PrismaService;

  return { prisma, runCreate, runUpdate, tx };
}

function searcherGroups(n: number): Array<{ actorUserId: string }> {
  return Array.from({ length: n }, (_unused, i) => ({ actorUserId: `usr_${i}` }));
}

describe('SearchRelevanceService.computeForDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T03:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates the marts and returns the summary + derived rates', async () => {
    const { prisma, runCreate, runUpdate, tx } = makePrisma({
      queryTotals: [
        { queryText: 'paella', _count: { _all: 30 } },
        { queryText: 'kosher', _count: { _all: 25 } },
      ],
      queryZeros: [{ queryText: 'kosher', _count: { _all: 10 } }],
      sortTotals: [
        { sort: 'relevance', _count: { _all: 80 } },
        { sort: 'rating', _count: { _all: 40 } },
      ],
      sortZeros: [
        { sort: 'relevance', _count: { _all: 12 } },
        { sort: 'rating', _count: { _all: 6 } },
      ],
      distinctSearcherGroups: searcherGroups(40),
      bookingsCreated: 6,
      // 4 of the 6 bookings carry a token that joins a same-window search.
      attributedBookingRows: [
        { searchId: 's1' },
        { searchId: 's2' },
        { searchId: 's3' },
        { searchId: 's4' },
      ],
      matchingSearchEventRows: [
        { eventId: 's1' },
        { eventId: 's2' },
        { eventId: 's3' },
        { eventId: 's4' },
      ],
    });
    const service = new SearchRelevanceService(prisma);

    const result = await service.computeForDate(new Date('2026-06-08T12:00:00Z'));

    expect(result.metricDate).toBe('2026-06-08');
    expect(result.totalSearches).toBe(120); // 80 + 40 (per-sort sum)
    expect(result.zeroResultSearches).toBe(18); // 12 + 6
    expect(result.distinctSearchers).toBe(40);
    expect(result.bookingsCreated).toBe(6);
    expect(result.attributedBookings).toBe(4);
    expect(result.topQueryCount).toBe(2);
    expect(result.sortBucketCount).toBe(2);
    expect(result.zeroResultRatePpm).toBe(150_000); // 18/120
    expect(result.approxConversionPpm).toBe(150_000); // 6/40
    expect(result.attributedConversionPpm).toBe(33_333); // 4/120
    expect(result.runId).toBe('run_test_1');
    expect(result.computedAt).toBe('2026-06-09T03:00:00.000Z');

    // run-history: created `running`, then stamped `succeeded` with the event tally.
    expect(runCreate).toHaveBeenCalledTimes(1);
    expect(runCreate.mock.calls[0]?.[0]).toMatchObject({
      data: expect.objectContaining({ jobName: SEARCH_RELEVANCE_JOB_NAME, status: 'running' }),
    });
    expect(runUpdate).toHaveBeenCalledWith({
      where: { id: 'run_test_1' },
      data: { status: 'succeeded', eventCount: 126, completedAt: expect.any(Date) },
    });

    // marts: delete-then-reinsert keyed by the UTC day start.
    const dayStart = new Date('2026-06-08T00:00:00.000Z');
    expect(tx.searchRelevanceDaily.deleteMany).toHaveBeenCalledWith({
      where: { metricDate: dayStart },
    });
    expect(tx.searchRelevanceDaily.create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        metricDate: dayStart,
        totalSearches: 120,
        zeroResultSearches: 18,
        distinctSearchers: 40,
        bookingsCreated: 6,
        attributedBookings: 4,
      },
    });
    // The per-query mart carries the merged zero-result counts.
    const queryData = tx.searchQueryDaily.createMany.mock.calls[0]?.[0].data as Array<{
      queryText: string;
      zeroResultCount: number;
    }>;
    expect(queryData).toHaveLength(2);
    expect(queryData.find((r) => r.queryText === 'paella')?.zeroResultCount).toBe(0);
    expect(queryData.find((r) => r.queryText === 'kosher')?.zeroResultCount).toBe(10);
    expect(tx.searchSortDaily.createMany.mock.calls[0]?.[0].data).toHaveLength(2);
  });

  it('writes the CTR-by-position mart with first-page impression denominators', async () => {
    const { prisma, runUpdate, tx } = makePrisma({
      sortTotals: [{ sort: 'relevance', _count: { _all: 10 } }],
      distinctSearcherGroups: searcherGroups(4),
      bookingsCreated: 0,
      // 3 clicks at position 0, 1 at position 2.
      clickPositions: [
        { position: 0, _count: { _all: 3 } },
        { position: 2, _count: { _all: 1 } },
      ],
      // First-page result-count histogram: 6 searches returned 1 hit, 4
      // returned 5 hits → position 0 shown by all 10; position 2 shown only by
      // the 4 searches that returned >2 hits.
      resultCountBuckets: [
        { resultCount: 1, _count: { _all: 6 } },
        { resultCount: 5, _count: { _all: 4 } },
      ],
    });
    const service = new SearchRelevanceService(prisma);

    await service.computeForDate(new Date('2026-06-08T12:00:00Z'));

    const dayStart = new Date('2026-06-08T00:00:00.000Z');
    expect(tx.searchClickPositionDaily.deleteMany).toHaveBeenCalledWith({
      where: { metricDate: dayStart },
    });
    const clickData = tx.searchClickPositionDaily.createMany.mock.calls[0]?.[0].data as Array<{
      position: number;
      clickCount: number;
      impressionCount: number;
    }>;
    expect(clickData).toHaveLength(2);
    expect(clickData.find((r) => r.position === 0)).toMatchObject({
      clickCount: 3,
      impressionCount: 10, // result_count > 0 for all 10 first-page searches
    });
    expect(clickData.find((r) => r.position === 2)).toMatchObject({
      clickCount: 1,
      impressionCount: 4, // only the 4 searches with result_count (5) > 2
    });

    // Clicks fold into the run's processed-event tally (10 searches + 0
    // bookings + 4 clicks).
    expect(runUpdate).toHaveBeenCalledWith({
      where: { id: 'run_test_1' },
      data: { status: 'succeeded', eventCount: 14, completedAt: expect.any(Date) },
    });
  });

  it('attributes only bookings whose token joins a same-window search', async () => {
    const { prisma, tx } = makePrisma({
      sortTotals: [{ sort: 'relevance', _count: { _all: 50 } }],
      distinctSearcherGroups: searcherGroups(20),
      bookingsCreated: 5,
      // 4 bookings carry a token; the 5th (no row here — null search_id) is
      // omitted by the `searchId: { not: null }` filter the service applies.
      attributedBookingRows: [
        { searchId: 's1' },
        { searchId: 's2' },
        { searchId: 's2' }, // a second booking sharing one search — both count
        { searchId: 'sOrphan' }, // token points at no same-window search
      ],
      // Only s1 + s2 exist as same-window search events; sOrphan does not.
      matchingSearchEventRows: [{ eventId: 's1' }, { eventId: 's2' }],
    });
    const service = new SearchRelevanceService(prisma);

    const result = await service.computeForDate(new Date('2026-06-08T12:00:00Z'));

    // s1 (1) + s2 (2) match; sOrphan does not → 3 attributed of 5 created.
    expect(result.bookingsCreated).toBe(5);
    expect(result.attributedBookings).toBe(3);
    expect(result.attributedConversionPpm).toBe(60_000); // 3/50
    expect(tx.searchRelevanceDaily.create.mock.calls[0]?.[0]).toMatchObject({
      data: { bookingsCreated: 5, attributedBookings: 3 },
    });
  });

  it('returns null rates and skips detail inserts on an empty day', async () => {
    const { prisma, runUpdate, tx } = makePrisma({ bookingsCreated: 0 });
    const service = new SearchRelevanceService(prisma);

    const result = await service.computeForDate(new Date('2026-06-08T12:00:00Z'));

    expect(result.totalSearches).toBe(0);
    expect(result.topQueryCount).toBe(0);
    expect(result.sortBucketCount).toBe(0);
    expect(result.attributedBookings).toBe(0);
    expect(result.zeroResultRatePpm).toBeNull();
    expect(result.approxConversionPpm).toBeNull();
    expect(result.attributedConversionPpm).toBeNull();

    // The summary row is always written (one row per day); the detail marts
    // are skipped when empty.
    expect(tx.searchRelevanceDaily.create).toHaveBeenCalledTimes(1);
    expect(tx.searchQueryDaily.createMany).not.toHaveBeenCalled();
    expect(tx.searchSortDaily.createMany).not.toHaveBeenCalled();
    expect(tx.searchClickPositionDaily.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.searchClickPositionDaily.createMany).not.toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledWith({
      where: { id: 'run_test_1' },
      data: { status: 'succeeded', eventCount: 0, completedAt: expect.any(Date) },
    });
  });

  it('stamps the run failed and rethrows when the mart transaction throws', async () => {
    const boom = new Error('deadlock detected');
    const { prisma, runUpdate } = makePrisma({
      sortTotals: [{ sort: 'relevance', _count: { _all: 5 } }],
      sortZeros: [{ sort: 'relevance', _count: { _all: 1 } }],
      distinctSearcherGroups: searcherGroups(3),
      bookingsCreated: 0,
      transactionThrows: boom,
    });
    const service = new SearchRelevanceService(prisma);

    await expect(service.computeForDate(new Date('2026-06-08T12:00:00Z'))).rejects.toThrow(
      'deadlock detected',
    );

    expect(runUpdate).toHaveBeenCalledWith({
      where: { id: 'run_test_1' },
      data: { status: 'failed', errorSummary: 'deadlock detected', completedAt: expect.any(Date) },
    });
  });
});
