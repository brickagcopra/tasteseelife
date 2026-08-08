import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { SubscriptionResponse } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { err, ok, type Result } from '../result';
import type { DunningFailure, DunningService } from '../services/dunning.service';
import type { SubscriptionsFailure, SubscriptionsService } from '../services/subscriptions.service';

import { SubscriptionsController } from './subscriptions.controller';

interface FakeSubscriptionsService {
  create: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

interface FakeDunningService {
  pauseSubscription: ReturnType<typeof vi.fn>;
  resumeSubscription: ReturnType<typeof vi.fn>;
  recordPaymentFailure: ReturnType<typeof vi.fn>;
  recordPaymentSuccess: ReturnType<typeof vi.fn>;
  applyDunningExhaustion: ReturnType<typeof vi.fn>;
}

function buildSvc(): {
  controller: SubscriptionsController;
  svc: FakeSubscriptionsService;
  dunning: FakeDunningService;
} {
  const svc: FakeSubscriptionsService = {
    create: vi.fn(),
    patch: vi.fn(),
    cancel: vi.fn(),
  };
  const dunning: FakeDunningService = {
    pauseSubscription: vi.fn(),
    resumeSubscription: vi.fn(),
    recordPaymentFailure: vi.fn(),
    recordPaymentSuccess: vi.fn(),
    applyDunningExhaustion: vi.fn(),
  };
  const controller = new SubscriptionsController(
    svc as unknown as SubscriptionsService,
    dunning as unknown as DunningService,
  );
  return { controller, svc, dunning };
}

function buildRequest(userId: string | null): RequestWithContext {
  if (userId === null) {
    return { headers: {} } as unknown as RequestWithContext;
  }
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
  billingInterval: 'monthly' as const,
  paymentMethodId: 'pm_card',
  customerEmail: 'parent@example.com',
};

const sampleResponse: SubscriptionResponse = {
  id: 'sub_internal_001',
  stripeSubscriptionId: 'sub_xyz',
  stripeCustomerId: 'cus_xyz',
  customerId: 'hh_123',
  customerGroup: 'family',
  planId: 'plan_companion',
  planCode: 'family.tier2',
  status: 'active',
  billingInterval: 'monthly',
  unitPriceUsdMinor: 19900,
  currency: 'USD',
  currentPeriodStart: '2026-05-10T00:00:00.000Z',
  currentPeriodEnd: '2026-06-10T00:00:00.000Z',
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
  createdAt: '2026-05-10T00:00:00.000Z',
  updatedAt: '2026-05-10T00:00:00.000Z',
};

function okValue<T>(value: T): Result<T, SubscriptionsFailure> {
  return ok(value);
}

function failure(error: SubscriptionsFailure): Result<SubscriptionResponse, SubscriptionsFailure> {
  return err(error);
}

describe('SubscriptionsController.create', () => {
  it('returns the SubscriptionResponse on success', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(okValue(sampleResponse));

    const result = await controller.create(validBody, buildRequest('usr_payer'));

    expect(result).toEqual(sampleResponse);
    expect(svc.create).toHaveBeenCalledWith({
      request: validBody,
      requesterUserId: 'usr_payer',
    });
  });

  it('throws Unauthorized when no requestContext is present', async () => {
    const { controller, svc } = buildSvc();
    await expect(controller.create(validBody, buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('forwards the Idempotency-Key header to the service when provided', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(okValue(sampleResponse));

    await controller.create(validBody, buildRequest('usr'), 'idem-key-12345-abc');

    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-key-12345-abc' }),
    );
  });

  it('ignores an idempotency key shorter than the contract floor (does not pass to service)', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(okValue(sampleResponse));

    await controller.create(validBody, buildRequest('usr'), 'tiny');

    const callArgs = svc.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('idempotencyKey');
  });

  it('translates plan_not_found into a 404 NotFoundException', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(failure({ reason: 'plan_not_found', planId: 'plan_x' }));

    await expect(controller.create(validBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('translates plan_inactive into a 404 NotFoundException', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(failure({ reason: 'plan_inactive', planId: 'plan_x' }));

    await expect(controller.create(validBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('translates plan_group_mismatch into a 400 BadRequestException', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(
      failure({
        reason: 'plan_group_mismatch',
        planId: 'plan_x',
        expected: 'family',
        actual: 'provider',
      }),
    );

    await expect(controller.create(validBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('translates invalid_request into a 400 BadRequestException', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(failure({ reason: 'invalid_request', message: 'no email' }));

    await expect(controller.create(validBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('translates stripe_unavailable into a 500 InternalServerErrorException with a generic body', async () => {
    const { controller, svc } = buildSvc();
    svc.create.mockResolvedValue(
      failure({ reason: 'stripe_unavailable', cause: new Error('rate limited') }),
    );

    try {
      await controller.create(validBody, buildRequest('usr'));
      throw new Error('expected create to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerErrorException);
      const body = (e as InternalServerErrorException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toBe('upstream payment provider unavailable');
      // No Stripe-specific identifiers leaked to the client body.
      expect(JSON.stringify(body)).not.toContain('rate limited');
    }
  });
});

describe('SubscriptionsController.patch', () => {
  const patchBody = { paymentMethodId: 'pm_new' as const };

  it('returns updated SubscriptionResponse on success', async () => {
    const { controller, svc } = buildSvc();
    svc.patch.mockResolvedValue(okValue(sampleResponse));

    const result = await controller.patch('sub_internal_001', patchBody, buildRequest('usr'));

    expect(result).toEqual(sampleResponse);
    expect(svc.patch).toHaveBeenCalledWith({
      subscriptionId: 'sub_internal_001',
      request: patchBody,
      requesterUserId: 'usr',
    });
  });

  it('translates subscription_not_found into a 404', async () => {
    const { controller, svc } = buildSvc();
    svc.patch.mockResolvedValue(
      failure({ reason: 'subscription_not_found', subscriptionId: 'sub_x' }),
    );
    await expect(controller.patch('sub_x', patchBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('translates plan_group_mismatch into a 400', async () => {
    const { controller, svc } = buildSvc();
    svc.patch.mockResolvedValue(
      failure({
        reason: 'plan_group_mismatch',
        planId: 'plan_x',
        expected: 'family',
        actual: 'provider',
      }),
    );
    await expect(controller.patch('sub_x', patchBody, buildRequest('usr'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws Unauthorized when no requestContext is present', async () => {
    const { controller, svc } = buildSvc();
    await expect(controller.patch('sub_x', patchBody, buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.patch).not.toHaveBeenCalled();
  });
});

describe('SubscriptionsController.cancel', () => {
  const cancelBody = {
    cancelAtPeriodEnd: true,
    reason: 'customer_request' as const,
  };

  it('returns the canceled SubscriptionResponse on success', async () => {
    const { controller, svc } = buildSvc();
    svc.cancel.mockResolvedValue(
      okValue({
        ...sampleResponse,
        status: 'canceled',
        cancelAtPeriodEnd: true,
        cancelReason: 'customer_request',
        canceledAt: '2026-05-10T00:00:00.000Z',
      }),
    );

    const result = await controller.cancel('sub_internal_001', cancelBody, buildRequest('usr'));
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(svc.cancel).toHaveBeenCalledWith({
      subscriptionId: 'sub_internal_001',
      request: cancelBody,
      requesterUserId: 'usr',
    });
  });

  it('translates subscription_already_canceled into a 409 Conflict', async () => {
    const { controller, svc } = buildSvc();
    svc.cancel.mockResolvedValue(
      failure({ reason: 'subscription_already_canceled', subscriptionId: 'sub_x' }),
    );
    await expect(
      controller.cancel('sub_x', cancelBody, buildRequest('usr')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('translates subscription_not_found into a 404', async () => {
    const { controller, svc } = buildSvc();
    svc.cancel.mockResolvedValue(
      failure({ reason: 'subscription_not_found', subscriptionId: 'sub_x' }),
    );
    await expect(
      controller.cancel('sub_x', cancelBody, buildRequest('usr')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws Unauthorized when no requestContext is present', async () => {
    const { controller, svc } = buildSvc();
    await expect(controller.cancel('sub_x', cancelBody, buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.cancel).not.toHaveBeenCalled();
  });

  it('forwards the Idempotency-Key header to cancel with a stripe_unavailable failure mapped to 500', async () => {
    const { controller, svc } = buildSvc();
    svc.cancel.mockResolvedValue(
      failure({ reason: 'stripe_unavailable', cause: new Error('boom') }),
    );

    try {
      await controller.cancel('sub_x', cancelBody, buildRequest('usr'), 'idem-cancel-12345');
      throw new Error('expected cancel to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerErrorException);
    }

    expect(svc.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-cancel-12345' }),
    );
  });
});

describe('SubscriptionsController auth wiring', () => {
  it('is decorated with AccessTokenGuard at the class level', () => {
    // The Reflect-metadata lookup verifies the @UseGuards decorator
    // landed on the controller class (rather than per-method) — every
    // endpoint inherits the guard without per-method risk of forgetting.
    const guards = Reflect.getMetadata('__guards__', SubscriptionsController) as
      | unknown[]
      | undefined;
    expect(Array.isArray(guards)).toBe(true);
    expect(guards?.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SubscriptionsController idempotency wiring (TS-044)', () => {
  // The IdempotencyInterceptor (provided globally by IdempotencyModule
  // in app.module.ts) reads this exact symbol when deciding whether to
  // engage the Redis-backed Idempotency-Key replay cache. The metadata
  // MUST be present on every write endpoint or a replayed request will
  // silently re-run the handler — defeating CLAUDE.md §3.3 / §17.5.
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks POST /api/v1/subscriptions as @Idempotent()', () => {
    const handler = SubscriptionsController.prototype.create as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks PATCH /api/v1/subscriptions/:id as @Idempotent()', () => {
    const handler = SubscriptionsController.prototype.patch as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks DELETE /api/v1/subscriptions/:id as @Idempotent()', () => {
    const handler = SubscriptionsController.prototype.cancel as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks POST /api/v1/subscriptions/:id/pause as @Idempotent()', () => {
    const handler = SubscriptionsController.prototype.pause as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks POST /api/v1/subscriptions/:id/resume as @Idempotent()', () => {
    const handler = SubscriptionsController.prototype.resume as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TS-042 — pause / resume
// ─────────────────────────────────────────────────────────────────────────

function dunningOk(value: SubscriptionResponse): Result<SubscriptionResponse, DunningFailure> {
  return ok(value);
}
function dunningFailure(error: DunningFailure): Result<SubscriptionResponse, DunningFailure> {
  return err(error);
}

describe('SubscriptionsController.pause', () => {
  const pausedResponse: SubscriptionResponse = {
    ...sampleResponse,
    status: 'paused',
    pauseCollectionStartedAt: '2026-05-12T12:00:00.000Z',
    pauseReason: 'travel hold',
  };

  it('returns the paused SubscriptionResponse on success', async () => {
    const { controller, dunning } = buildSvc();
    dunning.pauseSubscription.mockResolvedValue(dunningOk(pausedResponse));

    const result = await controller.pause(
      'sub_internal_001',
      { reason: 'travel hold' },
      buildRequest('usr_payer'),
    );

    expect(result.status).toBe('paused');
    expect(dunning.pauseSubscription).toHaveBeenCalledWith({
      subscriptionId: 'sub_internal_001',
      requesterUserId: 'usr_payer',
      reason: 'travel hold',
    });
  });

  it('parses resumesAt ISO string into a Date for the service', async () => {
    const { controller, dunning } = buildSvc();
    dunning.pauseSubscription.mockResolvedValue(dunningOk(pausedResponse));
    await controller.pause(
      'sub_internal_001',
      { resumesAt: '2026-06-12T00:00:00.000Z' },
      buildRequest('usr'),
    );
    const arg = dunning.pauseSubscription.mock.calls[0]?.[0] as { resumesAt: Date };
    expect(arg.resumesAt).toBeInstanceOf(Date);
    expect(arg.resumesAt.toISOString()).toBe('2026-06-12T00:00:00.000Z');
  });

  it('forwards Idempotency-Key header to the service', async () => {
    const { controller, dunning } = buildSvc();
    dunning.pauseSubscription.mockResolvedValue(dunningOk(pausedResponse));
    await controller.pause('sub_internal_001', {}, buildRequest('usr'), 'idem-pause-key-12345-abc');
    expect(dunning.pauseSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-pause-key-12345-abc' }),
    );
  });

  it('translates invalid_state into 422 Unprocessable', async () => {
    const { controller, dunning } = buildSvc();
    dunning.pauseSubscription.mockResolvedValue(
      dunningFailure({
        reason: 'invalid_state',
        subscriptionId: 'sub_x',
        currentStatus: 'canceled',
        expected: ['active', 'trialing', 'past_due'],
      }),
    );
    await expect(controller.pause('sub_x', {}, buildRequest('usr'))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('translates subscription_not_found into 404', async () => {
    const { controller, dunning } = buildSvc();
    dunning.pauseSubscription.mockResolvedValue(
      dunningFailure({ reason: 'subscription_not_found', subscriptionId: 'sub_x' }),
    );
    await expect(controller.pause('sub_x', {}, buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('translates stripe_unavailable into 500 with a generic body', async () => {
    const { controller, dunning } = buildSvc();
    dunning.pauseSubscription.mockResolvedValue(
      dunningFailure({ reason: 'stripe_unavailable', cause: new Error('rate limited') }),
    );
    try {
      await controller.pause('sub_x', {}, buildRequest('usr'));
      throw new Error('expected pause to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerErrorException);
      const body = (e as InternalServerErrorException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toBe('upstream payment provider unavailable');
      expect(JSON.stringify(body)).not.toContain('rate limited');
    }
  });

  it('throws Unauthorized when no requestContext is present', async () => {
    const { controller, dunning } = buildSvc();
    await expect(controller.pause('sub_x', {}, buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(dunning.pauseSubscription).not.toHaveBeenCalled();
  });
});

describe('SubscriptionsController.resume', () => {
  const resumedResponse: SubscriptionResponse = { ...sampleResponse, status: 'active' };

  it('returns the resumed SubscriptionResponse on success', async () => {
    const { controller, dunning } = buildSvc();
    dunning.resumeSubscription.mockResolvedValue(dunningOk(resumedResponse));
    const result = await controller.resume(
      'sub_internal_001',
      { note: 'ready to bill' },
      buildRequest('usr_payer'),
    );
    expect(result.status).toBe('active');
    expect(dunning.resumeSubscription).toHaveBeenCalledWith({
      subscriptionId: 'sub_internal_001',
      requesterUserId: 'usr_payer',
      note: 'ready to bill',
    });
  });

  it('translates invalid_state into 422 with the expected-state set', async () => {
    const { controller, dunning } = buildSvc();
    dunning.resumeSubscription.mockResolvedValue(
      dunningFailure({
        reason: 'invalid_state',
        subscriptionId: 'sub_x',
        currentStatus: 'active',
        expected: ['paused'],
      }),
    );
    try {
      await controller.resume('sub_x', {}, buildRequest('usr'));
      throw new Error('expected resume to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      const body = (e as UnprocessableEntityException).getResponse() as Record<string, unknown>;
      expect(body['expected']).toEqual(['paused']);
      expect(body['currentStatus']).toBe('active');
    }
  });

  it('translates grace_not_expired into 422', async () => {
    // grace_not_expired is from applyDunningExhaustion but the mapper
    // is shared — exercise the branch via resume's mock to cover it.
    const { controller, dunning } = buildSvc();
    dunning.resumeSubscription.mockResolvedValue(
      dunningFailure({
        reason: 'grace_not_expired',
        subscriptionId: 'sub_x',
        graceUntil: new Date('2026-06-02T00:00:00.000Z'),
      }),
    );
    await expect(controller.resume('sub_x', {}, buildRequest('usr'))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('translates invalid_request into 400', async () => {
    const { controller, dunning } = buildSvc();
    dunning.resumeSubscription.mockResolvedValue(
      dunningFailure({ reason: 'invalid_request', message: 'missing id' }),
    );
    await expect(controller.resume('sub_x', {}, buildRequest('usr'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('translates subscription_not_found into 404', async () => {
    const { controller, dunning } = buildSvc();
    dunning.resumeSubscription.mockResolvedValue(
      dunningFailure({ reason: 'subscription_not_found', subscriptionId: 'sub_x' }),
    );
    await expect(controller.resume('sub_x', {}, buildRequest('usr'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws Unauthorized when no requestContext is present', async () => {
    const { controller, dunning } = buildSvc();
    await expect(controller.resume('sub_x', {}, buildRequest(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(dunning.resumeSubscription).not.toHaveBeenCalled();
  });

  it('forwards Idempotency-Key header to the service', async () => {
    const { controller, dunning } = buildSvc();
    dunning.resumeSubscription.mockResolvedValue(dunningOk(resumedResponse));
    await controller.resume('sub_internal_001', {}, buildRequest('usr'), 'idem-resume-12345');
    expect(dunning.resumeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-resume-12345' }),
    );
  });
});
