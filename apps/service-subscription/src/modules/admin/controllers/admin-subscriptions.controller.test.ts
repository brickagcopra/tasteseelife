import 'reflect-metadata';

import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSubscriptionsListQuery } from '@taste-and-see/contracts';

import type {
  AdminSubscriptionDetailRow,
  AdminSubscriptionListPage,
  AdminSubscriptionsService,
} from '../services/admin-subscriptions.service';

import { AdminSubscriptionsController } from './admin-subscriptions.controller';

const NOW = new Date('2026-05-17T12:00:00.000Z');

function buildService(
  overrides: Partial<{
    list: AdminSubscriptionsService['list'];
    getById: AdminSubscriptionsService['getById'];
  }> = {},
): AdminSubscriptionsService {
  return {
    list:
      overrides.list ??
      (vi.fn(async () => emptyPage()) as unknown as AdminSubscriptionsService['list']),
    getById:
      overrides.getById ??
      (vi.fn(async () => null) as unknown as AdminSubscriptionsService['getById']),
  } as unknown as AdminSubscriptionsService;
}

function emptyPage(): AdminSubscriptionListPage {
  return { subscriptions: [], nextCursor: null };
}

function detailRow(
  overrides: Partial<AdminSubscriptionDetailRow> = {},
): AdminSubscriptionDetailRow {
  return {
    id: 'sub_1',
    stripeSubscriptionId: 'sub_stripe_1',
    stripeCustomerId: 'cus_1',
    customerId: 'hh_1',
    customerGroup: 'family',
    status: 'active',
    billingInterval: 'monthly',
    unitPriceMinor: 29900,
    currency: 'USD',
    currentPeriodStart: NOW,
    currentPeriodEnd: NOW,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    cancelReason: null,
    canceledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    plan: {
      id: 'plan_tier2',
      code: 'family.tier2',
      name: 'Companion Dining',
      customerGroup: 'family',
      monthlyPriceMinor: 29900,
      annualPriceMinor: 299000,
      currency: 'USD',
      active: true,
    },
    defaultPaymentMethod: null,
    dunning: {
      attempts: 0,
      lastAttemptAt: null,
      graceUntil: null,
      inGracePeriod: false,
    },
    pause: {
      isPaused: false,
      pauseCollectionStartedAt: null,
      pauseCollectionResumesAt: null,
      pauseReason: null,
    },
    history: [],
    ...overrides,
  };
}

describe('AdminSubscriptionsController.list', () => {
  it('returns an empty page when the service has no subscriptions', async () => {
    const svc = buildService();
    const ctrl = new AdminSubscriptionsController(svc);

    const response = await ctrl.list({ limit: 25 } as AdminSubscriptionsListQuery);
    expect(response.subscriptions).toEqual([]);
    expect(response.nextCursor).toBeNull();
  });

  it('maps the service row shape to the DTO shape (ISO date serialisation)', async () => {
    const svc = buildService({
      list: vi.fn(async () => ({
        subscriptions: [
          {
            id: 'sub_1',
            stripeSubscriptionId: 'sub_stripe_1',
            stripeCustomerId: 'cus_1',
            customerId: 'hh_1',
            customerGroup: 'family' as const,
            planId: 'plan_tier2',
            planCode: 'family.tier2',
            planName: 'Companion Dining',
            status: 'active' as const,
            billingInterval: 'monthly' as const,
            unitPriceMinor: 29900,
            currency: 'USD',
            currentPeriodStart: NOW,
            currentPeriodEnd: NOW,
            trialEnd: null,
            cancelAtPeriodEnd: false,
            cancelReason: null,
            canceledAt: null,
            inDunningGrace: false,
            isPaused: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextCursor: 'opaque_cursor',
      })) as unknown as AdminSubscriptionsService['list'],
    });
    const ctrl = new AdminSubscriptionsController(svc);

    const response = await ctrl.list({ limit: 25 } as AdminSubscriptionsListQuery);
    expect(response.subscriptions[0]!.id).toBe('sub_1');
    expect(response.subscriptions[0]!.currentPeriodStart).toBe(NOW.toISOString());
    expect(response.subscriptions[0]!.createdAt).toBe(NOW.toISOString());
    expect(response.nextCursor).toBe('opaque_cursor');
  });

  it('forwards every optional filter to the service', async () => {
    const listSpy = vi.fn(async () => emptyPage());
    const svc = buildService({
      list: listSpy as unknown as AdminSubscriptionsService['list'],
    });
    const ctrl = new AdminSubscriptionsController(svc);

    await ctrl.list({
      customerGroup: 'provider',
      status: 'past_due',
      planId: 'plan_a',
      customerId: 'hh_a',
      cursor: 'cur_abc',
      limit: 50,
    });

    expect(listSpy).toHaveBeenCalledTimes(1);
    const firstCall = listSpy.mock.calls[0] as unknown as readonly [
      {
        customerGroup?: string;
        status?: string;
        planId?: string;
        customerId?: string;
        cursor?: string;
        limit: number;
      },
    ];
    expect(firstCall[0].customerGroup).toBe('provider');
    expect(firstCall[0].status).toBe('past_due');
    expect(firstCall[0].planId).toBe('plan_a');
    expect(firstCall[0].customerId).toBe('hh_a');
    expect(firstCall[0].cursor).toBe('cur_abc');
    expect(firstCall[0].limit).toBe(50);
  });

  it('omits undefined fields from the service input (strict exactOptionalPropertyTypes)', async () => {
    const listSpy = vi.fn(async () => emptyPage());
    const svc = buildService({
      list: listSpy as unknown as AdminSubscriptionsService['list'],
    });
    const ctrl = new AdminSubscriptionsController(svc);

    await ctrl.list({ limit: 25 } as AdminSubscriptionsListQuery);
    const firstCall = listSpy.mock.calls[0] as unknown as readonly [Record<string, unknown>];
    expect('customerGroup' in firstCall[0]).toBe(false);
    expect('status' in firstCall[0]).toBe(false);
    expect('cursor' in firstCall[0]).toBe(false);
  });
});

describe('AdminSubscriptionsController.getById', () => {
  it('returns the detail DTO for an existing subscription', async () => {
    const svc = buildService({
      getById: vi.fn(async () => detailRow()) as unknown as AdminSubscriptionsService['getById'],
    });
    const ctrl = new AdminSubscriptionsController(svc);

    const response = await ctrl.getById('sub_1');
    expect(response.subscription.id).toBe('sub_1');
    expect(response.subscription.plan.code).toBe('family.tier2');
    expect(response.subscription.history).toEqual([]);
  });

  it('throws 404 when the service returns null', async () => {
    const svc = buildService();
    const ctrl = new AdminSubscriptionsController(svc);
    await expect(ctrl.getById('sub_missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 when the id is empty', async () => {
    const svc = buildService();
    const ctrl = new AdminSubscriptionsController(svc);
    await expect(ctrl.getById('')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 when the id exceeds the contract max length', async () => {
    const svc = buildService();
    const ctrl = new AdminSubscriptionsController(svc);
    const overlong = 'a'.repeat(65);
    await expect(ctrl.getById(overlong)).rejects.toBeInstanceOf(NotFoundException);
  });
});
