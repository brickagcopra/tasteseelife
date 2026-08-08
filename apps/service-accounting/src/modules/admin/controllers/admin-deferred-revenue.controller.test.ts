import { describe, expect, it, vi } from 'vitest';

import { AdminDeferredRevenueController } from './admin-deferred-revenue.controller';
import type {
  AdminDeferredRevenueService,
  PausedBalanceRow,
  PausedBalancesView,
} from '../services/admin-deferred-revenue.service';

const ASOF = new Date('2026-06-01T00:00:00.000Z');

const sampleRow: PausedBalanceRow = {
  balanceId: 'drb_1',
  subscriptionId: 'sub_1',
  customerId: 'hh_1',
  customerGroup: 'family',
  planCode: 'family.tier2',
  currency: 'USD',
  pausedAt: new Date('2026-05-01T00:00:00.000Z'),
  pausedForSeconds: 2_678_400,
  priorPausedSeconds: 0,
  servicePeriodStart: new Date('2026-04-01T00:00:00.000Z'),
  servicePeriodEnd: new Date('2026-05-15T00:00:00.000Z'),
  pastServicePeriodEnd: true,
  originalAmountMinor: 29_900,
  recognizedAmountMinor: 12_000,
  remainingDeferredMinor: 17_900,
};

const sampleView: PausedBalancesView = {
  asOf: ASOF,
  summary: {
    pausedCount: 1,
    pastServicePeriodEndCount: 1,
    unknownPausedAtCount: 0,
    oldestPausedAt: new Date('2026-05-01T00:00:00.000Z'),
    totalRemainingDeferredMinor: 17_900,
  },
  balances: [sampleRow],
  truncated: false,
};

function buildService(view: PausedBalancesView = sampleView): AdminDeferredRevenueService {
  return {
    listPaused: vi.fn(async () => view),
  } as unknown as AdminDeferredRevenueService;
}

describe('AdminDeferredRevenueController.listPaused', () => {
  it('maps the view onto the contract shape', async () => {
    const service = buildService();
    const controller = new AdminDeferredRevenueController(service);

    const result = await controller.listPaused({ limit: 50 });

    expect(result.asOf).toBe('2026-06-01T00:00:00.000Z');
    expect(result.summary.pausedCount).toBe(1);
    expect(result.summary.totalRemainingDeferredMinor).toBe(17_900);
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0]?.pausedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(result.balances[0]?.pastServicePeriodEnd).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('serialises a null pause instant and a null age', async () => {
    const controller = new AdminDeferredRevenueController(
      buildService({
        ...sampleView,
        summary: { ...sampleView.summary, unknownPausedAtCount: 1, oldestPausedAt: null },
        balances: [{ ...sampleRow, pausedAt: null, pausedForSeconds: null }],
      }),
    );

    const result = await controller.listPaused({ limit: 50 });

    expect(result.balances[0]?.pausedAt).toBeNull();
    expect(result.balances[0]?.pausedForSeconds).toBeNull();
    expect(result.summary.oldestPausedAt).toBeNull();
  });

  it('renders an empty queue as a zeroed summary, not an error', async () => {
    const controller = new AdminDeferredRevenueController(
      buildService({
        asOf: ASOF,
        summary: {
          pausedCount: 0,
          pastServicePeriodEndCount: 0,
          unknownPausedAtCount: 0,
          oldestPausedAt: null,
          totalRemainingDeferredMinor: 0,
        },
        balances: [],
        truncated: false,
      }),
    );

    const result = await controller.listPaused({ limit: 50 });

    expect(result.summary.pausedCount).toBe(0);
    expect(result.balances).toEqual([]);
  });

  it('passes the caller-supplied asOf through to the service', async () => {
    const service = buildService();
    const controller = new AdminDeferredRevenueController(service);

    await controller.listPaused({ limit: 10, asOf: '2026-05-20T09:30:00.000Z' });

    expect(service.listPaused).toHaveBeenCalledWith({
      asOf: new Date('2026-05-20T09:30:00.000Z'),
      limit: 10,
    });
  });

  it('defaults asOf to now when the caller omits it', async () => {
    const service = buildService();
    const controller = new AdminDeferredRevenueController(service);
    const before = Date.now();

    await controller.listPaused({ limit: 50 });

    const call = vi.mocked(service.listPaused).mock.calls[0]?.[0];
    expect(call?.asOf.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('rejects a non-USD balance rather than under-reporting the stranded total', async () => {
    // Phase-1 posture: the queue exists to find stranded revenue, so a row
    // it cannot express must break the surface loudly rather than be
    // silently dropped from it.
    const controller = new AdminDeferredRevenueController(
      buildService({
        ...sampleView,
        balances: [{ ...sampleRow, currency: 'EUR' }],
      }),
    );

    await expect(controller.listPaused({ limit: 50 })).rejects.toThrow(/EUR/);
  });
});
