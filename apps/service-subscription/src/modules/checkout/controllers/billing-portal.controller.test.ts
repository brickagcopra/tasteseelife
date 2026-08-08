import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreateBillingPortalSessionRequestSchema } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '../../subscriptions/result';
import type { BillingPortalService } from '../services/billing-portal.service';

import { BillingPortalController } from './billing-portal.controller';

interface FakeService {
  createSession: ReturnType<typeof vi.fn>;
}

function buildController(): { controller: BillingPortalController; svc: FakeService } {
  const svc: FakeService = { createSession: vi.fn() };
  const controller = new BillingPortalController(svc as unknown as BillingPortalService);
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

const SESSION = { url: 'https://billing.stripe.com/p/session/live_abc' };

describe('BillingPortalController.create', () => {
  it('returns the portal URL for the caller’s own household', async () => {
    const { controller, svc } = buildController();
    svc.createSession.mockResolvedValue(ok(SESSION));

    const result = await controller.create({}, buildRequest('usr_payer', 'hh_mine'));

    expect(result).toEqual(SESSION);
    expect(svc.createSession).toHaveBeenCalledWith({
      householdId: 'hh_mine',
      requesterUserId: 'usr_payer',
    });
  });

  it('takes the household from the token scope, never from anything sent', async () => {
    const { controller, svc } = buildController();
    svc.createSession.mockResolvedValue(ok(SESSION));

    await controller.create(
      { householdId: 'hh_someone_else' } as never,
      buildRequest('usr_payer', 'hh_mine'),
    );

    const args = svc.createSession.mock.calls[0]?.[0];
    expect(args?.householdId).toBe('hh_mine');
  });

  it('rejects a caller with no household scope before touching the service', async () => {
    const { controller, svc } = buildController();

    await expect(controller.create({}, buildRequest('usr_provider', null))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(svc.createSession).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when there is no request context', async () => {
    const { controller, svc } = buildController();
    await expect(controller.create({}, buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.createSession).not.toHaveBeenCalled();
  });

  it('maps no_subscription to 404 without echoing an id', async () => {
    const { controller, svc } = buildController();
    svc.createSession.mockResolvedValue(err({ reason: 'no_subscription' }));

    await expect(controller.create({}, buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps no_stripe_customer to 422, not 404', async () => {
    const { controller, svc } = buildController();
    svc.createSession.mockResolvedValue(
      err({ reason: 'no_stripe_customer', subscriptionId: 'sub_local_xyz' }),
    );

    const thrown = await controller.create({}, buildRequest('usr')).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(UnprocessableEntityException);
    // The internal subscription id is not part of the customer-facing
    // explanation of a data defect.
    expect(JSON.stringify((thrown as UnprocessableEntityException).getResponse())).not.toContain(
      'sub_local_xyz',
    );
  });

  it('maps stripe_unavailable to 500', async () => {
    const { controller, svc } = buildController();
    svc.createSession.mockResolvedValue(
      err({ reason: 'stripe_unavailable', cause: new Error('x') }),
    );

    await expect(controller.create({}, buildRequest('usr'))).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('the request body contract this controller validates', () => {
  it('rejects a body naming a customer — the field is not silently dropped', () => {
    // The controller's `@UsePipes(ZodValidationPipe)` runs this schema,
    // so the strictness asserted here is what stops a caller minting a
    // portal session for somebody else's Stripe customer.
    expect(CreateBillingPortalSessionRequestSchema.safeParse({ customerId: 'cus_x' }).success).toBe(
      false,
    );
    expect(CreateBillingPortalSessionRequestSchema.safeParse({}).success).toBe(true);
  });
});
