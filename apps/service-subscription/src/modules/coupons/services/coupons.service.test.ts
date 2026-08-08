import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';

import { CouponMetrics } from './coupon-metrics';
import { CouponsService, type CouponPlanContext } from './coupons.service';

interface FakeCouponRow {
  id: string;
  code: string;
  name: string;
  kind: 'percent_off' | 'amount_off' | 'extended_trial';
  amount: number;
  currency: string;
  duration: 'once' | 'repeating' | 'forever';
  durationInMonths: number | null;
  appliesToPlanIds: string[];
  maxRedemptions: number | null;
  timesRedeemed: number;
  perCustomerLimit: number | null;
  firstTimeCustomerOnly: boolean;
  minSpendMinor: number | null;
  stackable: boolean;
  expiresAt: Date | null;
  active: boolean;
  stripeCouponId: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeRedemptionRow {
  id: string;
  couponId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  subscriptionId: string;
  valueAppliedMinor: number;
  currency: string;
  redeemedAt: Date;
}

interface FakeSubscriptionRow {
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
}

/**
 * Minimal Prisma stand-in for the CouponsService surface. Mirrors the
 * pattern used by SubscriptionsService's test fixture but narrowed to
 * the rows the coupon flow touches.
 */
class FakePrisma {
  public coupons: FakeCouponRow[] = [];
  public redemptions: FakeRedemptionRow[] = [];
  public subscriptions: FakeSubscriptionRow[] = [];
  private idCounter = 0;

  coupon = {
    findUnique: vi.fn(
      async (args: {
        where: { code?: string; id?: string };
        select?: unknown;
      }): Promise<FakeCouponRow | null> => {
        const where = args.where;
        if (where.code !== undefined) {
          return this.coupons.find((c) => c.code === where.code) ?? null;
        }
        if (where.id !== undefined) {
          return this.coupons.find((c) => c.id === where.id) ?? null;
        }
        return null;
      },
    ),
    create: vi.fn(
      async (args: {
        data: Partial<FakeCouponRow>;
        select?: { id?: boolean; code?: boolean };
      }): Promise<{ id: string; code: string } | FakeCouponRow> => {
        const data = args.data;
        if (this.coupons.some((c) => c.code === data.code)) {
          // Mimic Prisma P2002 unique violation.
          const err = new Error('Unique constraint failed') as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        this.idCounter += 1;
        const row: FakeCouponRow = {
          id: `cpn_${this.idCounter}`,
          code: data.code ?? 'UNSET',
          name: data.name ?? 'unnamed',
          kind: data.kind ?? 'percent_off',
          amount: data.amount ?? 10,
          currency: data.currency ?? 'USD',
          duration: data.duration ?? 'once',
          durationInMonths: data.durationInMonths ?? null,
          appliesToPlanIds: data.appliesToPlanIds ?? [],
          maxRedemptions: data.maxRedemptions ?? null,
          timesRedeemed: 0,
          perCustomerLimit: data.perCustomerLimit ?? 1,
          firstTimeCustomerOnly: data.firstTimeCustomerOnly ?? false,
          minSpendMinor: data.minSpendMinor ?? null,
          stackable: data.stackable ?? false,
          expiresAt: data.expiresAt ?? null,
          active: data.active ?? true,
          stripeCouponId: null,
          notes: data.notes ?? null,
          createdByUserId: data.createdByUserId ?? 'usr_admin',
          createdAt: new Date('2026-05-12T00:00:00.000Z'),
          updatedAt: new Date('2026-05-12T00:00:00.000Z'),
        };
        this.coupons.push(row);
        if (args.select?.id === true || args.select?.code === true) {
          return { id: row.id, code: row.code };
        }
        return row;
      },
    ),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: { active?: boolean; stripeCouponId?: string; timesRedeemed?: { increment: number } };
      }): Promise<FakeCouponRow> => {
        const idx = this.coupons.findIndex((c) => c.id === args.where.id);
        if (idx === -1) throw new Error(`coupon ${args.where.id} not found`);
        const current = this.coupons[idx]!;
        const data = args.data;
        const next: FakeCouponRow = {
          ...current,
          ...(data.active !== undefined && { active: data.active }),
          ...(data.stripeCouponId !== undefined && { stripeCouponId: data.stripeCouponId }),
          ...(data.timesRedeemed !== undefined && {
            timesRedeemed: current.timesRedeemed + data.timesRedeemed.increment,
          }),
          updatedAt: new Date(),
        };
        this.coupons[idx] = next;
        return next;
      },
    ),
  };

  couponRedemption = {
    create: vi.fn(
      async (args: {
        data: Omit<FakeRedemptionRow, 'id' | 'redeemedAt'>;
        select?: { id?: boolean };
      }): Promise<{ id: string }> => {
        // Mimic unique (couponId, subscriptionId) violation.
        if (
          this.redemptions.some(
            (r) =>
              r.couponId === args.data.couponId && r.subscriptionId === args.data.subscriptionId,
          )
        ) {
          const err = new Error('Unique constraint failed') as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        this.idCounter += 1;
        const row: FakeRedemptionRow = {
          id: `rdm_${this.idCounter}`,
          redeemedAt: new Date(),
          ...args.data,
        };
        this.redemptions.push(row);
        return { id: row.id };
      },
    ),
    count: vi.fn(
      async (args: {
        where: { couponId: string; customerId: string; customerGroup: string };
      }): Promise<number> => {
        return this.redemptions.filter(
          (r) =>
            r.couponId === args.where.couponId &&
            r.customerId === args.where.customerId &&
            r.customerGroup === args.where.customerGroup,
        ).length;
      },
    ),
  };

  subscription = {
    count: vi.fn(
      async (args: { where: { customerId: string; customerGroup: string } }): Promise<number> => {
        return this.subscriptions.filter(
          (s) =>
            s.customerId === args.where.customerId && s.customerGroup === args.where.customerGroup,
        ).length;
      },
    ),
  };

  asTx(): PrismaTransactionClient {
    return this as unknown as PrismaTransactionClient;
  }
}

interface FakeStripe {
  coupons: { create: ReturnType<typeof vi.fn> };
}

function buildStripe(): FakeStripe {
  const stripe: FakeStripe = {
    coupons: { create: vi.fn() },
  };
  stripe.coupons.create.mockResolvedValue({ id: 'coupon_stripe_xyz' });
  return stripe;
}

function buildSvc(): { service: CouponsService; prisma: FakePrisma; stripe: FakeStripe } {
  const prisma = new FakePrisma();
  const stripe = buildStripe();
  const service = new CouponsService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
  );
  return { service, prisma, stripe };
}

function seedCoupon(prisma: FakePrisma, overrides: Partial<FakeCouponRow> = {}): FakeCouponRow {
  const row: FakeCouponRow = {
    id: 'cpn_test',
    code: 'PROMO20',
    name: 'Twenty Percent Off',
    kind: 'percent_off',
    amount: 20,
    currency: 'USD',
    duration: 'once',
    durationInMonths: null,
    appliesToPlanIds: [],
    maxRedemptions: null,
    timesRedeemed: 0,
    perCustomerLimit: 1,
    firstTimeCustomerOnly: false,
    minSpendMinor: null,
    stackable: false,
    expiresAt: null,
    active: true,
    stripeCouponId: null,
    notes: null,
    createdByUserId: 'usr_admin',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
  prisma.coupons.push(row);
  return row;
}

const PLAN_CONTEXT: CouponPlanContext = {
  id: 'plan_tier2',
  currency: 'USD',
  monthlyPriceMinor: 19_900, // $199.00
  annualPriceMinor: 199_000, // $1990.00
};

const BASE_INPUT = {
  code: 'PROMO20',
  planId: 'plan_tier2',
  customerId: 'hh_123',
  customerGroup: 'family' as const,
};

describe('CouponsService.validate', () => {
  it('returns coupon_not_found when no row matches the code', async () => {
    const { service } = buildSvc();
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_not_found');
  });

  it('normalises the code to upper-case before lookup', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma);
    // Bypass the contract regex (which rejects lower-case) — service
    // sees the post-validation normalised path.
    const result = await service.validate(
      { ...BASE_INPUT, code: '  promo20  ' },
      PLAN_CONTEXT,
      'monthly',
    );
    expect(result.ok).toBe(true);
  });

  it('returns coupon_inactive when active=false', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { active: false });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_inactive');
  });

  it('returns coupon_expired when expiresAt is in the past', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { expiresAt: new Date('2020-01-01') });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_expired');
  });

  it('accepts a coupon with a future expiresAt', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { expiresAt: new Date('2099-01-01') });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(true);
  });

  it('returns coupon_cap_reached when timesRedeemed >= maxRedemptions', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { maxRedemptions: 5, timesRedeemed: 5 });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_cap_reached');
  });

  it('returns coupon_plan_not_eligible when appliesToPlanIds excludes the plan', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { appliesToPlanIds: ['plan_other'] });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_plan_not_eligible');
  });

  it('accepts when appliesToPlanIds includes the plan', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { appliesToPlanIds: ['plan_tier2'] });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(true);
  });

  it('returns coupon_min_spend_not_met when unit price < minSpendMinor', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { minSpendMinor: 50_000 });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_min_spend_not_met');
  });

  it('returns coupon_per_customer_limit_reached when the customer has redeemed the cap', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { perCustomerLimit: 1 });
    prisma.redemptions.push({
      id: 'rdm_existing',
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_prev',
      valueAppliedMinor: 1000,
      currency: 'USD',
      redeemedAt: new Date(),
    });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_per_customer_limit_reached');
  });

  it('returns coupon_first_time_only when customer has prior subscriptions', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { firstTimeCustomerOnly: true });
    prisma.subscriptions.push({ customerId: 'hh_123', customerGroup: 'family' });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_first_time_only');
  });

  it('computes percent_off discount as percent × monthly unit price', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { kind: 'percent_off', amount: 20 });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 20% of $199.00 = $39.80 → 3980 minor
    expect(result.value.valueAppliedMinor).toBe(3980);
    expect(result.value.extendedTrialDays).toBeNull();
  });

  it('computes percent_off discount against annual price when interval=annual', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { kind: 'percent_off', amount: 10 });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'annual');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 10% of $1990.00 = $199.00 → 19_900 minor
    expect(result.value.valueAppliedMinor).toBe(19_900);
  });

  it('caps percent_off=100 at the unit price', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { kind: 'percent_off', amount: 100 });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valueAppliedMinor).toBe(19_900);
  });

  it('computes amount_off discount in minor units, capped at the unit price', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { kind: 'amount_off', amount: 50_000 });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // amount > unit price, cap to 19_900
    expect(result.value.valueAppliedMinor).toBe(19_900);
  });

  it('returns extended_trial discount as 0 value + days', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { kind: 'extended_trial', amount: 14 });
    const result = await service.validate(BASE_INPUT, PLAN_CONTEXT, 'monthly');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valueAppliedMinor).toBe(0);
    expect(result.value.extendedTrialDays).toBe(14);
  });
});

describe('CouponsService.recordRedemption', () => {
  it('persists the redemption row and increments timesRedeemed atomically', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma);
    const result = await service.recordRedemption({
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_internal_1',
      valueAppliedMinor: 3980,
      currency: 'USD',
      kind: 'percent_off',
      tx: prisma.asTx(),
    });
    expect(result.ok).toBe(true);
    expect(prisma.redemptions).toHaveLength(1);
    expect(prisma.coupons[0]?.timesRedeemed).toBe(1);
  });

  it('returns redemption_conflict on (coupon, subscription) uniqueness violation', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma);
    prisma.redemptions.push({
      id: 'rdm_existing',
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_dup',
      valueAppliedMinor: 1000,
      currency: 'USD',
      redeemedAt: new Date(),
    });
    const result = await service.recordRedemption({
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_dup',
      valueAppliedMinor: 3980,
      currency: 'USD',
      kind: 'percent_off',
      tx: prisma.asTx(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('redemption_conflict');
  });
});

describe('CouponsService.ensureStripeCoupon', () => {
  it('returns null for extended_trial without calling Stripe', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedCoupon(prisma, { kind: 'extended_trial', amount: 14 });
    const result = await service.ensureStripeCoupon('cpn_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
    expect(stripe.coupons.create).not.toHaveBeenCalled();
  });

  it('returns the cached id when one is already set', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedCoupon(prisma, { stripeCouponId: 'coupon_already_seeded' });
    const result = await service.ensureStripeCoupon('cpn_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('coupon_already_seeded');
    expect(stripe.coupons.create).not.toHaveBeenCalled();
  });

  it('lazy-creates and caches the Stripe coupon for percent_off', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedCoupon(prisma, { kind: 'percent_off', amount: 25 });
    stripe.coupons.create.mockResolvedValue({ id: 'coupon_fresh_xyz' });
    const result = await service.ensureStripeCoupon('cpn_test', 'idem-abc');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('coupon_fresh_xyz');
    expect(prisma.coupons[0]?.stripeCouponId).toBe('coupon_fresh_xyz');
    const createArgs = stripe.coupons.create.mock.calls[0]?.[0];
    expect(createArgs?.percent_off).toBe(25);
    expect(createArgs?.duration).toBe('once');
    const idemArg = stripe.coupons.create.mock.calls[0]?.[1];
    expect(idemArg?.idempotencyKey).toContain('idem-abc');
  });

  it('lazy-creates with amount_off + currency for amount_off coupons', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedCoupon(prisma, { kind: 'amount_off', amount: 500 });
    stripe.coupons.create.mockResolvedValue({ id: 'coupon_amount_xyz' });
    await service.ensureStripeCoupon('cpn_test');
    const createArgs = stripe.coupons.create.mock.calls[0]?.[0];
    expect(createArgs?.amount_off).toBe(500);
    expect(createArgs?.currency).toBe('usd');
  });

  it('returns stripe_unavailable when the Stripe call throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedCoupon(prisma);
    stripe.coupons.create.mockRejectedValue(new Error('rate limited'));
    const result = await service.ensureStripeCoupon('cpn_test');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('stripe_unavailable');
  });
});

describe('CouponsService.createCoupon (admin)', () => {
  const baseCreate = {
    code: 'NEWPROMO',
    name: 'New Promo',
    kind: 'percent_off' as const,
    amount: 10,
    currency: 'USD',
    duration: 'once' as const,
    appliesToPlanIds: [],
    firstTimeCustomerOnly: false,
    stackable: false,
  };

  it('persists a new coupon and returns the id + code', async () => {
    const { service, prisma } = buildSvc();
    const result = await service.createCoupon(baseCreate, 'usr_admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe('NEWPROMO');
    expect(prisma.coupons).toHaveLength(1);
    expect(prisma.coupons[0]?.createdByUserId).toBe('usr_admin');
  });

  it('returns coupon_code_taken on a duplicate code', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { code: 'NEWPROMO' });
    const result = await service.createCoupon(baseCreate, 'usr_admin');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_code_taken');
  });
});

describe('CouponsService.deactivateCoupon (admin)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('flips active=false on an active coupon', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma);
    const result = await service.deactivateCoupon('cpn_test');
    expect(result.ok).toBe(true);
    expect(prisma.coupons[0]?.active).toBe(false);
  });

  it('is idempotent against an already-inactive row', async () => {
    const { service, prisma } = buildSvc();
    seedCoupon(prisma, { active: false });
    const result = await service.deactivateCoupon('cpn_test');
    expect(result.ok).toBe(true);
    expect(prisma.coupon.update).not.toHaveBeenCalled();
  });

  it('returns coupon_not_found for an unknown id', async () => {
    const { service } = buildSvc();
    const result = await service.deactivateCoupon('cpn_missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_not_found');
  });
});

/**
 * Drives the service end-to-end against a live MeterProvider and asserts the
 * Prometheus exposition reflects the outcome derived from the `Result`
 * (TS-043-followup-8). The service must be built AFTER `initMetrics` so its
 * `CouponMetrics` instruments bind to the live meter (DunningService
 * observability-test shape).
 */
describe('CouponsService — observability metrics (TS-043-followup-8)', () => {
  function buildSvcWithMetrics(metrics: CouponMetrics): {
    service: CouponsService;
    prisma: FakePrisma;
    stripe: FakeStripe;
  } {
    const prisma = new FakePrisma();
    const stripe = buildStripe();
    const service = new CouponsService(
      prisma as unknown as PrismaService,
      stripe as unknown as Stripe,
      metrics,
    );
    return { service, prisma, stripe };
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

  it('counts a successful redemption with outcome="ok" + kind + a latency sample', async () => {
    const { service, prisma } = buildSvcWithMetrics(new CouponMetrics());
    seedCoupon(prisma);

    const result = await service.recordRedemption({
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_metrics_1',
      valueAppliedMinor: 3980,
      currency: 'USD',
      kind: 'percent_off',
      tx: prisma.asTx(),
    });
    expect(result.ok).toBe(true);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_redemption_total\{[^}]*outcome="ok"[^}]*kind="percent_off"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /coupon_operation_duration_seconds_count\{[^}]*operation="record_redemption"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a redemption conflict with outcome="redemption_conflict"', async () => {
    const { service, prisma } = buildSvcWithMetrics(new CouponMetrics());
    seedCoupon(prisma);
    prisma.redemptions.push({
      id: 'rdm_existing',
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_dup',
      valueAppliedMinor: 1000,
      currency: 'USD',
      redeemedAt: new Date(),
    });

    const result = await service.recordRedemption({
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_dup',
      valueAppliedMinor: 3980,
      currency: 'USD',
      kind: 'percent_off',
      tx: prisma.asTx(),
    });
    expect(result.ok).toBe(false);

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_redemption_total\{[^}]*outcome="redemption_conflict"[^}]*\} 1/);
  });

  it('counts a freshly-created Stripe coupon with outcome="ok"', async () => {
    const { service, prisma } = buildSvcWithMetrics(new CouponMetrics());
    seedCoupon(prisma);

    const result = await service.ensureStripeCoupon('cpn_test');
    expect(result.ok).toBe(true);

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(
      /coupon_operation_duration_seconds_count\{[^}]*operation="ensure_stripe_coupon"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a cached Stripe coupon with outcome="cached"', async () => {
    const { service, prisma, stripe } = buildSvcWithMetrics(new CouponMetrics());
    seedCoupon(prisma, { stripeCouponId: 'coupon_already_there' });

    const result = await service.ensureStripeCoupon('cpn_test');
    expect(result.ok).toBe(true);
    expect(stripe.coupons.create).not.toHaveBeenCalled();

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="cached"[^}]*\} 1/);
  });

  it('counts an extended_trial skip with outcome="skipped_trial"', async () => {
    const { service, prisma } = buildSvcWithMetrics(new CouponMetrics());
    seedCoupon(prisma, { kind: 'extended_trial', amount: 14 });

    const result = await service.ensureStripeCoupon('cpn_test');
    expect(result.ok).toBe(true);

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="skipped_trial"[^}]*\} 1/);
  });

  it('counts a Stripe failure with outcome="stripe_unavailable"', async () => {
    const { service, prisma, stripe } = buildSvcWithMetrics(new CouponMetrics());
    seedCoupon(prisma);
    stripe.coupons.create.mockRejectedValueOnce(new Error('stripe down'));

    const result = await service.ensureStripeCoupon('cpn_test');
    expect(result.ok).toBe(false);

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="stripe_unavailable"[^}]*\} 1/);
  });

  it('never leaks a coupon code / customer / Stripe id onto the scrape surface', async () => {
    const { service, prisma } = buildSvcWithMetrics(new CouponMetrics());
    seedCoupon(prisma);

    await service.recordRedemption({
      couponId: 'cpn_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      subscriptionId: 'sub_metrics_leak',
      valueAppliedMinor: 3980,
      currency: 'USD',
      kind: 'percent_off',
      tx: prisma.asTx(),
    });
    await service.ensureStripeCoupon('cpn_test');

    const out = await serializeMetrics();
    expect(out).not.toContain('cpn_test');
    expect(out).not.toContain('hh_123');
    expect(out).not.toContain('coupon_stripe_xyz');
    expect(out).toMatch(/coupon_redemption_total/);
    expect(out).toMatch(/coupon_stripe_ensure_total/);
  });
});
