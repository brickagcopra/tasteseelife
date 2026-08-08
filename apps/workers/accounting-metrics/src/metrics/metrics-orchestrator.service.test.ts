import { describe, expect, it, vi } from 'vitest';

import type { MetricsClient } from './clients/metrics.client';
import { MetricsOrchestratorService } from './metrics-orchestrator.service';

function makeClient(compute: ReturnType<typeof vi.fn>): MetricsClient {
  return { compute } as unknown as MetricsClient;
}

const okResult = {
  metrics: {
    metricDate: '2026-05-28',
    currency: 'USD' as const,
    mrrMinor: 22_800,
    arrMinor: 273_600,
    arpuMinor: 11_400,
    activeSubscriptions: 2,
    newMrrMinor: 22_800,
    expansionMrrMinor: 0,
    contractionMrrMinor: 0,
    churnedMrrMinor: 0,
    churnedSubscriptions: 0,
    netNewMrrMinor: 22_800,
    priorMrrMinor: 0,
    netRevenueRetentionPpm: null,
    grossRevenueRetentionPpm: null,
    ltvMinor: null,
    cacMinor: null,
    comparisonDate: null,
    computedAt: '2026-05-28T02:00:00.000Z',
  },
  subscriptionsSnapshotted: 2,
};

describe('MetricsOrchestratorService.runForDay', () => {
  it('computes with the date-keyed idempotency key and returns true', async () => {
    const compute = vi.fn(async () => okResult);
    const orchestrator = new MetricsOrchestratorService(makeClient(compute));

    const ok = await orchestrator.runForDay('2026-05-28');

    expect(ok).toBe(true);
    expect(compute).toHaveBeenCalledWith('saas-metrics:compute:2026-05-28');
  });

  it('returns false (without throwing) when the compute call fails', async () => {
    const compute = vi.fn(async () => {
      throw new Error('service-accounting: non-2xx response (status=503)');
    });
    const orchestrator = new MetricsOrchestratorService(makeClient(compute));

    const ok = await orchestrator.runForDay('2026-05-28');

    expect(ok).toBe(false);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
