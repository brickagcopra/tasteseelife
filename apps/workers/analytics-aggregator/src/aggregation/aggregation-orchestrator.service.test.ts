import { describe, expect, it, vi } from 'vitest';

import type { AggregationClient } from './clients/aggregation.client';
import { AggregationOrchestratorService } from './aggregation-orchestrator.service';

function makeClient(compute: ReturnType<typeof vi.fn>): AggregationClient {
  return { compute } as unknown as AggregationClient;
}

const okResult = {
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
  runId: 'run_test_1',
  computedAt: '2026-06-09T03:00:00.000Z',
};

describe('AggregationOrchestratorService.runForDay', () => {
  it('computes with the date-keyed idempotency key + start-of-day asOf and returns true', async () => {
    const compute = vi.fn(async () => okResult);
    const orchestrator = new AggregationOrchestratorService(makeClient(compute));

    const ok = await orchestrator.runForDay('2026-06-08');

    expect(ok).toBe(true);
    expect(compute).toHaveBeenCalledWith(
      '2026-06-08T00:00:00.000Z',
      'search-relevance:compute:2026-06-08',
    );
  });

  it('returns false (without throwing) when the compute call fails', async () => {
    const compute = vi.fn(async () => {
      throw new Error('service-analytics: non-2xx response (status=503)');
    });
    const orchestrator = new AggregationOrchestratorService(makeClient(compute));

    const ok = await orchestrator.runForDay('2026-06-08');

    expect(ok).toBe(false);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
