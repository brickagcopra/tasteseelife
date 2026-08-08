import { describe, expect, it, vi } from 'vitest';

import { AdminTrialBalanceController } from './admin-trial-balance.controller';
import type { TrialBalanceComputed, TrialBalanceService } from '../services/trial-balance.service';

const sampleComputed: TrialBalanceComputed = {
  rows: [
    {
      accountId: 'acc_cash',
      accountCode: '1000',
      accountName: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
      debitTotalMinor: 29_900,
      creditTotalMinor: 0,
      netDebitMinor: 29_900,
      netCreditMinor: 0,
      currency: 'USD',
    },
    {
      accountId: 'acc_def',
      accountCode: '2000.family.tier2',
      accountName: 'Deferred Revenue T2',
      accountType: 'liability',
      normalBalance: 'credit',
      debitTotalMinor: 0,
      creditTotalMinor: 29_900,
      netDebitMinor: 0,
      netCreditMinor: 29_900,
      currency: 'USD',
    },
  ],
  totalDebitMinor: 29_900,
  totalCreditMinor: 29_900,
  imbalanceMinor: 0,
  currency: 'USD',
  periodId: null,
  periodName: null,
};

function buildService(opts: {
  compute?: () => Promise<TrialBalanceComputed>;
}): TrialBalanceService {
  return {
    compute: vi.fn(opts.compute ?? (async () => sampleComputed)),
  } as unknown as TrialBalanceService;
}

describe('AdminTrialBalanceController.compute', () => {
  it('returns the rows + totals from the service unchanged', async () => {
    const service = buildService({});
    const controller = new AdminTrialBalanceController(service);
    const result = await controller.compute({});
    expect(result.rows).toHaveLength(2);
    expect(result.totalDebitMinor).toBe(29_900);
    expect(result.totalCreditMinor).toBe(29_900);
    expect(result.imbalanceMinor).toBe(0);
    expect(result.currency).toBe('USD');
    expect(result.periodId).toBeNull();
    expect(result.periodName).toBeNull();
  });

  it('echoes period scope in the response when supplied', async () => {
    const service = buildService({
      compute: async () => ({
        ...sampleComputed,
        periodId: 'per_x',
        periodName: '2026-05',
      }),
    });
    const controller = new AdminTrialBalanceController(service);
    const result = await controller.compute({ periodName: '2026-05' });
    expect(result.periodId).toBe('per_x');
    expect(result.periodName).toBe('2026-05');
  });

  it('forwards every query option into the service', async () => {
    const computeSpy = vi.fn(async () => sampleComputed);
    const service = buildService({ compute: computeSpy });
    const controller = new AdminTrialBalanceController(service);
    await controller.compute({
      periodId: 'per_x',
      periodName: '2026-05',
      currency: 'USD',
    });
    expect(computeSpy).toHaveBeenCalledWith({
      periodId: 'per_x',
      periodName: '2026-05',
      currency: 'USD',
    });
  });

  it('omits undefined filters from the forwarded input', async () => {
    const computeSpy = vi.fn(async () => sampleComputed);
    const service = buildService({ compute: computeSpy });
    const controller = new AdminTrialBalanceController(service);
    await controller.compute({});
    expect(computeSpy).toHaveBeenCalledWith({});
  });

  it('surfaces an imbalance on the response', async () => {
    const service = buildService({
      compute: async () => ({
        ...sampleComputed,
        totalDebitMinor: 10_000,
        totalCreditMinor: 9_900,
        imbalanceMinor: 100,
      }),
    });
    const controller = new AdminTrialBalanceController(service);
    const result = await controller.compute({});
    expect(result.imbalanceMinor).toBe(100);
  });
});
