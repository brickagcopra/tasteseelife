import type { ListSaasMetricsResponse, SaasMetricsRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import { AdminSaasMetricsController } from './admin-saas-metrics.controller';
import type { SaasMetricsService } from '../services/saas-metrics.service';

function record(metricDate: string): SaasMetricsRecord {
  return {
    metricDate,
    currency: 'USD',
    mrrMinor: 22_800,
    arrMinor: 273_600,
    arpuMinor: 11_400,
    activeSubscriptions: 2,
    newMrrMinor: 0,
    expansionMrrMinor: 0,
    contractionMrrMinor: 0,
    churnedMrrMinor: 0,
    churnedSubscriptions: 0,
    netNewMrrMinor: 0,
    priorMrrMinor: 22_800,
    netRevenueRetentionPpm: 1_027_100,
    grossRevenueRetentionPpm: 992_547,
    ltvMinor: null,
    cacMinor: null,
    comparisonDate: null,
    computedAt: '2026-05-28T02:00:00.000Z',
  };
}

const sampleResponse: ListSaasMetricsResponse = {
  metrics: [record('2026-05-27'), record('2026-05-28')],
  from: '2026-05-27',
  to: '2026-05-28',
};

type ListForDateRangeImpl = (range: { from?: Date; to?: Date }) => Promise<ListSaasMetricsResponse>;

function buildService(opts: { listForDateRange?: ListForDateRangeImpl }): SaasMetricsService {
  return {
    listForDateRange: vi.fn(opts.listForDateRange ?? (async () => sampleResponse)),
  } as unknown as SaasMetricsService;
}

describe('AdminSaasMetricsController.list', () => {
  it('returns the validated series from the service unchanged', async () => {
    const service = buildService({});
    const controller = new AdminSaasMetricsController(service);
    const result = await controller.list({});
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics.map((m) => m.metricDate)).toEqual(['2026-05-27', '2026-05-28']);
    expect(result.from).toBe('2026-05-27');
    expect(result.to).toBe('2026-05-28');
  });

  it('forwards both bounds as midnight-UTC Dates', async () => {
    let captured: { from?: Date; to?: Date } | undefined;
    const service = buildService({
      listForDateRange: async (range) => {
        captured = range;
        return sampleResponse;
      },
    });
    const controller = new AdminSaasMetricsController(service);
    await controller.list({ from: '2026-05-01', to: '2026-05-28' });
    expect(captured?.from?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(captured?.to?.toISOString()).toBe('2026-05-28T00:00:00.000Z');
  });

  it('omits an undefined bound from the forwarded input', async () => {
    let captured: { from?: Date; to?: Date } | undefined;
    const service = buildService({
      listForDateRange: async (range) => {
        captured = range;
        return sampleResponse;
      },
    });
    const controller = new AdminSaasMetricsController(service);
    await controller.list({ from: '2026-05-01' });
    expect(captured?.from?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(captured !== undefined && 'to' in captured).toBe(false);
  });

  it('passes an empty range through when no bounds are supplied', async () => {
    let captured: { from?: Date; to?: Date } | undefined;
    const service = buildService({
      listForDateRange: async (range) => {
        captured = range;
        return sampleResponse;
      },
    });
    const controller = new AdminSaasMetricsController(service);
    await controller.list({});
    expect(captured).toEqual({});
  });

  it('throws when the service returns a contract-violating record', async () => {
    const service = buildService({
      listForDateRange: async () =>
        ({
          metrics: [{ ...record('2026-05-28'), mrrMinor: -1 }],
          from: '2026-05-28',
          to: '2026-05-28',
        }) as unknown as ListSaasMetricsResponse,
    });
    const controller = new AdminSaasMetricsController(service);
    await expect(controller.list({})).rejects.toThrow();
  });

  it('returns an empty series + null bounds verbatim', async () => {
    const service = buildService({
      listForDateRange: async () => ({ metrics: [], from: null, to: null }),
    });
    const controller = new AdminSaasMetricsController(service);
    const result = await controller.list({});
    expect(result.metrics).toEqual([]);
    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
  });
});
