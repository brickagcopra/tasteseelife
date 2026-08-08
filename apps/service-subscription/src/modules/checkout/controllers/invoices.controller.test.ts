import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { InvoicesListResponse } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { err, ok } from '../../subscriptions/result';
import type { InvoicesService } from '../services/invoices.service';

import { InvoicesController } from './invoices.controller';

interface FakeService {
  list: ReturnType<typeof vi.fn>;
}

function buildController(): { controller: InvoicesController; svc: FakeService } {
  const svc: FakeService = { list: vi.fn() };
  const controller = new InvoicesController(svc as unknown as InvoicesService);
  return { controller, svc };
}

/**
 * A request from a family member acting in `householdId` — the shape the
 * gateway's `HouseholdScopeInterceptor` produces. `null` userId means no
 * context at all; a `null` householdId means an authenticated actor whose
 * scope stayed `global` (staff, provider, academy learner, or a
 * multi-household member who did not name one).
 */
function buildRequest(
  userId: string | null,
  householdId: string | null = 'hh_123',
): RequestWithContext {
  if (userId === null) return { headers: {} } as unknown as RequestWithContext;
  return {
    headers: {},
    requestContext: {
      userId,
      mfaVerified: false,
      roles: [],
      tenantScope: householdId === null ? { type: 'global' } : { type: 'household', householdId },
    },
  } as unknown as RequestWithContext;
}

const sampleList: InvoicesListResponse = {
  invoices: [
    {
      id: 'in_a',
      subscriptionId: 'sub_local_xyz',
      stripeSubscriptionId: 'sub_stripe_xyz',
      stripeCustomerId: 'cus_test',
      status: 'paid',
      number: 'TASTESEE-0001',
      description: null,
      currency: 'USD',
      amountDueUsdMinor: 29900,
      amountPaidUsdMinor: 29900,
      amountRemainingUsdMinor: 0,
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/in_a',
      invoicePdf: null,
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z',
      paidAt: '2026-05-01T00:00:01.000Z',
      dueAt: null,
    },
  ],
  hasMore: false,
  nextStartingAfter: null,
};

describe('InvoicesController.list', () => {
  it('returns the invoice list on success', async () => {
    const { controller, svc } = buildController();
    svc.list.mockResolvedValue(ok(sampleList));

    const result = await controller.list(
      { subscriptionId: 'sub_local_xyz', limit: 12 },
      buildRequest('usr_payer'),
    );
    expect(result).toEqual(sampleList);
    const callArgs = svc.list.mock.calls[0]?.[0];
    expect(callArgs?.subscriptionId).toBe('sub_local_xyz');
    expect(callArgs?.requesterUserId).toBe('usr_payer');
    expect(callArgs?.limit).toBe(12);
  });

  it('passes the household from the token scope, not the query (TS-124-followup-scoping)', async () => {
    const { controller, svc } = buildController();
    svc.list.mockResolvedValue(ok(sampleList));

    await controller.list(
      // A query object carrying a household id the contract does not
      // declare — the shape a caller would try if the id were accepted
      // from the wire. It must not reach the service.
      { subscriptionId: 'sub_local_xyz', limit: 12, householdId: 'hh_someone_else' } as never,
      buildRequest('usr_payer', 'hh_mine'),
    );

    const callArgs = svc.list.mock.calls[0]?.[0];
    expect(callArgs?.householdId).toBe('hh_mine');
  });

  it('rejects an actor with no household scope with 400, before any lookup', async () => {
    const { controller, svc } = buildController();

    await expect(
      controller.list(
        { subscriptionId: 'sub_local_xyz', limit: 12 },
        buildRequest('usr_staff', null),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Decided from the caller's own token — nothing about any
    // subscription was consulted, so the refusal discloses nothing.
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('forwards startingAfter to the service when provided', async () => {
    const { controller, svc } = buildController();
    svc.list.mockResolvedValue(ok({ ...sampleList, invoices: [], hasMore: false }));

    await controller.list(
      { subscriptionId: 'sub_local_xyz', limit: 5, startingAfter: 'in_cursor' },
      buildRequest('usr_payer'),
    );
    const callArgs = svc.list.mock.calls[0]?.[0];
    expect(callArgs?.startingAfter).toBe('in_cursor');
  });

  it('throws Unauthorized when context is missing', async () => {
    const { controller, svc } = buildController();
    await expect(
      controller.list({ subscriptionId: 'sub_x', limit: 12 }, buildRequest(null)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('maps subscription_not_found to 404', async () => {
    const { controller, svc } = buildController();
    svc.list.mockResolvedValue(err({ reason: 'subscription_not_found', subscriptionId: 'sub_x' }));
    await expect(
      controller.list({ subscriptionId: 'sub_x', limit: 12 }, buildRequest('usr')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps stripe_unavailable to 500', async () => {
    const { controller, svc } = buildController();
    svc.list.mockResolvedValue(err({ reason: 'stripe_unavailable', cause: new Error('x') }));
    await expect(
      controller.list({ subscriptionId: 'sub_x', limit: 12 }, buildRequest('usr')),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
