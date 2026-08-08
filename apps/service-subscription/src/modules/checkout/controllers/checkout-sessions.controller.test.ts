import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateCheckoutSessionResponse,
  GetCheckoutSessionResponse,
  SubscriptionResponse,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { err, ok, type Result } from '../../subscriptions/result';
import type {
  CheckoutSessionsFailure,
  CheckoutSessionsService,
} from '../services/checkout-sessions.service';

import { CheckoutSessionsController } from './checkout-sessions.controller';

interface FakeService {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
}

function buildController(): { controller: CheckoutSessionsController; svc: FakeService } {
  const svc: FakeService = {
    create: vi.fn(),
    get: vi.fn(),
    finalize: vi.fn(),
  };
  const controller = new CheckoutSessionsController(svc as unknown as CheckoutSessionsService);
  return { controller, svc };
}

function buildRequest(userId: string | null): RequestWithContext {
  if (userId === null) return { headers: {} } as unknown as RequestWithContext;
  return {
    headers: {},
    requestContext: {
      userId,
      mfaVerified: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
  } as unknown as RequestWithContext;
}

const validBody = {
  planId: 'plan_companion',
  customerId: 'hh_123',
  customerGroup: 'family' as const,
  customerEmail: 'parent@example.com',
  billingInterval: 'monthly' as const,
  successUrl: 'https://app.tasteandsee.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.tasteandsee.com/plans',
};

const sampleCreateResponse: CreateCheckoutSessionResponse = {
  id: 'cs_test_abc',
  url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
  expiresAt: '2026-05-18T00:00:00.000Z',
  status: 'open',
};

const sampleGetResponse: GetCheckoutSessionResponse = {
  id: 'cs_test_abc',
  url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
  expiresAt: '2026-05-18T00:00:00.000Z',
  status: 'complete',
  stripeSubscriptionId: 'sub_stripe_xyz',
  subscriptionId: 'sub_local_xyz',
  customerEmail: 'parent@example.com',
};

const sampleSubscription: SubscriptionResponse = {
  id: 'sub_local_xyz',
  stripeSubscriptionId: 'sub_stripe_xyz',
  stripeCustomerId: 'cus_xyz',
  customerId: 'hh_123',
  customerGroup: 'family',
  planId: 'plan_companion',
  planCode: 'family.tier2',
  status: 'active',
  billingInterval: 'monthly',
  unitPriceUsdMinor: 19900,
  currency: 'USD',
  currentPeriodStart: '2026-05-17T00:00:00.000Z',
  currentPeriodEnd: '2026-06-17T00:00:00.000Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  cancelReason: null,
  canceledAt: null,
  dunningAttempts: 0,
  dunningLastAttemptAt: null,
  dunningGraceUntil: null,
  pauseCollectionStartedAt: null,
  pauseCollectionResumesAt: null,
  pauseReason: null,
  createdAt: '2026-05-17T00:00:00.000Z',
  updatedAt: '2026-05-17T00:00:00.000Z',
};

describe('CheckoutSessionsController.create', () => {
  it('returns the session response on success and forwards the requester userId', async () => {
    const { controller, svc } = buildController();
    svc.create.mockResolvedValue(
      ok(sampleCreateResponse) satisfies Result<
        CreateCheckoutSessionResponse,
        CheckoutSessionsFailure
      >,
    );

    const result = await controller.create(validBody, buildRequest('usr_payer'));
    expect(result).toEqual(sampleCreateResponse);
    const callArgs = svc.create.mock.calls[0]?.[0];
    expect(callArgs?.requesterUserId).toBe('usr_payer');
    expect(callArgs?.request).toEqual(validBody);
  });

  it('forwards a valid Idempotency-Key header', async () => {
    const { controller, svc } = buildController();
    svc.create.mockResolvedValue(ok(sampleCreateResponse));

    await controller.create(validBody, buildRequest('usr_payer'), 'idem-1234-5678');
    const callArgs = svc.create.mock.calls[0]?.[0];
    expect(callArgs?.idempotencyKey).toBe('idem-1234-5678');
  });

  it('ignores a malformed (too-short) Idempotency-Key', async () => {
    const { controller, svc } = buildController();
    svc.create.mockResolvedValue(ok(sampleCreateResponse));

    await controller.create(validBody, buildRequest('usr_payer'), 'short');
    const callArgs = svc.create.mock.calls[0]?.[0];
    expect(callArgs?.idempotencyKey).toBeUndefined();
  });

  it('throws Unauthorized when the request lacks a context', async () => {
    const { controller, svc } = buildController();
    await expect(controller.create(validBody, buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('maps plan_not_found to 404', async () => {
    const { controller, svc } = buildController();
    svc.create.mockResolvedValue(err({ reason: 'plan_not_found', planId: 'plan_missing' }));

    await expect(controller.create(validBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps plan_group_mismatch to 400', async () => {
    const { controller, svc } = buildController();
    svc.create.mockResolvedValue(
      err({
        reason: 'plan_group_mismatch',
        planId: 'plan_companion',
        expected: 'family',
        actual: 'provider',
      }),
    );
    await expect(controller.create(validBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('maps coupon_invalid to 400 with a failure-reason body', async () => {
    const { controller, svc } = buildController();
    svc.create.mockResolvedValue(
      err({ reason: 'coupon_invalid', couponCode: 'WELCOME10', failureReason: 'coupon_expired' }),
    );
    try {
      await controller.create(validBody, buildRequest('usr'));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as { failureReason?: string };
      expect(body.failureReason).toBe('coupon_expired');
    }
  });

  it('maps stripe_unavailable to 500 with a generic body', async () => {
    const { controller, svc } = buildController();
    svc.create.mockResolvedValue(err({ reason: 'stripe_unavailable', cause: new Error('x') }));
    await expect(controller.create(validBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('CheckoutSessionsController.get', () => {
  it('returns the session response on success', async () => {
    const { controller, svc } = buildController();
    svc.get.mockResolvedValue(ok(sampleGetResponse));

    const result = await controller.get('cs_test_abc', buildRequest('usr_payer'));
    expect(result).toEqual(sampleGetResponse);
    const callArgs = svc.get.mock.calls[0]?.[0];
    expect(callArgs?.sessionId).toBe('cs_test_abc');
    expect(callArgs?.requesterUserId).toBe('usr_payer');
  });

  it('throws Unauthorized when context is missing', async () => {
    const { controller, svc } = buildController();
    await expect(controller.get('cs_x', buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.get).not.toHaveBeenCalled();
  });

  it('maps session_not_found to 404', async () => {
    const { controller, svc } = buildController();
    svc.get.mockResolvedValue(err({ reason: 'session_not_found', sessionId: 'cs_x' }));
    await expect(controller.get('cs_x', buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CheckoutSessionsController.finalize', () => {
  it('returns the SubscriptionResponse on success', async () => {
    const { controller, svc } = buildController();
    svc.finalize.mockResolvedValue(ok(sampleSubscription));

    const result = await controller.finalize('cs_test_abc', {}, buildRequest('usr_payer'));
    expect(result).toEqual(sampleSubscription);
  });

  it('maps session_not_complete to 422', async () => {
    const { controller, svc } = buildController();
    svc.finalize.mockResolvedValue(
      err({ reason: 'session_not_complete', sessionId: 'cs_x', status: 'unpaid' }),
    );
    await expect(controller.finalize('cs_x', {}, buildRequest('usr'))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps session_metadata_invalid to 422 with the missing-key field', async () => {
    const { controller, svc } = buildController();
    svc.finalize.mockResolvedValue(
      err({
        reason: 'session_metadata_invalid',
        sessionId: 'cs_x',
        missingKey: 'platform_plan_id',
      }),
    );
    try {
      await controller.finalize('cs_x', {}, buildRequest('usr'));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      const body = (e as UnprocessableEntityException).getResponse() as { detail?: string };
      expect(body.detail).toMatch(/platform_plan_id/);
    }
  });

  it('maps outbox_validation_failed to 500', async () => {
    const { controller, svc } = buildController();
    svc.finalize.mockResolvedValue(
      err({
        reason: 'outbox_validation_failed',
        eventName: 'subscription.activated',
        message: 'forced',
      }),
    );
    await expect(controller.finalize('cs_x', {}, buildRequest('usr'))).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
