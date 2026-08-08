import { SUBSCRIPTION_ACTIVATED } from '@taste-and-see/contracts';
import { OutboxService } from '@taste-and-see/nest-outbox';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import { CouponsService } from '../../coupons/services/coupons.service';
import { StripeCustomerService } from '../../subscriptions/services/stripe-customer.service';

import { CheckoutSessionsService } from './checkout-sessions.service';

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

class FakePrisma {
  public plans: FakePlanRow[] = [];
  public subscriptions: FakeSubscriptionRow[] = [];
  public histories: FakeHistoryRow[] = [];
  private idCounter = 0;

  plan = {
    findUnique: vi.fn(async (args: { where: { id: string } }): Promise<FakePlanRow | null> => {
      return this.plans.find((p) => p.id === args.where.id) ?? null;
    }),
    update: vi.fn(
      async (args: { where: { id: string }; data: Partial<FakePlanRow> }): Promise<FakePlanRow> => {
        const idx = this.plans.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error(`plan ${args.where.id} not found`);
        const next = { ...this.plans[idx]!, ...args.data } as FakePlanRow;
        this.plans[idx] = next;
        return next;
      },
    ),
  };

  subscription = {
    findUnique: vi.fn(
      async (args: {
        where: { id?: string; stripeSubscriptionId?: string };
        include?: { plan?: boolean };
        select?: Record<string, boolean>;
      }): Promise<(FakeSubscriptionRow & { plan?: FakePlanRow }) | null> => {
        const sub = this.subscriptions.find(
          (s) =>
            (args.where.id !== undefined && s.id === args.where.id) ||
            (args.where.stripeSubscriptionId !== undefined &&
              s.stripeSubscriptionId === args.where.stripeSubscriptionId),
        );
        if (sub === undefined) return null;
        if (args.include?.plan === true) {
          const plan = this.plans.find((p) => p.id === sub.planId);
          if (plan === undefined) throw new Error(`plan ${sub.planId} missing`);
          return { ...sub, plan };
        }
        return sub;
      },
    ),
    findFirst: vi.fn(
      async (_args: {
        where: { customerId: string; customerGroup: string };
      }): Promise<{ stripeCustomerId: string } | null> => {
        return null;
      },
    ),
    create: vi.fn(
      async (args: { data: Partial<FakeSubscriptionRow> }): Promise<FakeSubscriptionRow> => {
        this.idCounter += 1;
        const row: FakeSubscriptionRow = {
          id: `sub_internal_${this.idCounter}`,
          createdAt: new Date('2026-05-17T00:00:00.000Z'),
          updatedAt: new Date('2026-05-17T00:00:00.000Z'),
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
  };

  subscriptionHistory = {
    create: vi.fn(
      async (args: {
        data: Omit<FakeHistoryRow, 'id' | 'occurredAt' | 'source'> & { source?: string };
      }): Promise<FakeHistoryRow> => {
        this.idCounter += 1;
        const row: FakeHistoryRow = {
          id: `hist_${this.idCounter}`,
          occurredAt: new Date('2026-05-17T00:00:00.000Z'),
          source: null,
          ...args.data,
        } as FakeHistoryRow;
        this.histories.push(row);
        return row;
      },
    ),
  };

  paymentMethod = {
    findFirst: vi.fn(
      async (_args: {
        where: { customerId: string; customerGroup: string };
      }): Promise<{ stripeCustomerId: string } | null> => {
        return null;
      },
    ),
  };

  $transaction = vi.fn(async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    return fn(this as unknown as PrismaTransactionClient);
  });
}

interface FakeStripe {
  customers: { create: ReturnType<typeof vi.fn> };
  products: { create: ReturnType<typeof vi.fn> };
  checkout: { sessions: { create: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn> } };
  subscriptions: { retrieve: ReturnType<typeof vi.fn> };
}

function buildStripe(): FakeStripe {
  return {
    customers: { create: vi.fn() },
    products: { create: vi.fn() },
    checkout: {
      sessions: { create: vi.fn(), retrieve: vi.fn() },
    },
    subscriptions: { retrieve: vi.fn() },
  };
}

function buildStripeSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: 'cs_test_session',
    url: 'https://checkout.stripe.com/c/pay/cs_test_session',
    expires_at: 1_715_990_400,
    status: 'open',
    mode: 'subscription',
    payment_status: 'unpaid',
    customer: 'cus_test',
    subscription: null,
    metadata: {
      platform_plan_id: 'plan_companion',
      plan_code: 'family.tier2',
      platform_customer_id: 'hh_123',
      customer_group: 'family',
      billing_interval: 'monthly',
      requester_user_id: 'usr_payer',
    },
    customer_details: null,
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function buildStripeSubscription(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: 'sub_stripe_xyz',
    status: 'active',
    current_period_start: 1_715_904_000,
    current_period_end: 1_718_582_400,
    trial_end: null,
    canceled_at: null,
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_first' } as Stripe.SubscriptionItem] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

class StubCouponsService {
  public validate = vi.fn();
  public ensureStripeCoupon = vi.fn();
  public recordRedemption = vi.fn();
}

class FakeOutboxService {
  public appendCalls: Array<{ args: { eventName: string; payload: unknown; eventId?: string } }> =
    [];
  public nextResultOverride: 'validation_failed' | null = null;

  append = vi.fn(
    async (
      _tx: unknown,
      args: { eventName: string; payload: unknown; eventId?: string; occurredAt?: Date },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      this.appendCalls.push({ args });
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
        occurredAt: args.occurredAt ?? new Date(),
      };
    },
  );
}

function buildSvc(): {
  service: CheckoutSessionsService;
  prisma: FakePrisma;
  stripe: FakeStripe;
  coupons: StubCouponsService;
  outbox: FakeOutboxService;
} {
  const prisma = new FakePrisma();
  const stripe = buildStripe();
  stripe.customers.create.mockResolvedValue({ id: 'cus_test' });
  stripe.products.create.mockResolvedValue({ id: 'prod_lazy' });
  const customerService = new StripeCustomerService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
  );
  const coupons = new StubCouponsService();
  const outbox = new FakeOutboxService();
  const service = new CheckoutSessionsService(
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
    stripeProductId: 'prod_seeded',
    ...overrides,
  };
  prisma.plans.push(plan);
  return plan;
}

const validCreateRequest = {
  planId: 'plan_companion',
  customerId: 'hh_123',
  customerGroup: 'family' as const,
  customerEmail: 'parent@example.com',
  billingInterval: 'monthly' as const,
  successUrl: 'https://app.tasteandsee.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.tasteandsee.com/plans',
};

describe('CheckoutSessionsService.create', () => {
  it('creates a Stripe Checkout Session and returns the hosted URL', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.create.mockResolvedValue(
      buildStripeSession({
        id: 'cs_test_abc',
        url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
      }),
    );

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('cs_test_abc');
    expect(result.value.url).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');
    expect(result.value.status).toBe('open');
    const callArgs = stripe.checkout.sessions.create.mock.calls[0]?.[0];
    expect(callArgs?.mode).toBe('subscription');
    expect(callArgs?.success_url).toBe(validCreateRequest.successUrl);
    expect(callArgs?.cancel_url).toBe(validCreateRequest.cancelUrl);
    expect(callArgs?.line_items?.[0]?.price_data?.unit_amount).toBe(19900);
    expect(callArgs?.metadata?.platform_plan_id).toBe('plan_companion');
    expect(callArgs?.metadata?.platform_customer_id).toBe('hh_123');
    expect(callArgs?.metadata?.customer_group).toBe('family');
    expect(callArgs?.metadata?.billing_interval).toBe('monthly');
    expect(callArgs?.metadata?.requester_user_id).toBe('usr_payer');
    expect(callArgs?.subscription_data?.metadata?.platform_plan_id).toBe('plan_companion');
  });

  it('uses annual price + interval=year when billingInterval is annual', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.create.mockResolvedValue(buildStripeSession());

    await service.create({
      request: { ...validCreateRequest, billingInterval: 'annual' },
      requesterUserId: 'usr_payer',
    });

    const callArgs = stripe.checkout.sessions.create.mock.calls[0]?.[0];
    expect(callArgs?.line_items?.[0]?.price_data?.unit_amount).toBe(199000);
    expect(callArgs?.line_items?.[0]?.price_data?.recurring?.interval).toBe('year');
  });

  it('returns plan_not_found when no plan matches', async () => {
    const { service, stripe } = buildSvc();
    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('plan_not_found');
    }
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('returns plan_inactive for a retired plan', async () => {
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

  it('returns plan_group_mismatch when the customerGroup disagrees with the plan', async () => {
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

  it('returns stripe_unavailable when Stripe throws on session create', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.create.mockRejectedValue(new Error('rate limited'));

    const result = await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('stripe_unavailable');
    }
  });

  it('lazy-creates the Stripe Product on first use', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma, { stripeProductId: null });
    stripe.checkout.sessions.create.mockResolvedValue(buildStripeSession());

    await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
    });
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(prisma.plans[0]?.stripeProductId).toBe('prod_lazy');
  });

  it('forwards Idempotency-Key with :phase suffixes to Stripe', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.create.mockResolvedValue(buildStripeSession());

    await service.create({
      request: validCreateRequest,
      requesterUserId: 'usr_payer',
      idempotencyKey: 'idem-1234-5678',
    });
    const opts = stripe.checkout.sessions.create.mock.calls[0]?.[1];
    expect(opts?.idempotencyKey).toBe('idem-1234-5678:session');
  });
});

describe('CheckoutSessionsService.get', () => {
  it('returns the session status and includes the local subscription id when finalized', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    prisma.subscriptions.push({
      id: 'sub_local_1',
      stripeSubscriptionId: 'sub_stripe_abc',
      stripeCustomerId: 'cus_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      planId: 'plan_companion',
      status: 'active',
      billingInterval: 'monthly',
      currentPeriodStart: new Date('2026-05-17T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-17T00:00:00.000Z'),
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
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      updatedAt: new Date('2026-05-17T00:00:00.000Z'),
    });
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_stripe_abc',
        customer_details: {
          email: 'parent@example.com',
        } as Stripe.Checkout.Session.CustomerDetails,
      }),
    );

    const result = await service.get({
      sessionId: 'cs_test_session',
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('complete');
    expect(result.value.stripeSubscriptionId).toBe('sub_stripe_abc');
    expect(result.value.subscriptionId).toBe('sub_local_1');
    expect(result.value.customerEmail).toBe('parent@example.com');
  });

  it('returns null subscriptionId when no local row has been finalized yet', async () => {
    const { service, stripe } = buildSvc();
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_not_yet_local',
      }),
    );

    const result = await service.get({ sessionId: 'cs_test_session', requesterUserId: 'usr' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stripeSubscriptionId).toBe('sub_not_yet_local');
    expect(result.value.subscriptionId).toBeNull();
  });

  it('returns session_not_found when Stripe reports the session is missing', async () => {
    const { service, stripe } = buildSvc();
    const missing = Object.assign(new Error('No such checkout.session'), {
      code: 'resource_missing',
    });
    stripe.checkout.sessions.retrieve.mockRejectedValue(missing);

    const result = await service.get({ sessionId: 'cs_unknown', requesterUserId: 'usr' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('session_not_found');
    }
  });
});

describe('CheckoutSessionsService.finalize', () => {
  it('creates the local subscription row + history + outbox event on first finalize', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_stripe_xyz',
      }),
    );
    stripe.subscriptions.retrieve.mockResolvedValue(buildStripeSubscription());

    const result = await service.finalize({
      sessionId: 'cs_test_session',
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stripeSubscriptionId).toBe('sub_stripe_xyz');
    expect(result.value.status).toBe('active');
    expect(result.value.unitPriceUsdMinor).toBe(19900);
    expect(prisma.subscriptions).toHaveLength(1);
    expect(prisma.histories).toHaveLength(1);
    expect(prisma.histories[0]?.event).toBe('created');
    expect(prisma.histories[0]?.actorUserId).toBe('usr_payer');
    expect(outbox.appendCalls).toHaveLength(1);
    expect(outbox.appendCalls[0]?.args.eventName).toBe(SUBSCRIPTION_ACTIVATED);
  });

  it('is idempotent — replay returns the existing row without re-creating', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedPlan(prisma);
    prisma.subscriptions.push({
      id: 'sub_local_pre',
      stripeSubscriptionId: 'sub_stripe_xyz',
      stripeCustomerId: 'cus_test',
      customerId: 'hh_123',
      customerGroup: 'family',
      planId: 'plan_companion',
      status: 'active',
      billingInterval: 'monthly',
      currentPeriodStart: new Date('2026-05-17T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-17T00:00:00.000Z'),
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
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      updatedAt: new Date('2026-05-17T00:00:00.000Z'),
    });
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_stripe_xyz',
      }),
    );

    const result = await service.finalize({
      sessionId: 'cs_test_session',
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('sub_local_pre');
    expect(prisma.subscriptions).toHaveLength(1);
    expect(outbox.appendCalls).toHaveLength(0);
  });

  it('returns session_not_complete when the session has not been paid', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({ status: 'open', payment_status: 'unpaid' }),
    );

    const result = await service.finalize({
      sessionId: 'cs_test_session',
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('session_not_complete');
    }
  });

  it('returns session_metadata_invalid when the session is missing required metadata', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_stripe_xyz',
        metadata: { stray: 'value' },
      }),
    );

    const result = await service.finalize({
      sessionId: 'cs_test_session',
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.reason === 'session_metadata_invalid') {
      expect(result.error.missingKey).toBe('platform_plan_id');
    } else {
      throw new Error('expected session_metadata_invalid');
    }
  });

  it('returns session_not_subscription_mode when the session was created in a different mode', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedPlan(prisma);
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({ mode: 'payment' as Stripe.Checkout.Session.Mode }),
    );

    const result = await service.finalize({
      sessionId: 'cs_test_session',
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('session_not_subscription_mode');
    }
  });

  it('returns outbox_validation_failed when the outbox SDK rejects the payload', async () => {
    const { service, prisma, stripe, outbox } = buildSvc();
    seedPlan(prisma);
    outbox.nextResultOverride = 'validation_failed';
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      buildStripeSession({
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_stripe_xyz',
      }),
    );
    stripe.subscriptions.retrieve.mockResolvedValue(buildStripeSubscription());

    const result = await service.finalize({
      sessionId: 'cs_test_session',
      requesterUserId: 'usr_payer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('outbox_validation_failed');
    }
  });
});
