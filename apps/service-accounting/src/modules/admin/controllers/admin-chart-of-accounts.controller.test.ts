import {
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { AdminChartOfAccountsController } from './admin-chart-of-accounts.controller';
import type {
  AdminAccountRow,
  AdminAccountSetActiveResult,
  AdminChartOfAccountsService,
} from '../services/admin-chart-of-accounts.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');

const sampleAccount: AdminAccountRow = {
  id: 'coa_cash',
  code: '1000',
  name: 'Cash',
  description: 'Operating bank + Stripe balance.',
  type: 'asset',
  parentId: null,
  normalBalance: 'debit',
  currency: 'USD',
  active: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function buildController(opts: { setActive?: () => Promise<AdminAccountSetActiveResult> }): {
  controller: AdminChartOfAccountsController;
  service: { setActive: ReturnType<typeof vi.fn> };
} {
  const service = {
    setActive: vi.fn(
      opts.setActive ??
        (async () => ({
          ok: true as const,
          value: {
            accountId: sampleAccount.id,
            before: { active: true },
            after: { active: false },
            account: sampleAccount,
            performedAt: NOW,
          },
        })),
    ),
  };
  const controller = new AdminChartOfAccountsController(
    service as unknown as AdminChartOfAccountsService,
  );
  return { controller, service };
}

function buildRequest(userId = 'usr_admin'): RequestWithContext {
  return {
    requestContext: {
      userId,
      sessionId: 'sess_x',
      roles: [],
      tenantScope: null,
    },
    headers: {},
  } as unknown as RequestWithContext;
}

describe('AdminChartOfAccountsController.setActive', () => {
  it('returns 404 when the id is empty', async () => {
    const { controller } = buildController({});
    await expect(
      controller.setActive('', { active: false, reason: 'chart_cleanup' }, buildRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the id is too long', async () => {
    const { controller } = buildController({});
    await expect(
      controller.setActive(
        'a'.repeat(80),
        { active: false, reason: 'chart_cleanup' },
        buildRequest(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 401 when the request has no context', async () => {
    const { controller } = buildController({});
    await expect(
      controller.setActive('coa_cash', { active: false, reason: 'chart_cleanup' }, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 404 when the service signals account_not_found', async () => {
    const { controller } = buildController({
      setActive: async () => ({
        ok: false as const,
        failure: { kind: 'account_not_found' as const },
      }),
    });
    await expect(
      controller.setActive(
        'coa_missing',
        { active: false, reason: 'chart_cleanup' },
        buildRequest(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 500 when the service signals unsupported_currency', async () => {
    const { controller } = buildController({
      setActive: async () => ({
        ok: false as const,
        failure: { kind: 'unsupported_currency' as const, currency: 'EUR' },
      }),
    });
    await expect(
      controller.setActive('coa_eur', { active: false, reason: 'chart_cleanup' }, buildRequest()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('returns the full action response on success (retire)', async () => {
    const { controller, service } = buildController({});
    const response = await controller.setActive(
      'coa_cash',
      { active: false, reason: 'chart_cleanup', note: 'Replaced by 1000.cash.stripe.' },
      buildRequest('usr_admin_42'),
    );

    expect(response.account.id).toBe('coa_cash');
    expect(response.account.active).toBe(false);
    expect(response.before).toEqual({ active: true });
    expect(response.after).toEqual({ active: false });
    expect(response.reason).toBe('chart_cleanup');
    expect(response.note).toBe('Replaced by 1000.cash.stripe.');
    expect(response.performedAt).toBe(NOW.toISOString());
    expect(response.performedByUserId).toBe('usr_admin_42');

    expect(service.setActive).toHaveBeenCalledWith({
      accountId: 'coa_cash',
      active: false,
      reason: 'chart_cleanup',
      note: 'Replaced by 1000.cash.stripe.',
      actorUserId: 'usr_admin_42',
    });
  });

  it('passes null through for the note field when none is supplied', async () => {
    const { controller, service } = buildController({});
    const response = await controller.setActive(
      'coa_cash',
      { active: true, reason: 'restore' },
      buildRequest(),
    );

    expect(response.note).toBeNull();
    expect(service.setActive).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  it('parse-validates the response shape before returning', async () => {
    // The mapper builds the response from a trusted service row, but
    // we still want a regression guard against drift.
    const { controller } = buildController({});
    const response = await controller.setActive(
      'coa_cash',
      { active: false, reason: 'chart_cleanup' },
      buildRequest(),
    );

    expect(response.account.createdAt).toBe(NOW.toISOString());
    expect(response.account.updatedAt).toBe(NOW.toISOString());
  });

  it('echoes the supplied reason verbatim in the response', async () => {
    const { controller } = buildController({});
    const reasons = ['superseded', 'chart_cleanup', 'restore', 'other'] as const;
    for (const reason of reasons) {
      const response = await controller.setActive(
        'coa_cash',
        { active: false, reason },
        buildRequest(),
      );
      expect(response.reason).toBe(reason);
    }
  });
});
