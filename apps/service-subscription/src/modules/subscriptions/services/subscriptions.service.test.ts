import { SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_CANCELED } from '@taste-and-see/contracts';
import { OutboxService } from '@taste-and-see/nest-outbox';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import { CouponsService, type ValidatedCoupon } from '../../coupons/services/coupons.service';
import { err, ok } from '../result';

import { StripeCustomerService } from './stripe-customer.service';
import { SubscriptionsService } from './subscriptions.service';

interface FakePlanRow {
  id: string;
  code: string;
  name: string;
  customerGroup: 'family' | 'provider' | 'academy';
  monthlyPrice: Decimal;
  annualPrice: Decimal;
  currency: string;
  active: boolean;
  stripeProductId: string | null;
}

interface FakeSubscriptionRow {
  id: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  planId: string;
  status: string;
  billingInterval: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelReason: string | null;
  canceledAt: Date | null;
  /** TS-042 dunning + pause columns — see schema doc-comments. */
  dunningAttempts: number;
  dunningLastAttemptAt: Date | null;
  dunningGraceUntil: Date | null;
  pauseCollectionStartedAt: Date | null;
  pauseCollectionResumesAt: Date | null;
  pauseReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeHistoryRow {
  id: string;
  subscriptionId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  context: unknown;
  actorUserId: string | null;
  actorKind: string;
  source: string | null;
  occurredAt: Date;
}

interface FakePaymentMethodRow {
  id: string;
  stripePaymentMethodId: string;
  stripeCustomerId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  kind: 'card' | 'bank_account';
  isDefault: boolean;
}

/**
 * In-memory Prisma stand-in that mirrors the surface SubscriptionsService
 * touches: plan.findUnique / update; subscription.findUnique / create /
 * update; subscriptionHistory.create; paymentMethod.upsert; and a
 * single-call $transaction that runs the callback against `this`.
 */
class FakePrisma {
  public plans: FakePlanRow[] = [];
  public subscriptions: FakeSubscriptionRow[] = [];
  public histories: FakeHistoryRow[] = [];
  public paymentMethods: FakePaymentMethodRow[] = [];
  private idCounter = 0;

  plan = {
    findUnique: vi.fn(async (args: { where: { id: string } }): Promise<FakePlanRow | null> => {
      return this.plans.find((p) => p.id === args.where.id) ?? null;
    }),
    update: vi.fn(
      async (args: { where: { id: string }; data: Partial<FakePlanRow> }): Promise<FakePlanRow> => {
        const idx = this.plans.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error(`plan ${args.where.id} not found in fake`);
        const next = { ...this.plans[idx]!, ...args.data } as FakePlanRow;
        this.plans[idx] = next;
        return next;
      },
    ),
  };

  subscription = {
    findUnique: vi.fn(
      async (args: {
        where: { id: string };
        include?: { plan?: boolean };
      }): Promise<(FakeSubscriptionRow & { plan?: FakePlanRow }) | null> => {
        const sub = this.subscriptions.find((s) => s.id === args.where.id);
        if (sub === undefined) return null;
        if (args.include?.plan === true) {
          const plan = this.plans.find((p) => p.id === sub.planId);
          if (plan === undefined) {
            throw new Error(`plan ${sub.planId} missing for subscription ${sub.id}`);
          }
          return { ...sub, plan };
        }
        return sub;
      },
    ),
    /**
     * Used by `StripeCustomerService.findExistingStripeCustomerId` to
     * look up any existing subscription for a `(customerId, customerGroup)`
     * tuple. Mirrors Prisma's `findFirst({ where, select, orderBy })`
     * shape — sorts by createdAt DESC (the production query) and returns
     * the most-recent matching row.
     */
    findFirst: vi.fn(
      async (args: {
        where: { customerId: string; customerGroup: string };
      }): Promise<{ stripeCustomerId: string } | null> => {
        const matches = this.subscriptions
          .filter(
            (s) =>
              s.customerId === args.where.customerId &&
              s.customerGroup === args.where.customerGroup,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const first = matches[0];
        if (first === undefined) return null;
        return { stripeCustomerId: first.stripeCustomerId };
      },
    ),
    create: vi.fn(
      async (args: { data: Partial<FakeSubscriptionRow> }): Promise<FakeSubscriptionRow> => {
        this.idCounter += 1;
        const row: FakeSubscriptionRow = {
          id: `sub_internal_${this.idCounter}`,
          createdAt: new Date('2026-05-10T00:00:00.000Z'),
          updatedAt: new Date('2026-05-10T00:00:00.000Z'),
          cancelAtPeriodEnd: false,
          cancelReason: null,
          canceledAt: null,
          dunningAttempts: 0,
          dunningLastAttemptAt: null,
          dunningGraceUntil: null,
          pauseCollectionStartedAt: null,
          pauseCollectionResumesAt: null,
          pauseReason: null,
          ...args.data,
        } as FakeSubscriptionRow;
        this.subscriptions.push(row);
        return row;
      },
    ),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: Partial<FakeSubscriptionRow>;
      }): Promise<FakeSubscriptionRow> => {
        const idx = this.subscriptions.findIndex((s) => s.id === args.where.id);
        if (idx === -1) throw new Error(`sub ${args.where.id} not found in fake`);
        const next: FakeSubscriptionRow = { ...this.subscriptions[idx]!, ...args.data };
        this.subscriptions[idx] = next;
        return next;
      },
    ),
  };

  subscriptionHistory = {
    create: vi.fn(
      async (args: {
        data: Omit<FakeHistoryRow, 'id' | 'occurredAt' | 'source'> & { source?: string };
      }): Promise<FakeHistoryRow> => {
        this.idCounter += 1;
        const row: FakeHistoryRow = {
          id: `hist_${this.idCounter}`,
          occurredAt: new Date('2026-05-10T00:00:00.000Z'),
          source: null,
          ...args.data,
        } as FakeHistoryRow;
        this.histories.push(row);
        return row;
      },
    ),
  };

  paymentMethod = {
    /**
     * Same shape as `subscription.findFirst` — used by
     * StripeCustomerService when no subscription row exists for the
     * (customerId, customerGroup) tuple.
     */
    findFirst: vi.fn(
      async (args: {
        where: { customerId: string; customerGroup: string };
      }): Promise<{ stripeCustomerId: string } | null> => {
        const matches = this.paymentMethods.filter(
          (p) =>
            p.customerId === args.where.customerId && p.customerGroup === args.where.customerGroup,
        );
        const first = matches[0];
        if (first === undefined) return null;
        return { stripeCustomerId: first.stripeCustomerId };
      },
    ),
    upsert: vi.fn(
      async (args: {
        where: { stripePaymentMethodId: string };
        create: Omit<FakePaymentMethodRow, 'id'>;
        update: Partial<FakePaymentMethodRow>;
      }): Promise<FakePaymentMethodRow> => {
        const idx = this.paymentMethods.findIndex(
          (p) => p.stripePaymentMethodId === args.where.stripePaymentMethodId,
        );
        if (idx === -1) {
          this.idCounter += 1;
          const next: FakePaymentMethodRow = {
            id: `pm_internal_${this.idCounter}`,
            ...args.create,
          };
          this.paymentMethods.push(next);
          return next;
        }
        const next: FakePaymentMethodRow = { ...this.paymentMethods[idx]!, ...args.update };
        this.paymentMethods[idx] = next;
        return next;
      },
    ),
  };

  $transaction = vi.fn(async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    // Pass `this` as the transaction client — the same model methods
    // exist on the outer client + the inner tx in real Prisma.
    return fn(this as unknown as PrismaTransactionClient);
  });
}

interface FakeStripe {
  customers: { create: ReturnType<typeof vi.fn> };
  paymentMethods: { attach: ReturnType<typeof vi.fn> };
  products: { create: ReturnType<typeof vi.fn> };
  subscriptions: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
  };
}

function buildStripe(): FakeStripe {
  return {
    customers: { create: vi.fn() },
    paymentMethods: { attach: vi.fn() },
    products: { create: vi.fn() },
    subscriptions: {
      create: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
      retrieve: vi.fn(),
    },
  };
}

function buildStripeSubscription(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: 'sub_stripe_xyz',
    status: 'active',
    current_period_start: 1_715_904_000, // 2024-05-17 UTC
    current_period_end: 1_718_582_400, // 2024-06-17 UTC
    trial_end: null,
    canceled_at: null,
    cancel_at_period_end: false,
    items: {
      data: [{ id: 'si_first' } as Stripe.SubscriptionItem],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

/**
 * Stub CouponsService — the SubscriptionsService unit tests don't
 * exercise the coupon flow by default (those tests live in
 * coupons.service.test.ts). Tests that DO supply a `couponCode`
 * override the stub methods inline. The throws guard against an
 * accidental invocation in tests that don't expect coupon traffic.
 */
class StubCouponsService {
  public validate = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('StubCouponsService.validate not configured');
  });
  public ensureStripeCoupon = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('StubCouponsService.ensureStripeCoupon not configured');
  });
  public recordRedemption = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('StubCouponsService.recordRedemption not configured');
  });
}

/**
 * TS-142-followup-9 — Fake OutboxService. Records every `append` call so
 * tests can assert the event name + payload shape. The
 * `nextResultOverride` slot lets a single test force the next append to
 * surface `validation_failed`, exercising the transaction-rollback path
 * in the service. Mirrors the FakeOutboxService used in
 * apps/service-booking — same shape, same semantics.
 */
class FakeOutboxService {
  public appendCalls: Array<{
    tx: unknown;
    args: {
      eventName: string;
      payload: unknown;
      eventId?: string;
      occurredAt?: Date;
    };
  }> = [];
  public nextResultOverride: 'validation_failed' | null = null;

  append = vi.fn(
    async (
      tx: unknown,
      args: {
        eventName: string;
        payload: unknown;
        eventId?: string;
        occurredAt?: Date;
      },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      this.appendCalls.push({ tx, args });
      if (this.nextResultOverride === 'validation_failed') {
        this.nextResultOverride = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: ['payload'], message: 'forced failure' }],
        };
      }
      return {
        kind: 'appended',
        eventId: args.eventId ?? `evt_${args.eventName}_fake`,
        eventName: args.eventName,
        occurredAt: args.occurredAt ?? new Date('2026-05-13T12:00:00.000Z'),
      };
    },
  );
}

function buildSvc(): {
  service: SubscriptionsService;
  prisma: FakePrisma;
  stripe: FakeStripe;
  coupons: StubCouponsService;
  outbox: FakeOutboxService;
} {
  const prisma = new FakePrisma();
  const stripe = buildStripe();
  // Construct StripeCustomerService against the same fake stripe + prisma.
  const customerService = new StripeCustomerService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
  );
  // Make customer create predictable for tests that touch Stripe customer flow.
  stripe.customers.create.mockResolvedValue({ id: 'cus_default_test' });
  // Make products.create predictable too (lazy product creation).
  stripe.products.create.mockResolvedValue({ id: 'prod_default_test' });
  // Default attach success.
  stripe.paymentMethods.attach.mockResolvedValue({ id: 'pm_attached' });
  const coupons = new StubCouponsService();
  const outbox = new FakeOutboxService();
  const service = new SubscriptionsService(
    prisma as unknown as PrismaService,
    customerService,
    stripe as unknown as Stripe,
    coupons as unknown as CouponsService,
    outbox as unknown as OutboxService,
  );
  return { service, prisma, stripe, coupons, outbox };
}

function seedPlan(prisma: FakePrisma, overrides: Partial<FakePlanRow> = {}): FakePlanRow {
  const plan: FakePlanRow = {
    id: 'plan_companion',
    code: 'family.tier2',
    name: 'Companion Dining',
    customerGroup: 'family',
    monthlyPrice: new Decimal('199.00'),
    annualPrice: new Decimal('1990.00'),
    currency: 'USD',
    active: true,
    stripeProductId: null,
    ...overrides,
  };
  prisma.plans.push(plan);
  return plan;
}

const validCreateRequest = {
  planId: 'plan_companion',
  customerId: 'hh_123',
  customerGroup: 'family',
  billingInterval: 'monthly',
  paymentMethodId: 'pm_card_visa',
  customerEmail: 'parent@example.com',
} as const;

// ─────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────

describe('SubscriptionsService.create', () => {
  it('creates a subscription end-to-end (customer → product → subscription → row + history)', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stripeSubscriptionId).toBe('sub_stripe_xyz');
    expect(result.value.status).toBe('active');
    expect(result.value.unitPriceUsdMinor).toBe(19900);
    expect(result.value.planCode).toBe('family.tier2');
    expect(result.value.cancelAtPeriodEnd).toBe(false);
    expect(prisma.subscriptions).toHaveLength(1);
    expect(prisma.histories).toHaveLength(1);
    const [history] = prisma.histories;
    expect(history?.event).toBe('created');
    expect(history?.actorUserId).toBe('usr_payer');
    expect(history?.actorKind).toBe('user');
  });

  it('returns plan_not_found when the plan id does not resolve', async () => {
    const { service, stripe } = buildSvc();
    // No plan seeded.
    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('plan_not_found');
    }
    expect(stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it('returns plan_inactive when the plan is retired', async () => {
    const { service, prisma } = buildSvc();
    seedPlan(prisma, { active: false });
    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('plan_inactive');
    }
  });

  it('returns plan_group_mismatch when customerGroup disagrees with the plan', async () => {
    const { service, prisma } = buildSvc();
    seedPlan(prisma, { customerGroup: 'provider' });
    const result = await service.create({
      request: { ...validCreateRequest, customerGroup: 'family' },
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.reason === 'plan_group_mismatch') {
      expect(result.error.expected).toBe('family');
      expect(result.error.actual).toBe('provider');
    } else {
      throw new Error('expected plan_group_mismatch');
    }
  });

  it('lazy-creates a Stripe Product on first use and caches it on the plan row', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());
    stripe.products.create.mockResolvedValue({ id: 'prod_lazy_xyz' });

    await service.create({ request: validCreateRequest, requesterUserId: 'usr' });

    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(prisma.plans[0]?.stripeProductId).toBe('prod_lazy_xyz');
    // The subscription create call carried the product id in the price_data.
    const subCreateArgs = stripe.subscriptions.create.mock.calls[0]?.[0];
    expect(subCreateArgs?.items?.[0]?.price_data?.product).toBe('prod_lazy_xyz');
  });

  it('reuses the cached Stripe Product when one is already set on the plan', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma, { stripeProductId: 'prod_already_seeded' });
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    await service.create({ request: validCreateRequest, requesterUserId: 'usr' });

    expect(stripe.products.create).not.toHaveBeenCalled();
    const subCreateArgs = stripe.subscriptions.create.mock.calls[0]?.[0];
    expect(subCreateArgs?.items?.[0]?.price_data?.product).toBe('prod_already_seeded');
  });

  it('passes annualPrice when billingInterval is annual', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    await service.create({
      request: { ...validCreateRequest, billingInterval: 'annual' },
      requesterUserId: 'usr',
    });

    const subCreateArgs = stripe.subscriptions.create.mock.calls[0]?.[0];
    // annual price = 1990.00 → 199000 minor units
    expect(subCreateArgs?.items?.[0]?.price_data?.unit_amount).toBe(199000);
    expect(subCreateArgs?.items?.[0]?.price_data?.recurring?.interval).toBe('year');
  });

  it('attaches the payment method when one is supplied', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    await service.create({ request: validCreateRequest, requesterUserId: 'usr' });

    expect(stripe.paymentMethods.attach).toHaveBeenCalledWith(
      'pm_card_visa',
      { customer: 'cus_default_test' },
      expect.any(Object),
    );
    expect(prisma.paymentMethods).toHaveLength(1);
    expect(prisma.paymentMethods[0]?.isDefault).toBe(true);
  });

  it('treats an "already been attached" Stripe error as success on payment-method attach', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.paymentMethods.attach.mockRejectedValue(
      new Error('The payment method has already been attached to a customer'),
    );
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr',
    });

    expect(result.ok).toBe(true);
  });

  it('returns stripe_unavailable when subscription create throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockRejectedValue(new Error('rate limited'));

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('stripe_unavailable');
    }
    expect(prisma.subscriptions).toHaveLength(0);
    expect(prisma.histories).toHaveLength(0);
  });

  it('forwards the idempotencyKey with phase suffixes to each Stripe call', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr',
      idempotencyKey: 'idem-12345-abcdef',
    });

    const customerOpts = stripe.customers.create.mock.calls[0]?.[1];
    expect(customerOpts?.idempotencyKey).toBe('idem-12345-abcdef:cust');
    const subOpts = stripe.subscriptions.create.mock.calls[0]?.[1];
    expect(subOpts?.idempotencyKey).toBe('idem-12345-abcdef:sub');
    const attachOpts = stripe.paymentMethods.attach.mock.calls[0]?.[2];
    expect(attachOpts?.idempotencyKey).toBe('idem-12345-abcdef:pm-attach');
  });

  it('passes trial_period_days to Stripe when trialDays > 0', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(
      buildStripeSubscription({
        status: 'trialing',
        trial_end: 1_716_508_800,
      }),
    );

    const trialReq = { ...validCreateRequest, trialDays: 14 };
    const result = await service.create({ request: trialReq, requesterUserId: 'usr' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('trialing');
      expect(result.value.trialEnd).toBe(new Date(1_716_508_800 * 1000).toISOString());
    }
    const subCreateArgs = stripe.subscriptions.create.mock.calls[0]?.[0];
    expect(subCreateArgs?.trial_period_days).toBe(14);
  });

  it('attaches platform metadata to the Stripe subscription so audit trails can trace back', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_xyz',
    });

    const args = stripe.subscriptions.create.mock.calls[0]?.[0];
    expect(args?.metadata).toMatchObject({
      platform_plan_id: 'plan_companion',
      platform_customer_id: 'hh_123',
      customer_group: 'family',
      requester_user_id: 'usr_xyz',
    });
  });

  it('does NOT pass payment method when neither paymentMethodId nor trialDays is set (still rejected upstream by contract refine, but service is defensive)', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    const noPaymentReq = {
      planId: 'plan_companion',
      customerId: 'hh_123',
      customerGroup: 'family' as const,
      billingInterval: 'monthly' as const,
      customerEmail: 'parent@example.com',
    };
    // The contract layer rejects this via .refine() — but the service
    // itself should not crash if it ever does receive one.
    const result = await service.create({
      request: noPaymentReq,
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(true);
    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled();
  });

  // TS-043 — coupon-applied path.

  it('validates the coupon, attaches a Stripe coupon, and records the redemption (percent_off)', async () => {
    const { service, prisma, stripe, coupons } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    const validatedCoupon: ValidatedCoupon = {
      id: 'cpn_20off',
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
    coupons.validate.mockResolvedValue(ok(validatedCoupon));
    coupons.ensureStripeCoupon.mockResolvedValue(ok('coupon_stripe_xyz'));
    coupons.recordRedemption.mockResolvedValue(ok({ redemptionId: 'rdm_1' }));

    const result = await service.create({
      request: { ...validCreateRequest, couponCode: 'PROMO20' },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    expect(coupons.validate).toHaveBeenCalledTimes(1);
    expect(coupons.ensureStripeCoupon).toHaveBeenCalledTimes(1);
    expect(coupons.recordRedemption).toHaveBeenCalledTimes(1);
    const subArgs = stripe.subscriptions.create.mock.calls[0]?.[0];
    expect(subArgs?.discounts).toEqual([{ coupon: 'coupon_stripe_xyz' }]);
  });

  it('stacks extended_trial days on top of caller-supplied trialDays', async () => {
    const { service, prisma, stripe, coupons } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(
      buildStripeSubscription({ status: 'trialing', trial_end: 1_716_508_800 }),
    );

    coupons.validate.mockResolvedValue(
      ok({
        id: 'cpn_extra_trial',
        code: 'EXTRATRIAL',
        name: 'Extra 14 day trial',
        kind: 'extended_trial',
        amount: 14,
        currency: 'USD',
        duration: 'once',
        durationInMonths: null,
        stackable: false,
        stripeCouponId: null,
        valueAppliedMinor: 0,
        extendedTrialDays: 14,
      } satisfies ValidatedCoupon),
    );
    coupons.recordRedemption.mockResolvedValue(ok({ redemptionId: 'rdm_trial' }));

    const result = await service.create({
      request: { ...validCreateRequest, couponCode: 'EXTRATRIAL', trialDays: 7 },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    // 14 (coupon) + 7 (caller) = 21
    const subArgs = stripe.subscriptions.create.mock.calls[0]?.[0];
    expect(subArgs?.trial_period_days).toBe(21);
    // No Stripe coupon for extended_trial.
    expect(coupons.ensureStripeCoupon).not.toHaveBeenCalled();
    expect(subArgs?.discounts).toBeUndefined();
  });

  it('returns coupon_invalid when the validation gate rejects', async () => {
    const { service, prisma, stripe, coupons } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    coupons.validate.mockResolvedValue(
      err({ reason: 'coupon_expired', couponId: 'cpn_x', expiresAt: new Date() }),
    );

    const result = await service.create({
      request: { ...validCreateRequest, couponCode: 'EXPIRED' },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('coupon_invalid');
    if (result.error.reason !== 'coupon_invalid') return;
    expect(result.error.failureReason).toBe('coupon_expired');
    // The Stripe subscription must NOT have been created.
    expect(stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it('rolls back the subscription when redemption persistence fails', async () => {
    const { service, prisma, stripe, coupons } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    coupons.validate.mockResolvedValue(
      ok({
        id: 'cpn_y',
        code: 'PROMO',
        name: 'Promo',
        kind: 'percent_off',
        amount: 10,
        currency: 'USD',
        duration: 'once',
        durationInMonths: null,
        stackable: false,
        stripeCouponId: null,
        valueAppliedMinor: 1000,
        extendedTrialDays: null,
      } satisfies ValidatedCoupon),
    );
    coupons.ensureStripeCoupon.mockResolvedValue(ok('coupon_xyz'));
    coupons.recordRedemption.mockResolvedValue(
      err({
        reason: 'redemption_conflict',
        couponId: 'cpn_y',
        subscriptionId: 'sub_internal_1',
      }),
    );

    // Wrap the test in an expectation that the create throws or
    // surfaces a failure — the redemption_conflict is signalled via
    // a throw inside the transaction, so the outer create call
    // returns the surfaced error or throws.
    await expect(
      service.create({
        request: { ...validCreateRequest, couponCode: 'RACE' },
        requesterUserId: 'usr_payer',
      }),
    ).rejects.toThrow(/coupon redemption failed/);

    // No subscription row should have been persisted (transaction
    // aborted via the throw).
    // The Fake `$transaction` doesn't actually roll back inserts in
    // the in-memory data, but it propagates the throw — so the test
    // verifies the throw shape; an integration test against real
    // Postgres (TS-009e) is what proves the actual rollback. For the
    // unit test we ASSERT the failure was surfaced.
  });

  // TS-142-followup-9 — outbox emission for `subscription.activated`.

  it('appends subscription.activated through the outbox inside the transaction', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(true);
    expect(outbox.append).toHaveBeenCalledTimes(1);
    const call = outbox.appendCalls[0];
    expect(call?.args.eventName).toBe(SUBSCRIPTION_ACTIVATED);
    expect(call?.tx).toBeDefined(); // tx came from inside the $transaction callback
  });

  it('builds a subscription.activated payload mirroring the registry schema (envelope + identifiers + period)', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });
    if (!result.ok) throw new Error('create returned !ok');
    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['subscriptionId']).toBe(result.value.id);
    expect(payload['customerId']).toBe('hh_123');
    expect(payload['customerGroup']).toBe('family');
    expect(payload['planCode']).toBe('family.tier2');
    expect(payload['periodStart']).toBe(new Date(1_715_904_000 * 1000).toISOString());
    expect(payload['periodEnd']).toBe(new Date(1_718_582_400 * 1000).toISOString());
    // envelope: eventId is the subscription-row-derived deterministic key
    expect(payload['eventId']).toBe(`${result.value.id}.activated`);
    expect(typeof payload['occurredAt']).toBe('string');
    // TS-142-followup-2-followup-2 — activation amount + currency
    expect(payload['amountMinor']).toBe(19_900); // $199.00 monthly = 19,900 cents
    expect(payload['currency']).toBe('USD');
  });

  it('uses a deterministic eventId derived from the subscription id so retries collapse idempotently', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());

    await service.create({ request: validCreateRequest, requesterUserId: 'usr_payer' });

    const call = outbox.appendCalls[0];
    expect(call?.args.eventId).toMatch(/\.activated$/);
  });

  it('returns outbox_validation_failed when the outbox rejects the payload (tx rolls back)', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedPlan(prisma);
    stripe.subscriptions.create.mockResolvedValue(buildStripeSubscription());
    outbox.nextResultOverride = 'validation_failed';

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    if (result.error.reason !== 'outbox_validation_failed') return;
    expect(result.error.eventName).toBe(SUBSCRIPTION_ACTIVATED);
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────

describe('SubscriptionsService.patch', () => {
  function seedExistingSubscription(prisma: FakePrisma): {
    plan: FakePlanRow;
    sub: FakeSubscriptionRow;
  } {
    const plan = seedPlan(prisma, { stripeProductId: 'prod_existing' });
    const sub: FakeSubscriptionRow = {
      id: 'sub_internal_existing',
      stripeSubscriptionId: 'sub_stripe_existing',
      stripeCustomerId: 'cus_existing',
      customerId: 'hh_123',
      customerGroup: 'family',
      planId: plan.id,
      status: 'active',
      billingInterval: 'monthly',
      currentPeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-01T00:00:00.000Z'),
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
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    };
    prisma.subscriptions.push(sub);
    return { plan, sub };
  }

  it('returns subscription_not_found when the id is unknown', async () => {
    const { service } = buildSvc();
    const result = await service.patch({
      subscriptionId: 'sub_unknown',
      request: { paymentMethodId: 'pm_new' },
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('subscription_not_found');
    }
  });

  it('updates the payment method on a paymentMethodId-only patch', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({ id: 'sub_stripe_existing' }),
    );

    const result = await service.patch({
      subscriptionId: 'sub_internal_existing',
      request: { paymentMethodId: 'pm_new_method' },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    expect(stripe.paymentMethods.attach).toHaveBeenCalledWith(
      'pm_new_method',
      { customer: 'cus_existing' },
      expect.any(Object),
    );
    const updateArgs = stripe.subscriptions.update.mock.calls[0]?.[1];
    expect(updateArgs?.default_payment_method).toBe('pm_new_method');
    expect(prisma.histories.some((h) => h.event === 'payment_method_changed')).toBe(true);
  });

  it('switches the plan and emits a plan_changed history entry', async () => {
    const { service, prisma, stripe } = buildSvc();
    const { sub } = seedExistingSubscription(prisma);
    void sub;
    seedPlan(prisma, {
      id: 'plan_concierge',
      code: 'family.tier3',
      name: 'Concierge Lifestyle',
      monthlyPrice: new Decimal('1000.00'),
      annualPrice: new Decimal('10000.00'),
      stripeProductId: 'prod_concierge',
    });
    stripe.subscriptions.retrieve.mockResolvedValue(
      buildStripeSubscription({ id: 'sub_stripe_existing' }),
    );
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({ id: 'sub_stripe_existing' }),
    );

    const result = await service.patch({
      subscriptionId: 'sub_internal_existing',
      request: { planId: 'plan_concierge' },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.planId).toBe('plan_concierge');
      expect(result.value.planCode).toBe('family.tier3');
      expect(result.value.unitPriceUsdMinor).toBe(100000);
    }
    const planChangedHist = prisma.histories.find((h) => h.event === 'plan_changed');
    expect(planChangedHist).toBeDefined();
  });

  it('rejects a plan switch when the new plan customerGroup differs from the existing subscription', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedExistingSubscription(prisma);
    seedPlan(prisma, {
      id: 'plan_provider_basic',
      code: 'provider.basic',
      customerGroup: 'provider',
    });

    const result = await service.patch({
      subscriptionId: 'sub_internal_existing',
      request: { planId: 'plan_provider_basic' },
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('plan_group_mismatch');
    }
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('returns stripe_unavailable when Stripe update throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockRejectedValue(new Error('rate limited'));

    const result = await service.patch({
      subscriptionId: 'sub_internal_existing',
      request: { paymentMethodId: 'pm_new' },
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('stripe_unavailable');
    }
  });

  it('treats a no-op planId (same as current) as a non-mutation', async () => {
    const { service, prisma, stripe } = buildSvc();
    const { sub } = seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({ id: sub.stripeSubscriptionId }),
    );

    await service.patch({
      subscriptionId: sub.id,
      request: { planId: sub.planId, paymentMethodId: 'pm_new' },
      requesterUserId: 'usr',
    });

    // Plan-changed history should NOT fire for an identity update.
    expect(prisma.histories.find((h) => h.event === 'plan_changed')).toBeUndefined();
    expect(prisma.histories.some((h) => h.event === 'payment_method_changed')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CANCEL
// ─────────────────────────────────────────────────────────────────────────

describe('SubscriptionsService.cancel', () => {
  function seedExistingSubscription(
    prisma: FakePrisma,
    overrides: Partial<FakeSubscriptionRow> = {},
  ): FakeSubscriptionRow {
    const plan = seedPlan(prisma, { stripeProductId: 'prod_existing' });
    const sub: FakeSubscriptionRow = {
      id: 'sub_internal_existing',
      stripeSubscriptionId: 'sub_stripe_existing',
      stripeCustomerId: 'cus_existing',
      customerId: 'hh_123',
      customerGroup: 'family',
      planId: plan.id,
      status: 'active',
      billingInterval: 'monthly',
      currentPeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-01T00:00:00.000Z'),
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
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
      ...overrides,
    };
    prisma.subscriptions.push(sub);
    return sub;
  }

  it('returns subscription_not_found for unknown id', async () => {
    const { service } = buildSvc();
    const result = await service.cancel({
      subscriptionId: 'sub_missing',
      request: { cancelAtPeriodEnd: true, reason: 'customer_request' },
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('subscription_not_found');
    }
  });

  it('rejects with subscription_already_canceled when status is canceled', async () => {
    const { service, prisma } = buildSvc();
    seedExistingSubscription(prisma, { status: 'canceled' });
    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: true, reason: 'customer_request' },
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('subscription_already_canceled');
    }
  });

  it('cancels at period end via update + emits canceled history', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({
        id: 'sub_stripe_existing',
        status: 'active',
        cancel_at_period_end: true,
        canceled_at: 1_715_904_000,
      }),
    );

    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: true, reason: 'customer_request', note: 'churn-test' },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cancelAtPeriodEnd).toBe(true);
      expect(result.value.cancelReason).toBe('customer_request');
      expect(result.value.canceledAt).toBe(new Date(1_715_904_000 * 1000).toISOString());
    }
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_stripe_existing',
      { cancel_at_period_end: true },
      expect.any(Object),
    );
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    const canceledHist = prisma.histories.find((h) => h.event === 'canceled');
    expect(canceledHist).toBeDefined();
    expect(canceledHist?.context).toMatchObject({
      cancelAtPeriodEnd: true,
      reason: 'customer_request',
      note: 'churn-test',
    });
  });

  it('immediate-cancel calls Stripe cancel + flips status to canceled', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.cancel.mockResolvedValue(
      buildStripeSubscription({
        id: 'sub_stripe_existing',
        status: 'canceled',
        cancel_at_period_end: false,
        canceled_at: 1_715_904_000,
      }),
    );

    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: false, reason: 'admin_action' },
      requesterUserId: 'usr_admin',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('canceled');
      expect(result.value.cancelAtPeriodEnd).toBe(false);
    }
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      'sub_stripe_existing',
      {},
      expect.any(Object),
    );
  });

  it('returns stripe_unavailable when Stripe cancel throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockRejectedValue(new Error('network down'));

    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: true, reason: 'customer_request' },
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('stripe_unavailable');
    }
  });

  it('forwards the idempotencyKey to Stripe cancel call with phase suffix', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({ id: 'sub_stripe_existing', cancel_at_period_end: true }),
    );

    await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: true, reason: 'customer_request' },
      requesterUserId: 'usr',
      idempotencyKey: 'idem-cancel-test-123',
    });

    const updateOpts = stripe.subscriptions.update.mock.calls[0]?.[2];
    expect(updateOpts?.idempotencyKey).toBe('idem-cancel-test-123:cancel-eop');
  });

  // TS-142-followup-9 — outbox emission for `subscription.canceled`.

  it('appends subscription.canceled through the outbox inside the transaction', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({
        id: 'sub_stripe_existing',
        cancel_at_period_end: true,
        canceled_at: 1_715_904_000,
      }),
    );

    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: true, reason: 'customer_request' },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    expect(outbox.append).toHaveBeenCalledTimes(1);
    const call = outbox.appendCalls[0];
    expect(call?.args.eventName).toBe(SUBSCRIPTION_CANCELED);
    expect(call?.tx).toBeDefined();
  });

  it('builds a subscription.canceled payload with the categorical reason + effectiveAt at period end', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({
        id: 'sub_stripe_existing',
        cancel_at_period_end: true,
        canceled_at: 1_715_904_000,
        current_period_end: 1_718_582_400, // 2024-06-17 — the effective date for at-period-end
      }),
    );

    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: true, reason: 'admin_action' },
      requesterUserId: 'usr_admin',
    });

    if (!result.ok) throw new Error('cancel returned !ok');
    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['subscriptionId']).toBe('sub_internal_existing');
    expect(payload['customerId']).toBe('hh_123');
    expect(payload['reason']).toBe('admin_action');
    // at-period-end → effectiveAt mirrors current_period_end
    expect(payload['effectiveAt']).toBe(new Date(1_718_582_400 * 1000).toISOString());
    expect(payload['occurredAt']).toBe(new Date(1_715_904_000 * 1000).toISOString());
    expect(payload['eventId']).toBe(`sub_internal_existing.canceled.${1_715_904_000 * 1000}`);
  });

  it('immediate-cancel emits subscription.canceled with effectiveAt = canceledAt', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.cancel.mockResolvedValue(
      buildStripeSubscription({
        id: 'sub_stripe_existing',
        status: 'canceled',
        cancel_at_period_end: false,
        canceled_at: 1_715_904_000,
      }),
    );

    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: false, reason: 'fraud' },
      requesterUserId: 'usr_admin',
    });

    expect(result.ok).toBe(true);
    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['reason']).toBe('fraud');
    // immediate cancel → effectiveAt mirrors the canceledAt
    expect(payload['effectiveAt']).toBe(new Date(1_715_904_000 * 1000).toISOString());
  });

  it('returns outbox_validation_failed when the canceled-event payload is rejected', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedExistingSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({
        id: 'sub_stripe_existing',
        cancel_at_period_end: true,
        canceled_at: 1_715_904_000,
      }),
    );
    outbox.nextResultOverride = 'validation_failed';

    const result = await service.cancel({
      subscriptionId: 'sub_internal_existing',
      request: { cancelAtPeriodEnd: true, reason: 'customer_request' },
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    if (result.error.reason !== 'outbox_validation_failed') return;
    expect(result.error.eventName).toBe(SUBSCRIPTION_CANCELED);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Result helper sanity check (small but referenced by every service path).
// ─────────────────────────────────────────────────────────────────────────

describe('Result helpers', () => {
  it('ok wraps a value', () => {
    const r = ok('x');
    expect(r).toEqual({ ok: true, value: 'x' });
  });
});
