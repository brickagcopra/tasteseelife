import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { MySubscriptionSummary } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import type { MySubscriptionService } from '../services/my-subscription.service';

import { MySubscriptionController } from './my-subscription.controller';

interface FakeService {
  read: ReturnType<typeof vi.fn>;
}

function buildController(): { controller: MySubscriptionController; svc: FakeService } {
  const svc: FakeService = { read: vi.fn() };
  const controller = new MySubscriptionController(svc as unknown as MySubscriptionService);
  return { controller, svc };
}

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

const SUMMARY: MySubscriptionSummary = {
  planCode: 'tier-2-companion',
  planName: 'Companion Dining',
  status: 'active',
  billingInterval: 'monthly',
  unitPriceUsdMinor: 29900,
  currency: 'USD',
  currentPeriodEnd: '2026-09-01T00:00:00.000Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  paymentTrouble: false,
  paymentDueBy: null,
  pauseResumesAt: null,
};

describe('MySubscriptionController.read', () => {
  it('returns the caller’s own membership', async () => {
    const { controller, svc } = buildController();
    svc.read.mockResolvedValue(SUMMARY);

    const result = await controller.read(buildRequest('usr_payer', 'hh_mine'));

    expect(result).toEqual({ subscription: SUMMARY });
    expect(svc.read).toHaveBeenCalledWith({
      householdId: 'hh_mine',
      requesterUserId: 'usr_payer',
    });
  });

  it('answers 200 with a null subscription, not a 404', async () => {
    const { controller, svc } = buildController();
    svc.read.mockResolvedValue(null);

    // "You have no plan" is a true answer to "what is my plan"; a 404
    // would make the portal render a legitimate state as a failure.
    await expect(controller.read(buildRequest('usr'))).resolves.toEqual({
      subscription: null,
    });
  });

  it('rejects an actor with no household scope, before any read', async () => {
    const { controller, svc } = buildController();

    await expect(controller.read(buildRequest('usr_provider', null))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(svc.read).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when there is no request context', async () => {
    const { controller, svc } = buildController();
    await expect(controller.read(buildRequest(null))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(svc.read).not.toHaveBeenCalled();
  });

  it('500s rather than leaking a widened projection', async () => {
    const { controller, svc } = buildController();
    // What a careless `select:` widening would produce. The boundary
    // re-parse is the disclosure control, so it must reject rather than
    // pass the extra field through.
    svc.read.mockResolvedValue({ ...SUMMARY, stripeCustomerId: 'cus_leak' });

    await expect(controller.read(buildRequest('usr'))).rejects.toThrow();
  });
});
