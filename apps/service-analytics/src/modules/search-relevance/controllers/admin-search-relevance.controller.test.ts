import type {
  ListSearchRelevanceDailyResponse,
  SearchRelevanceDailySummary,
  SearchRelevanceDayDetailResponse,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import { AdminSearchRelevanceController } from './admin-search-relevance.controller';
import type { SearchRelevanceReadService } from '../services/search-relevance-read.service';

function summary(metricDate: string): SearchRelevanceDailySummary {
  return {
    metricDate,
    totalSearches: 120,
    zeroResultSearches: 18,
    distinctSearchers: 40,
    bookingsCreated: 6,
    attributedBookings: 4,
    zeroResultRatePpm: 150_000,
    approxConversionPpm: 150_000,
    attributedConversionPpm: 33_333,
    computedAt: '2026-06-09T03:00:00.000Z',
  };
}

const sampleSummaries: ListSearchRelevanceDailyResponse = {
  summaries: [summary('2026-06-07'), summary('2026-06-08')],
  from: '2026-06-07',
  to: '2026-06-08',
};

const sampleDetail: SearchRelevanceDayDetailResponse = {
  metricDate: '2026-06-08',
  summary: summary('2026-06-08'),
  topQueries: [{ queryText: 'kosher chef', searchCount: 30, zeroResultCount: 2 }],
  zeroResultQueries: [{ queryText: 'vegan sushi', searchCount: 5, zeroResultCount: 5 }],
  sortBreakdown: [{ sort: 'relevance', searchCount: 100, zeroResultCount: 12 }],
  clickPositions: [{ position: 0, clickCount: 40, impressionCount: 120, ctrPpm: 333_333 }],
};

function buildService(opts: {
  listDailySummaries?: (range: {
    from?: Date;
    to?: Date;
  }) => Promise<ListSearchRelevanceDailyResponse>;
  getDayDetail?: (date: Date) => Promise<SearchRelevanceDayDetailResponse>;
}): SearchRelevanceReadService {
  return {
    listDailySummaries: vi.fn(opts.listDailySummaries ?? (async () => sampleSummaries)),
    getDayDetail: vi.fn(opts.getDayDetail ?? (async () => sampleDetail)),
  } as unknown as SearchRelevanceReadService;
}

describe('AdminSearchRelevanceController.listSummaries', () => {
  it('returns the validated series from the service unchanged', async () => {
    const controller = new AdminSearchRelevanceController(buildService({}));
    const result = await controller.listSummaries({});
    expect(result.summaries.map((s) => s.metricDate)).toEqual(['2026-06-07', '2026-06-08']);
    expect(result.from).toBe('2026-06-07');
    expect(result.to).toBe('2026-06-08');
  });

  it('forwards both bounds as midnight-UTC Dates', async () => {
    let captured: { from?: Date; to?: Date } | undefined;
    const controller = new AdminSearchRelevanceController(
      buildService({
        listDailySummaries: async (range) => {
          captured = range;
          return sampleSummaries;
        },
      }),
    );
    await controller.listSummaries({ from: '2026-06-01', to: '2026-06-08' });
    expect(captured?.from?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(captured?.to?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('omits an undefined bound from the forwarded input', async () => {
    let captured: { from?: Date; to?: Date } | undefined;
    const controller = new AdminSearchRelevanceController(
      buildService({
        listDailySummaries: async (range) => {
          captured = range;
          return sampleSummaries;
        },
      }),
    );
    await controller.listSummaries({ from: '2026-06-01' });
    expect(captured?.from?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(captured !== undefined && 'to' in captured).toBe(false);
  });

  it('throws when the service returns a contract-violating summary', async () => {
    const controller = new AdminSearchRelevanceController(
      buildService({
        listDailySummaries: async () =>
          ({
            summaries: [{ ...summary('2026-06-08'), totalSearches: -1 }],
            from: '2026-06-08',
            to: '2026-06-08',
          }) as unknown as ListSearchRelevanceDailyResponse,
      }),
    );
    await expect(controller.listSummaries({})).rejects.toThrow();
  });
});

describe('AdminSearchRelevanceController.getDetail', () => {
  it('returns the validated day detail from the service unchanged', async () => {
    const controller = new AdminSearchRelevanceController(buildService({}));
    const result = await controller.getDetail({ date: '2026-06-08' });
    expect(result.metricDate).toBe('2026-06-08');
    expect(result.topQueries).toHaveLength(1);
    expect(result.clickPositions[0]?.ctrPpm).toBe(333_333);
  });

  it('forwards the date as a midnight-UTC Date', async () => {
    let captured: Date | undefined;
    const controller = new AdminSearchRelevanceController(
      buildService({
        getDayDetail: async (date) => {
          captured = date;
          return sampleDetail;
        },
      }),
    );
    await controller.getDetail({ date: '2026-06-08' });
    expect(captured?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('passes a null-summary day through verbatim', async () => {
    const controller = new AdminSearchRelevanceController(
      buildService({
        getDayDetail: async () => ({
          metricDate: '2026-06-08',
          summary: null,
          topQueries: [],
          zeroResultQueries: [],
          sortBreakdown: [],
          clickPositions: [],
        }),
      }),
    );
    const result = await controller.getDetail({ date: '2026-06-08' });
    expect(result.summary).toBeNull();
    expect(result.topQueries).toEqual([]);
  });
});
