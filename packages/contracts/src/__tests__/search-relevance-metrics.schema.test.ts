import { describe, expect, it } from 'vitest';

import {
  ComputeSearchRelevanceMetricsRequestSchema,
  ComputeSearchRelevanceMetricsResponseSchema,
  ListSearchRelevanceDailyResponseSchema,
  SEARCH_RELEVANCE_MAX_RATE_PPM,
  SearchRelevanceDailySummarySchema,
  SearchRelevanceDayDetailResponseSchema,
  SearchRelevanceDetailQuerySchema,
  SearchRelevanceMetricsDateSchema,
  SearchRelevanceRangeQuerySchema,
} from '../http/search-relevance-metrics.schema';

describe('SearchRelevanceMetricsDateSchema', () => {
  it('accepts a UTC calendar date', () => {
    expect(SearchRelevanceMetricsDateSchema.safeParse('2026-06-08').success).toBe(true);
  });

  it('rejects a non-date string', () => {
    expect(SearchRelevanceMetricsDateSchema.safeParse('2026/06/08').success).toBe(false);
    expect(SearchRelevanceMetricsDateSchema.safeParse('not-a-date').success).toBe(false);
  });
});

describe('ComputeSearchRelevanceMetricsRequestSchema', () => {
  it('accepts an empty body (asOf defaults server-side)', () => {
    expect(ComputeSearchRelevanceMetricsRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an ISO-8601 asOf', () => {
    expect(
      ComputeSearchRelevanceMetricsRequestSchema.safeParse({ asOf: '2026-06-08T00:00:00.000Z' })
        .success,
    ).toBe(true);
  });

  it('rejects a non-datetime asOf', () => {
    expect(
      ComputeSearchRelevanceMetricsRequestSchema.safeParse({ asOf: '2026-06-08' }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(ComputeSearchRelevanceMetricsRequestSchema.safeParse({ extra: true }).success).toBe(
      false,
    );
  });
});

describe('ComputeSearchRelevanceMetricsResponseSchema', () => {
  const valid = {
    metricDate: '2026-06-08',
    totalSearches: 120,
    zeroResultSearches: 18,
    distinctSearchers: 40,
    bookingsCreated: 6,
    attributedBookings: 4,
    topQueryCount: 55,
    sortBucketCount: 3,
    zeroResultRatePpm: 150_000,
    approxConversionPpm: 150_000,
    attributedConversionPpm: 33_333,
    runId: 'run_abc123',
    computedAt: '2026-06-09T03:00:00.000Z',
  };

  it('accepts a well-formed response', () => {
    expect(ComputeSearchRelevanceMetricsResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts null rate fields (zero-search / zero-searcher day)', () => {
    const parsed = ComputeSearchRelevanceMetricsResponseSchema.safeParse({
      ...valid,
      totalSearches: 0,
      zeroResultSearches: 0,
      distinctSearchers: 0,
      bookingsCreated: 0,
      attributedBookings: 0,
      topQueryCount: 0,
      sortBucketCount: 0,
      zeroResultRatePpm: null,
      approxConversionPpm: null,
      attributedConversionPpm: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing attribution field', () => {
    const { attributedBookings: _omit, ...withoutAttribution } = valid;
    expect(ComputeSearchRelevanceMetricsResponseSchema.safeParse(withoutAttribution).success).toBe(
      false,
    );
  });

  it('rejects an attributed conversion rate above the sanity cap', () => {
    expect(
      ComputeSearchRelevanceMetricsResponseSchema.safeParse({
        ...valid,
        attributedConversionPpm: SEARCH_RELEVANCE_MAX_RATE_PPM + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(
      ComputeSearchRelevanceMetricsResponseSchema.safeParse({ ...valid, totalSearches: -1 })
        .success,
    ).toBe(false);
  });

  it('rejects a rate above the sanity cap', () => {
    expect(
      ComputeSearchRelevanceMetricsResponseSchema.safeParse({
        ...valid,
        approxConversionPpm: SEARCH_RELEVANCE_MAX_RATE_PPM + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      ComputeSearchRelevanceMetricsResponseSchema.safeParse({ ...valid, extra: 1 }).success,
    ).toBe(false);
  });
});

const validSummary = {
  metricDate: '2026-06-08',
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

describe('SearchRelevanceDailySummarySchema', () => {
  it('accepts a well-formed summary', () => {
    expect(SearchRelevanceDailySummarySchema.safeParse(validSummary).success).toBe(true);
  });

  it('accepts null rate fields (zero-search day)', () => {
    expect(
      SearchRelevanceDailySummarySchema.safeParse({
        ...validSummary,
        totalSearches: 0,
        distinctSearchers: 0,
        zeroResultRatePpm: null,
        approxConversionPpm: null,
        attributedConversionPpm: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a rate above the sanity cap', () => {
    expect(
      SearchRelevanceDailySummarySchema.safeParse({
        ...validSummary,
        zeroResultRatePpm: SEARCH_RELEVANCE_MAX_RATE_PPM + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(SearchRelevanceDailySummarySchema.safeParse({ ...validSummary, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('SearchRelevanceRangeQuerySchema', () => {
  it('accepts an empty query (both bounds optional)', () => {
    expect(SearchRelevanceRangeQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts from <= to', () => {
    expect(
      SearchRelevanceRangeQuerySchema.safeParse({ from: '2026-06-01', to: '2026-06-08' }).success,
    ).toBe(true);
  });

  it('rejects from after to', () => {
    expect(
      SearchRelevanceRangeQuerySchema.safeParse({ from: '2026-06-09', to: '2026-06-08' }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(SearchRelevanceRangeQuerySchema.safeParse({ page: 2 }).success).toBe(false);
  });
});

describe('ListSearchRelevanceDailyResponseSchema', () => {
  it('accepts a series with echoed window bounds', () => {
    expect(
      ListSearchRelevanceDailyResponseSchema.safeParse({
        summaries: [validSummary],
        from: '2026-06-08',
        to: '2026-06-08',
      }).success,
    ).toBe(true);
  });

  it('accepts an empty series with null bounds', () => {
    expect(
      ListSearchRelevanceDailyResponseSchema.safeParse({ summaries: [], from: null, to: null })
        .success,
    ).toBe(true);
  });
});

describe('SearchRelevanceDetailQuerySchema', () => {
  it('requires a date', () => {
    expect(SearchRelevanceDetailQuerySchema.safeParse({}).success).toBe(false);
    expect(SearchRelevanceDetailQuerySchema.safeParse({ date: '2026-06-08' }).success).toBe(true);
  });
});

describe('SearchRelevanceDayDetailResponseSchema', () => {
  const valid = {
    metricDate: '2026-06-08',
    summary: validSummary,
    topQueries: [{ queryText: 'kosher chef', searchCount: 30, zeroResultCount: 2 }],
    zeroResultQueries: [{ queryText: 'vegan sushi', searchCount: 5, zeroResultCount: 5 }],
    sortBreakdown: [{ sort: 'relevance', searchCount: 100, zeroResultCount: 12 }],
    clickPositions: [
      { position: 0, clickCount: 40, impressionCount: 120, ctrPpm: 333_333 },
      { position: 5, clickCount: 1, impressionCount: 0, ctrPpm: null },
    ],
  };

  it('accepts a well-formed detail', () => {
    expect(SearchRelevanceDayDetailResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a never-aggregated day (null summary, empty lists)', () => {
    expect(
      SearchRelevanceDayDetailResponseSchema.safeParse({
        metricDate: '2026-06-08',
        summary: null,
        topQueries: [],
        zeroResultQueries: [],
        sortBreakdown: [],
        clickPositions: [],
      }).success,
    ).toBe(true);
  });

  it('rejects a click position with an out-of-range ctr', () => {
    expect(
      SearchRelevanceDayDetailResponseSchema.safeParse({
        ...valid,
        clickPositions: [
          {
            position: 0,
            clickCount: 1,
            impressionCount: 1,
            ctrPpm: SEARCH_RELEVANCE_MAX_RATE_PPM + 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(SearchRelevanceDayDetailResponseSchema.safeParse({ ...valid, extra: 1 }).success).toBe(
      false,
    );
  });
});
