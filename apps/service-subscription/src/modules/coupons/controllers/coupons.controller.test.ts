import { ConflictException, NotFoundException, HttpException } from '@nestjs/common';
import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import Decimal from 'decimal.js';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type { PrismaService } from '../../../prisma/prisma.service';
import { err, ok } from '../../subscriptions/result';
import { CouponMetrics } from '../services/coupon-metrics';
import type { CouponRateLimitService } from '../services/coupon-rate-limit.service';
import type { CouponsService, ValidatedCoupon } from '../services/coupons.service';

import { CouponsController } from './coupons.controller';

interface FakeRequest {
  requestContext: {
    userId: string;
    mfaVerified: boolean;
    roles: readonly never[];
    tenantScope: { type: 'global' };
  };
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

function buildResponse(): Response {
  const setHeader = vi.fn();
  return { setHeader } as unknown as Response;
}

function buildRequest(overrides: Partial<FakeRequest> = {}): RequestWithContext {
  const base: FakeRequest = {
    requestContext: {
      userId: 'usr_caller',
      mfaVerified: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
    ip: '203.0.113.5',
    headers: {},
    ...overrides,
  };
  return base as unknown as RequestWithContext;
}

const VALIDATED: ValidatedCoupon = {
  id: 'cpn_xyz',
  code: 'PROMO20',
  name: '20% off',
  kind: 'percent_off',
  amount: 20,
  currency: 'USD',
  duration: 'once',
  durationInMonths: null,
  stackable: false,
  stripeCouponId: null,
  valueAppliedMinor: 3980,
  extendedTrialDays: null,
};

function buildController(): {
  controller: CouponsController;
  coupons: {
    validate: ReturnType<typeof vi.fn>;
    createCoupon: ReturnType<typeof vi.fn>;
    deactivateCoupon: ReturnType<typeof vi.fn>;
  };
  rateLimit: { check: ReturnType<typeof vi.fn> };
  prisma: { plan: { findUnique: ReturnType<typeof vi.fn> } };
} {
  const coupons = {
    validate: vi.fn(),
    createCoupon: vi.fn(),
    deactivateCoupon: vi.fn(),
  };
  const rateLimit = {
    check: vi.fn(),
  };
  const prisma = {
    plan: { findUnique: vi.fn() },
  };
  const controller = new CouponsController(
    coupons as unknown as CouponsService,
    rateLimit as unknown as CouponRateLimitService,
    prisma as unknown as PrismaService,
  );
  return { controller, coupons, rateLimit, prisma };
}

describe('CouponsController.validate', () => {
  const body = {
    code: 'PROMO20',
    planId: 'plan_companion',
    customerId: 'hh_123',
    customerGroup: 'family' as const,
  };

  it('returns the narrow DTO on a happy-path validation', async () => {
    const { controller, coupons, rateLimit, prisma } = buildController();
    rateLimit.check.mockResolvedValue(ok(undefined));
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan_companion',
      currency: 'USD',
      monthlyPrice: new Decimal('199.00'),
      annualPrice: new Decimal('1990.00'),
      active: true,
    });
    coupons.validate.mockResolvedValue(ok(VALIDATED));

    const result = await controller.validate(body, buildRequest(), buildResponse());

    expect(result.couponId).toBe('cpn_xyz');
    expect(result.code).toBe('PROMO20');
    expect(result.valueAppliedMinor).toBe(3980);
  });

  it('returns 429 with Retry-After when the rate limiter trips', async () => {
    const { controller, rateLimit } = buildController();
    rateLimit.check.mockResolvedValue(
      err({
        reason: 'rate_limited',
        scope: 'user',
        retryAfterSeconds: 45,
        limit: 10,
        windowSeconds: 60,
      }),
    );
    const response = buildResponse();
    await expect(controller.validate(body, buildRequest(), response)).rejects.toThrow(
      HttpException,
    );
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '45');
  });

  it('proceeds when the rate limiter returns unavailable (fail-open)', async () => {
    const { controller, coupons, rateLimit, prisma } = buildController();
    rateLimit.check.mockResolvedValue(
      err({ reason: 'unavailable', cause: new Error('redis down') }),
    );
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan_companion',
      currency: 'USD',
      monthlyPrice: new Decimal('199.00'),
      annualPrice: new Decimal('1990.00'),
      active: true,
    });
    coupons.validate.mockResolvedValue(ok(VALIDATED));

    const result = await controller.validate(body, buildRequest(), buildResponse());
    expect(result.couponId).toBe('cpn_xyz');
  });

  it('returns 404 with failureReason when plan is missing', async () => {
    const { controller, rateLimit, prisma } = buildController();
    rateLimit.check.mockResolvedValue(ok(undefined));
    prisma.plan.findUnique.mockResolvedValue(null);

    await expect(controller.validate(body, buildRequest(), buildResponse())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns 404 with failureReason when the coupon validation gate fails', async () => {
    const { controller, coupons, rateLimit, prisma } = buildController();
    rateLimit.check.mockResolvedValue(ok(undefined));
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan_companion',
      currency: 'USD',
      monthlyPrice: new Decimal('199.00'),
      annualPrice: new Decimal('1990.00'),
      active: true,
    });
    coupons.validate.mockResolvedValue(
      err({ reason: 'coupon_expired', couponId: 'cpn_xyz', expiresAt: new Date() }),
    );

    try {
      await controller.validate(body, buildRequest(), buildResponse());
      throw new Error('expected NotFoundException');
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundException);
      const body = (e as NotFoundException).getResponse() as Record<string, unknown>;
      expect(body.failureReason).toBe('coupon_expired');
    }
  });

  it('reads X-Forwarded-For when present for IP scope', async () => {
    const { controller, coupons, rateLimit, prisma } = buildController();
    rateLimit.check.mockResolvedValue(ok(undefined));
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan_companion',
      currency: 'USD',
      monthlyPrice: new Decimal('199.00'),
      annualPrice: new Decimal('1990.00'),
      active: true,
    });
    coupons.validate.mockResolvedValue(ok(VALIDATED));

    await controller.validate(
      body,
      buildRequest({ headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } }),
      buildResponse(),
    );

    expect(rateLimit.check).toHaveBeenCalledWith({
      ip: '198.51.100.7',
      userId: 'usr_caller',
    });
  });
});

describe('CouponsController.createCoupon (admin)', () => {
  const body = {
    code: 'NEWPROMO',
    name: 'New promo',
    kind: 'percent_off' as const,
    amount: 25,
    currency: 'USD',
    duration: 'once' as const,
    appliesToPlanIds: [],
    firstTimeCustomerOnly: false,
    stackable: false,
  };

  it('persists the coupon and returns the new id + code', async () => {
    const { controller, coupons } = buildController();
    coupons.createCoupon.mockResolvedValue(ok({ couponId: 'cpn_new', code: 'NEWPROMO' }));

    const result = await controller.createCoupon(body, buildRequest());
    expect(result.couponId).toBe('cpn_new');
    expect(result.code).toBe('NEWPROMO');
  });

  it('returns 409 when the code is already taken', async () => {
    const { controller, coupons } = buildController();
    coupons.createCoupon.mockResolvedValue(err({ reason: 'coupon_code_taken', code: 'NEWPROMO' }));

    await expect(controller.createCoupon(body, buildRequest())).rejects.toThrow(ConflictException);
  });
});

describe('CouponsController.deactivateCoupon (admin)', () => {
  it('returns no body on success', async () => {
    const { controller, coupons } = buildController();
    coupons.deactivateCoupon.mockResolvedValue(ok(undefined));
    await expect(controller.deactivateCoupon('cpn_xyz', buildRequest())).resolves.toBeUndefined();
  });

  it('returns 404 for an unknown id', async () => {
    const { controller, coupons } = buildController();
    coupons.deactivateCoupon.mockResolvedValue(
      err({ reason: 'coupon_not_found', couponId: 'cpn_missing' }),
    );
    await expect(controller.deactivateCoupon('cpn_missing', buildRequest())).rejects.toThrow(
      NotFoundException,
    );
  });
});

/**
 * Validate-surface observability (TS-043-followup-8). The `coupon_validate_total`
 * counter is recorded at the controller because the `rate_limit` dimension is a
 * controller-only concern. The controller must be built AFTER `initMetrics` so
 * its injected `CouponMetrics` binds to the live meter.
 */
describe('CouponsController.validate — observability metrics (TS-043-followup-8)', () => {
  const body = {
    code: 'PROMO20',
    planId: 'plan_companion',
    customerId: 'hh_123',
    customerGroup: 'family' as const,
  };

  function buildControllerWithMetrics(metrics: CouponMetrics): {
    controller: CouponsController;
    coupons: { validate: ReturnType<typeof vi.fn> };
    rateLimit: { check: ReturnType<typeof vi.fn> };
    prisma: { plan: { findUnique: ReturnType<typeof vi.fn> } };
  } {
    const coupons = {
      validate: vi.fn(),
      createCoupon: vi.fn(),
      deactivateCoupon: vi.fn(),
    };
    const rateLimit = { check: vi.fn() };
    const prisma = { plan: { findUnique: vi.fn() } };
    const controller = new CouponsController(
      coupons as unknown as CouponsService,
      rateLimit as unknown as CouponRateLimitService,
      prisma as unknown as PrismaService,
      metrics,
    );
    return { controller, coupons, rateLimit, prisma };
  }

  function seedActivePlan(prisma: { plan: { findUnique: ReturnType<typeof vi.fn> } }): void {
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan_companion',
      currency: 'USD',
      monthlyPrice: new Decimal('199.00'),
      annualPrice: new Decimal('1990.00'),
      active: true,
    });
  }

  beforeEach(() => {
    initMetrics({
      service: 'service-subscription-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a happy-path validate with outcome="ok" + rate_limit="allowed"', async () => {
    const { controller, coupons, rateLimit, prisma } = buildControllerWithMetrics(
      new CouponMetrics(),
    );
    rateLimit.check.mockResolvedValue(ok(undefined));
    seedActivePlan(prisma);
    coupons.validate.mockResolvedValue(ok(VALIDATED));

    await controller.validate(body, buildRequest(), buildResponse());

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_validate_total\{[^}]*outcome="ok"[^}]*rate_limit="allowed"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /coupon_operation_duration_seconds_count\{[^}]*operation="validate"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a rate-limited validate with rate_limit="rate_limited"', async () => {
    const { controller, rateLimit } = buildControllerWithMetrics(new CouponMetrics());
    rateLimit.check.mockResolvedValue(
      err({
        reason: 'rate_limited',
        scope: 'user',
        retryAfterSeconds: 45,
        limit: 10,
        windowSeconds: 60,
      }),
    );

    await expect(controller.validate(body, buildRequest(), buildResponse())).rejects.toThrow(
      HttpException,
    );

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_validate_total\{[^}]*outcome="rate_limited"[^}]*rate_limit="rate_limited"[^}]*\} 1/,
    );
  });

  it('counts an eligibility rejection with the specific outcome label + rate_limit="allowed"', async () => {
    const { controller, coupons, rateLimit, prisma } = buildControllerWithMetrics(
      new CouponMetrics(),
    );
    rateLimit.check.mockResolvedValue(ok(undefined));
    seedActivePlan(prisma);
    coupons.validate.mockResolvedValue(
      err({ reason: 'coupon_expired', couponId: 'cpn_xyz', expiresAt: new Date('2025-01-01') }),
    );

    await expect(controller.validate(body, buildRequest(), buildResponse())).rejects.toThrow(
      NotFoundException,
    );

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_validate_total\{[^}]*outcome="coupon_expired"[^}]*rate_limit="allowed"[^}]*\} 1/,
    );
  });

  it('counts a fail-open validate (Redis down) with rate_limit="unavailable"', async () => {
    const { controller, coupons, rateLimit, prisma } = buildControllerWithMetrics(
      new CouponMetrics(),
    );
    rateLimit.check.mockResolvedValue(
      err({ reason: 'unavailable', cause: new Error('redis down') }),
    );
    seedActivePlan(prisma);
    coupons.validate.mockResolvedValue(ok(VALIDATED));

    await controller.validate(body, buildRequest(), buildResponse());

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_validate_total\{[^}]*outcome="ok"[^}]*rate_limit="unavailable"[^}]*\} 1/,
    );
  });

  it('counts a plan-not-found validate with outcome="plan_not_found"', async () => {
    const { controller, rateLimit, prisma } = buildControllerWithMetrics(new CouponMetrics());
    rateLimit.check.mockResolvedValue(ok(undefined));
    prisma.plan.findUnique.mockResolvedValue(null);

    await expect(controller.validate(body, buildRequest(), buildResponse())).rejects.toThrow(
      NotFoundException,
    );

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_validate_total\{[^}]*outcome="plan_not_found"[^}]*\} 1/);
  });
});
