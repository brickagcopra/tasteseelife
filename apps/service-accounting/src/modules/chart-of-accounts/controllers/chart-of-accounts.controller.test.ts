import { describe, expect, it, vi } from 'vitest';

import type { Account } from '@taste-and-see/contracts';

import { ChartOfAccountsController } from './chart-of-accounts.controller';
import type { ChartOfAccountsService } from '../services/chart-of-accounts.service';

class FakeChartOfAccountsService {
  public lastFilter: {
    type?: string;
    parentId?: string;
    activeOnly: boolean;
  } | null = null;
  public stubAccounts: Account[] = [];

  list = vi.fn(
    async (filter: {
      type?: string;
      parentId?: string;
      activeOnly: boolean;
    }): Promise<readonly Account[]> => {
      this.lastFilter = filter;
      return this.stubAccounts;
    },
  );
}

function buildController(): {
  controller: ChartOfAccountsController;
  service: FakeChartOfAccountsService;
} {
  const service = new FakeChartOfAccountsService();
  const controller = new ChartOfAccountsController(service as unknown as ChartOfAccountsService);
  return { controller, service };
}

const sample: Account = {
  id: 'coa_cash',
  code: '1000',
  name: 'Cash',
  description: 'Operating bank + Stripe balance.',
  type: 'asset',
  parentId: null,
  normalBalance: 'debit',
  currency: 'USD',
  active: true,
  createdAt: '2026-05-13T00:00:00.000Z',
  updatedAt: '2026-05-13T00:00:00.000Z',
};

describe('ChartOfAccountsController.list', () => {
  it('returns the service result wrapped in { accounts: [...] }', async () => {
    const { controller, service } = buildController();
    service.stubAccounts = [sample];

    const result = await controller.list({ activeOnly: true });
    expect(result).toEqual({ accounts: [sample] });
  });

  it('passes the activeOnly default through', async () => {
    const { controller, service } = buildController();
    await controller.list({ activeOnly: true });
    expect(service.lastFilter).toEqual({ activeOnly: true });
  });

  it('forwards a type filter', async () => {
    const { controller, service } = buildController();
    await controller.list({ activeOnly: true, type: 'revenue' });
    expect(service.lastFilter).toEqual({ activeOnly: true, type: 'revenue' });
  });

  it('forwards a parentId filter', async () => {
    const { controller, service } = buildController();
    await controller.list({ activeOnly: true, parentId: 'coa_2000' });
    expect(service.lastFilter).toEqual({
      activeOnly: true,
      parentId: 'coa_2000',
    });
  });

  it('forwards activeOnly=false (admin "retired accounts" view)', async () => {
    const { controller, service } = buildController();
    await controller.list({ activeOnly: false });
    expect(service.lastFilter).toEqual({ activeOnly: false });
  });

  it('returns an empty array when the catalog is empty', async () => {
    const { controller } = buildController();
    const result = await controller.list({ activeOnly: true });
    expect(result).toEqual({ accounts: [] });
  });

  it('does not include `type` / `parentId` keys when the query did not provide them', async () => {
    const { controller, service } = buildController();
    await controller.list({ activeOnly: true });
    expect(service.lastFilter).not.toHaveProperty('type');
    expect(service.lastFilter).not.toHaveProperty('parentId');
  });
});
