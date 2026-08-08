import {
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { CouponContraRevenueService } from '../services/coupon-contra-revenue.service';
import type { RefundService } from '../services/refund.service';
import {
  REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER,
  RefundsContraController,
} from './refunds-contra.controller';

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3015,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://x:y@localhost:5432/tastesee',
    SERVICE_VERSION: 'test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 60 * 60 * 24,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 30,
    INTERNAL_POST_JOURNAL_API_KEY: 'b'.repeat(32),
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: 0,
  };
}

function makeCouponService(): CouponContraRevenueService {
  return {
    applyCouponRedemption: vi.fn(),
  } as unknown as CouponContraRevenueService;
}

function makeRefundService(): RefundService {
  return {
    applySubscriptionRefund: vi.fn(),
    applyBookingRefund: vi.fn(),
  } as unknown as RefundService;
}

interface FakeRequest {
  header(name: string): string | undefined;
}

function makeRequest(headers: Record<string, string> = {}): FakeRequest {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  };
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function buildController(store?: TenantContextStore): {
  controller: RefundsContraController;
  coupon: CouponContraRevenueService;
  refund: RefundService;
  store: TenantContextStore;
} {
  const coupon = makeCouponService();
  const refund = makeRefundService();
  const tenantStore = store ?? makeStore();
  const controller = new RefundsContraController(coupon, refund, buildEnv(), tenantStore);
  return { controller, coupon, refund, store: tenantStore };
}

// ── Coupon redeemed ───────────────────────────────────────────────────────

const validCouponBody = {
  couponRedemptionId: 'cred_abc',
  subscriptionId: 'sub_abc',
  customerId: 'cust_abc',
  customerGroup: 'family' as const,
  planCode: 'family.tier2',
  discountAmountMinor: 5_000,
  currency: 'USD' as const,
  occurredAt: '2026-05-12T10:00:00.000Z',
  sourceEventId: 'evt_coupon.redeemed_cred_abc',
};

const okCouponOutput = {
  journalId: 'jrnl_1',
  couponRedemptionId: 'cred_abc',
  subscriptionId: 'sub_abc',
  planCode: 'family.tier2',
  discountAmountMinor: 5_000,
  currency: 'USD' as const,
  result: 'created' as const,
};

describe('RefundsContraController.applyCouponRedemption', () => {
  it('returns the coupon contra-revenue response when the shared secret is correct', async () => {
    const { controller, coupon } = buildController();
    vi.mocked(coupon.applyCouponRedemption).mockResolvedValue({
      ok: true,
      value: okCouponOutput,
    } as never);

    const result = await controller.applyCouponRedemption(
      validCouponBody,
      makeRequest({
        [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
      }) as never,
    );
    expect(result).toEqual({
      journalId: 'jrnl_1',
      couponRedemptionId: 'cred_abc',
      subscriptionId: 'sub_abc',
      planCode: 'family.tier2',
      discountAmountMinor: 5_000,
      currency: 'USD',
      result: 'created',
    });
    expect(coupon.applyCouponRedemption).toHaveBeenCalledWith(validCouponBody);
  });

  it('returns idempotent_replay when the service reports a replay', async () => {
    const { controller, coupon } = buildController();
    vi.mocked(coupon.applyCouponRedemption).mockResolvedValue({
      ok: true,
      value: { ...okCouponOutput, result: 'idempotent_replay' as const },
    } as never);
    const result = await controller.applyCouponRedemption(
      validCouponBody,
      makeRequest({
        [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
      }) as never,
    );
    expect(result.result).toBe('idempotent_replay');
  });

  it('rejects with 401 when the shared-secret header is missing', async () => {
    const { controller, coupon } = buildController();
    await expect(
      controller.applyCouponRedemption(validCouponBody, makeRequest() as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(coupon.applyCouponRedemption).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the shared-secret header is wrong', async () => {
    const { controller } = buildController();
    await expect(
      controller.applyCouponRedemption(
        validCouponBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'wrong-secret',
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps amount_non_positive to 422', async () => {
    const { controller, coupon } = buildController();
    vi.mocked(coupon.applyCouponRedemption).mockResolvedValue({
      ok: false,
      failure: { kind: 'amount_non_positive' },
    } as never);
    await expect(
      controller.applyCouponRedemption(
        validCouponBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps journal_post_failed → account_not_found to 404', async () => {
    const { controller, coupon } = buildController();
    vi.mocked(coupon.applyCouponRedemption).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: { kind: 'account_not_found', accountCode: '4000.family.tier2' },
      },
    } as never);
    await expect(
      controller.applyCouponRedemption(
        validCouponBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('carries the @Idempotent decorator metadata', () => {
    const metadata = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      RefundsContraController.prototype.applyCouponRedemption,
    );
    expect(metadata).toBeDefined();
  });
});

// ── Subscription refund ───────────────────────────────────────────────────

const validSubscriptionRefundBody = {
  subscriptionId: 'sub_abc',
  customerId: 'cust_abc',
  customerGroup: 'family' as const,
  planCode: 'family.tier2',
  refundAmountMinor: 9_900,
  currency: 'USD' as const,
  occurredAt: '2026-05-12T11:00:00.000Z',
  sourceEventId: 'evt_subscription.refunded_sub_abc',
};

const okSubscriptionRefundOutput = {
  journalId: 'jrnl_2',
  subscriptionId: 'sub_abc',
  planCode: 'family.tier2',
  refundAmountMinor: 9_900,
  currency: 'USD' as const,
  result: 'created' as const,
};

describe('RefundsContraController.applySubscriptionRefund', () => {
  it('returns the subscription refund response on success', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applySubscriptionRefund).mockResolvedValue({
      ok: true,
      value: okSubscriptionRefundOutput,
    } as never);

    const result = await controller.applySubscriptionRefund(
      validSubscriptionRefundBody,
      makeRequest({
        [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
      }) as never,
    );
    expect(result).toEqual({
      journalId: 'jrnl_2',
      subscriptionId: 'sub_abc',
      planCode: 'family.tier2',
      refundAmountMinor: 9_900,
      currency: 'USD',
      result: 'created',
    });
  });

  it('rejects with 401 when the shared-secret header is missing', async () => {
    const { controller, refund } = buildController();
    await expect(
      controller.applySubscriptionRefund(validSubscriptionRefundBody, makeRequest() as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(refund.applySubscriptionRefund).not.toHaveBeenCalled();
  });

  it('maps amount_non_positive to 422', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applySubscriptionRefund).mockResolvedValue({
      ok: false,
      failure: { kind: 'amount_non_positive' },
    } as never);
    await expect(
      controller.applySubscriptionRefund(
        validSubscriptionRefundBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps journal_post_failed → period_closed to 422', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applySubscriptionRefund).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: {
          kind: 'period_closed',
          periodId: 'prd_2026_04',
          periodName: '2026-04',
        },
      },
    } as never);
    await expect(
      controller.applySubscriptionRefund(
        validSubscriptionRefundBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('carries the @Idempotent decorator metadata', () => {
    const metadata = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      RefundsContraController.prototype.applySubscriptionRefund,
    );
    expect(metadata).toBeDefined();
  });
});

// ── Booking refund ────────────────────────────────────────────────────────

const validBookingRefundBody = {
  bookingId: 'bk_abc',
  providerId: 'prv_abc',
  householdId: 'hh_abc',
  refundAmountMinor: 15_000,
  providerPortionMinor: 12_000,
  marketplacePortionMinor: 3_000,
  commissionRateBps: 2_000,
  currency: 'USD' as const,
  occurredAt: '2026-05-12T12:00:00.000Z',
  sourceEventId: 'evt_booking.refunded_bk_abc',
};

const okBookingRefundOutput = {
  journalId: 'jrnl_3',
  bookingId: 'bk_abc',
  providerId: 'prv_abc',
  refundAmountMinor: 15_000,
  providerPortionMinor: 12_000,
  marketplacePortionMinor: 3_000,
  commissionRateBps: 2_000,
  currency: 'USD' as const,
  runningPayableMinor: 8_000,
  result: 'created' as const,
};

describe('RefundsContraController.applyBookingRefund', () => {
  it('returns the booking refund response on success', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applyBookingRefund).mockResolvedValue({
      ok: true,
      value: okBookingRefundOutput,
    } as never);

    const result = await controller.applyBookingRefund(
      validBookingRefundBody,
      makeRequest({
        [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
      }) as never,
    );
    expect(result.runningPayableMinor).toBe(8_000);
    expect(result.result).toBe('created');
  });

  it('surfaces a negative running balance (clawback)', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applyBookingRefund).mockResolvedValue({
      ok: true,
      value: { ...okBookingRefundOutput, runningPayableMinor: -5_000 },
    } as never);
    const result = await controller.applyBookingRefund(
      validBookingRefundBody,
      makeRequest({
        [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
      }) as never,
    );
    expect(result.runningPayableMinor).toBe(-5_000);
  });

  it('rejects with 401 when the shared-secret header is missing', async () => {
    const { controller, refund } = buildController();
    await expect(
      controller.applyBookingRefund(validBookingRefundBody, makeRequest() as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(refund.applyBookingRefund).not.toHaveBeenCalled();
  });

  it('maps amount_invariant_violated to 422', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applyBookingRefund).mockResolvedValue({
      ok: false,
      failure: { kind: 'amount_invariant_violated' },
    } as never);
    await expect(
      controller.applyBookingRefund(
        validBookingRefundBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps amount_non_positive to 422', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applyBookingRefund).mockResolvedValue({
      ok: false,
      failure: { kind: 'amount_non_positive' },
    } as never);
    await expect(
      controller.applyBookingRefund(
        validBookingRefundBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps journal_post_failed → account_inactive to 422', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applyBookingRefund).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: { kind: 'account_inactive', accountCode: '4100' },
      },
    } as never);
    await expect(
      controller.applyBookingRefund(
        validBookingRefundBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps journal_post_failed → mixed_currency to 422', async () => {
    const { controller, refund } = buildController();
    vi.mocked(refund.applyBookingRefund).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: { kind: 'mixed_currency', currencies: ['USD', 'EUR'] },
      },
    } as never);
    await expect(
      controller.applyBookingRefund(
        validBookingRefundBody,
        makeRequest({
          [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('carries the @Idempotent decorator metadata', () => {
    const metadata = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      RefundsContraController.prototype.applyBookingRefund,
    );
    expect(metadata).toBeDefined();
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * All three internal endpoints in this controller
 * (`applyCouponRedemption`, `applySubscriptionRefund`,
 * `applyBookingRefund`) are shared-secret-pinned via the
 * `REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER` rather than the
 * `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed a
 * scoped frame from a `request.requestContext` that does not exist.
 * Without an explicit exempt wrap, every Prisma operation downstream
 * (the contra-revenue journal insert, the per-provider running balance
 * clawback decrement) would hard-fail with
 * `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`.
 *
 * Each handler wraps in `runWithoutTenantContext(...,
 * 'internal-coupon-redeemed' | 'internal-subscription-refunded' |
 * 'internal-booking-refunded', ...)`. These tests pin each reason
 * string at the failing collaborator's callsite by passing a real
 * `TenantContextStore`.
 */
describe('RefundsContraController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs applyCouponRedemption inside an exempt frame with reason "internal-coupon-redeemed"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const { controller, coupon } = buildController(store);
    vi.mocked(coupon.applyCouponRedemption).mockImplementation(async () => {
      captured = store.current();
      return { ok: true, value: okCouponOutput } as never;
    });
    const req = makeRequest({
      [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    await controller.applyCouponRedemption(validCouponBody, req as never);

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-coupon-redeemed',
    });
    expect(coupon.applyCouponRedemption).toHaveBeenCalledTimes(1);
  });

  it('runs applySubscriptionRefund inside an exempt frame with reason "internal-subscription-refunded"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const { controller, refund } = buildController(store);
    vi.mocked(refund.applySubscriptionRefund).mockImplementation(async () => {
      captured = store.current();
      return { ok: true, value: okSubscriptionRefundOutput } as never;
    });
    const req = makeRequest({
      [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    await controller.applySubscriptionRefund(validSubscriptionRefundBody, req as never);

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-subscription-refunded',
    });
    expect(refund.applySubscriptionRefund).toHaveBeenCalledTimes(1);
  });

  it('runs applyBookingRefund inside an exempt frame with reason "internal-booking-refunded"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const { controller, refund } = buildController(store);
    vi.mocked(refund.applyBookingRefund).mockImplementation(async () => {
      captured = store.current();
      return { ok: true, value: okBookingRefundOutput } as never;
    });
    const req = makeRequest({
      [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    await controller.applyBookingRefund(validBookingRefundBody, req as never);

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-booking-refunded',
    });
    expect(refund.applyBookingRefund).toHaveBeenCalledTimes(1);
  });

  it('captures the frame on the 401 short-circuit branch for applyBookingRefund (wrap encloses the shared-secret check)', async () => {
    const store = makeStore();
    let frameAtThrow: TenantContextFrame | null = null;
    const { controller, refund } = buildController(store);
    const req = {
      header: () => {
        frameAtThrow = store.current();
        return undefined;
      },
    };

    await expect(
      controller.applyBookingRefund(validBookingRefundBody, req as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(frameAtThrow).toEqual({
      kind: 'exempt',
      reason: 'internal-booking-refunded',
    });
    expect(refund.applyBookingRefund).not.toHaveBeenCalled();
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const { controller, coupon } = buildController(store);
    vi.mocked(coupon.applyCouponRedemption).mockResolvedValue({
      ok: true,
      value: okCouponOutput,
    } as never);
    const req = makeRequest({
      [REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    expect(store.current()).toBeNull();
    await controller.applyCouponRedemption(validCouponBody, req as never);
    expect(store.current()).toBeNull();
  });
});
