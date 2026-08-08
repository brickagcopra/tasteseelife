import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { SearchRelevanceReadService } from './search-relevance-read.service';

/**
 * A fake tenant-scoped `PrismaService` for the read paths. Each mart model
 * exposes the `findMany` / `findUnique` the read service calls; the spies
 * return canned rows so the test asserts mapping + ordering wiring without a DB.
 * Dates arrive as `@db.Date` → JS `Date` at midnight UTC.
 */
function makePrisma(opts: {
  readonly summaryRows?: unknown[];
  readonly summaryRow?: unknown;
  readonly queryRows?: unknown[];
  readonly zeroQueryRows?: unknown[];
  readonly sortRows?: unknown[];
  readonly clickRows?: unknown[];
}): {
  prisma: PrismaService;
  summaryFindMany: ReturnType<typeof vi.fn>;
  summaryFindUnique: ReturnType<typeof vi.fn>;
  queryFindMany: ReturnType<typeof vi.fn>;
} {
  const summaryFindMany = vi.fn(async () => opts.summaryRows ?? []);
  const summaryFindUnique = vi.fn(async () => opts.summaryRow ?? null);
  // Dispatch the two query-mart reads on the presence of the zero-result filter.
  const queryFindMany = vi.fn(async (args: { where?: { zeroResultCount?: unknown } }) =>
    args.where?.zeroResultCount !== undefined ? (opts.zeroQueryRows ?? []) : (opts.queryRows ?? []),
  );

  const prisma = {
    searchRelevanceDaily: { findMany: summaryFindMany, findUnique: summaryFindUnique },
    searchQueryDaily: { findMany: queryFindMany },
    searchSortDaily: { findMany: vi.fn(async () => opts.sortRows ?? []) },
    searchClickPositionDaily: { findMany: vi.fn(async () => opts.clickRows ?? []) },
  } as unknown as PrismaService;

  return { prisma, summaryFindMany, summaryFindUnique, queryFindMany };
}

const utcDate = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

describe('SearchRelevanceReadService.listDailySummaries', () => {
  it('maps rows to the wire shape, derives rate ppm, and orders ascending', async () => {
    // Returned newest-first off the b-tree (orderBy desc) — service reverses.
    const { prisma } = makePrisma({
      summaryRows: [
        {
          metricDate: utcDate('2026-06-09'),
          totalSearches: 200,
          zeroResultSearches: 50,
          distinctSearchers: 80,
          bookingsCreated: 8,
          attributedBookings: 4,
          computedAt: utcDate('2026-06-10'),
        },
        {
          metricDate: utcDate('2026-06-08'),
          totalSearches: 100,
          zeroResultSearches: 25,
          distinctSearchers: 40,
          bookingsCreated: 4,
          attributedBookings: 2,
          computedAt: utcDate('2026-06-09'),
        },
      ],
    });
    const service = new SearchRelevanceReadService(prisma);

    const result = await service.listDailySummaries({});

    expect(result.summaries.map((s) => s.metricDate)).toEqual(['2026-06-08', '2026-06-09']);
    expect(result.from).toBe('2026-06-08');
    expect(result.to).toBe('2026-06-09');
    // 25/100 = 250_000 ppm; 4/40 (approx conversion) = 100_000 ppm; 2/100 (precise) = 20_000 ppm.
    const earliest = result.summaries[0];
    expect(earliest?.zeroResultRatePpm).toBe(250_000);
    expect(earliest?.approxConversionPpm).toBe(100_000);
    expect(earliest?.attributedConversionPpm).toBe(20_000);
    expect(earliest?.computedAt).toBe('2026-06-09T00:00:00.000Z');
  });

  it('returns null rate fields + null window bounds for an empty range', async () => {
    const { prisma } = makePrisma({ summaryRows: [] });
    const service = new SearchRelevanceReadService(prisma);

    const result = await service.listDailySummaries({ from: utcDate('2026-01-01') });

    expect(result.summaries).toEqual([]);
    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
  });

  it('passes an inclusive metric-date filter when bounds are supplied', async () => {
    const { prisma, summaryFindMany } = makePrisma({ summaryRows: [] });
    const service = new SearchRelevanceReadService(prisma);

    await service.listDailySummaries({ from: utcDate('2026-06-01'), to: utcDate('2026-06-08') });

    const args = summaryFindMany.mock.calls[0]?.[0] as {
      where?: { metricDate?: { gte?: Date; lte?: Date } };
    };
    expect(args.where?.metricDate?.gte?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(args.where?.metricDate?.lte?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });
});

describe('SearchRelevanceReadService.getDayDetail', () => {
  it('assembles the summary + four detail lists with derived CTR', async () => {
    const { prisma } = makePrisma({
      summaryRow: {
        metricDate: utcDate('2026-06-08'),
        totalSearches: 120,
        zeroResultSearches: 18,
        distinctSearchers: 40,
        bookingsCreated: 6,
        attributedBookings: 4,
        computedAt: utcDate('2026-06-09'),
      },
      queryRows: [{ queryText: 'kosher chef', searchCount: 30, zeroResultCount: 2 }],
      zeroQueryRows: [{ queryText: 'vegan sushi', searchCount: 5, zeroResultCount: 5 }],
      sortRows: [{ sort: 'relevance', searchCount: 100, zeroResultCount: 12 }],
      clickRows: [
        { position: 0, clickCount: 40, impressionCount: 120 },
        { position: 5, clickCount: 1, impressionCount: 0 },
      ],
    });
    const service = new SearchRelevanceReadService(prisma);

    const result = await service.getDayDetail(utcDate('2026-06-08'));

    expect(result.metricDate).toBe('2026-06-08');
    expect(result.summary?.attributedConversionPpm).toBe(33_333); // 4/120
    expect(result.topQueries).toEqual([
      { queryText: 'kosher chef', searchCount: 30, zeroResultCount: 2 },
    ]);
    expect(result.zeroResultQueries).toEqual([
      { queryText: 'vegan sushi', searchCount: 5, zeroResultCount: 5 },
    ]);
    expect(result.sortBreakdown).toEqual([
      { sort: 'relevance', searchCount: 100, zeroResultCount: 12 },
    ]);
    // CTR: 40/120 → 333_333 ppm; zero-impression denominator → null.
    expect(result.clickPositions).toEqual([
      { position: 0, clickCount: 40, impressionCount: 120, ctrPpm: 333_333 },
      { position: 5, clickCount: 1, impressionCount: 0, ctrPpm: null },
    ]);
  });

  it('returns a null summary for a never-aggregated day', async () => {
    const { prisma } = makePrisma({ summaryRow: null });
    const service = new SearchRelevanceReadService(prisma);

    const result = await service.getDayDetail(utcDate('2026-06-08'));

    expect(result.summary).toBeNull();
    expect(result.topQueries).toEqual([]);
    expect(result.clickPositions).toEqual([]);
  });

  it('reads the day-detail by the midnight-UTC metric-date key', async () => {
    const { prisma, summaryFindUnique } = makePrisma({ summaryRow: null });
    const service = new SearchRelevanceReadService(prisma);

    await service.getDayDetail(utcDate('2026-06-08'));

    const args = summaryFindUnique.mock.calls[0]?.[0] as { where?: { metricDate?: Date } };
    expect(args.where?.metricDate?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });
});
