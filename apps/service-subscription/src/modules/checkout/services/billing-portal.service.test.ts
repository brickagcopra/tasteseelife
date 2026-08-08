import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';

import { BillingPortalService } from './billing-portal.service';

interface FakeSubscription {
  id: string;
  stripeCustomerId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  createdAt: Date;
}

class FakePrisma {
  public subscriptions: FakeSubscription[] = [];
  subscription = {
    findFirst: vi.fn(
      async (args: {
        where: { customerId: string; customerGroup: string };
        orderBy?: { createdAt: 'asc' | 'desc' };
        select?: Record<string, boolean>;
      }): Promise<FakeSubscription | null> => {
        const matches = this.subscriptions.filter(
          (s) =>
            s.customerId === args.where.customerId && s.customerGroup === args.where.customerGroup,
        );
        matches.sort((a, b) =>
          args.orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return matches[0] ?? null;
      },
    ),
  };
}

interface FakeStripe {
  billingPortal: { sessions: { create: ReturnType<typeof vi.fn> } };
}

const RETURN_URL = 'https://app.tasteandsee.example.com/billing';

function buildSvc(): {
  service: BillingPortalService;
  prisma: FakePrisma;
  stripe: FakeStripe;
} {
  const prisma = new FakePrisma();
  const stripe: FakeStripe = { billingPortal: { sessions: { create: vi.fn() } } };
  const service = new BillingPortalService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
    { BILLING_PORTAL_RETURN_URL: RETURN_URL } as unknown as Env,
  );
  return { service, prisma, stripe };
}

function seed(prisma: FakePrisma, overrides: Partial<FakeSubscription> = {}): FakeSubscription {
  const row: FakeSubscription = {
    id: 'sub_local_xyz',
    stripeCustomerId: 'cus_test',
    customerId: 'hh_123',
    customerGroup: 'family',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
  prisma.subscriptions.push(row);
  return row;
}

function portalSession(url: string): Stripe.BillingPortal.Session {
  return {
    id: 'bps_test',
    object: 'billing_portal.session',
    customer: 'cus_test',
    created: 1_770_000_000,
    livemode: false,
    return_url: RETURN_URL,
    url,
  } as unknown as Stripe.BillingPortal.Session;
}

describe('BillingPortalService.createSession', () => {
  it('mints a portal session for the household’s Stripe customer', async () => {
    const { service, prisma, stripe } = buildSvc();
    seed(prisma);
    stripe.billingPortal.sessions.create.mockResolvedValue(
      portalSession('https://billing.stripe.com/p/session/live_abc'),
    );

    const result = await service.createSession({
      householdId: 'hh_123',
      requesterUserId: 'usr_payer',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ url: 'https://billing.stripe.com/p/session/live_abc' });
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_test',
      return_url: RETURN_URL,
    });
  });

  it('scopes the lookup to the household AND the family customer group', async () => {
    const { service, prisma, stripe } = buildSvc();
    seed(prisma);
    stripe.billingPortal.sessions.create.mockResolvedValue(portalSession('https://x.example/p'));

    await service.createSession({ householdId: 'hh_123', requesterUserId: 'usr' });

    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'hh_123', customerGroup: 'family' },
      }),
    );
  });

  it('never mints a session for another household', async () => {
    const { service, prisma, stripe } = buildSvc();
    seed(prisma); // hh_123

    const result = await service.createSession({
      householdId: 'hh_intruder',
      requesterUserId: 'usr_other',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('no_subscription');
    // A portal session is full billing control including cancellation.
    // Nothing may reach Stripe on this path.
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('does not serve a non-family subscription whose customerId collides', async () => {
    const { service, prisma, stripe } = buildSvc();
    // `customer_id`'s target schema depends on `customer_group`, so an id
    // from another schema can equal a household id. The provider case is
    // a separate decision (TS-042-followup-3a1a), not a fallthrough.
    seed(prisma, { customerGroup: 'provider' });

    const result = await service.createSession({
      householdId: 'hh_123',
      requesterUserId: 'usr',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('no_subscription');
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('uses the most recent subscription when a household has re-subscribed', async () => {
    const { service, prisma, stripe } = buildSvc();
    seed(prisma, {
      id: 'sub_old',
      stripeCustomerId: 'cus_old',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    seed(prisma, {
      id: 'sub_new',
      stripeCustomerId: 'cus_new',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    stripe.billingPortal.sessions.create.mockResolvedValue(portalSession('https://x.example/p'));

    await service.createSession({ householdId: 'hh_123', requesterUserId: 'usr' });

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_new' }),
    );
  });

  it('takes the return_url from config, never from the caller', async () => {
    const { service, prisma, stripe } = buildSvc();
    seed(prisma);
    stripe.billingPortal.sessions.create.mockResolvedValue(portalSession('https://x.example/p'));

    // The input type has no place to put one — this asserts the value
    // that actually reaches Stripe is the configured one, so a future
    // widening of the input cannot quietly become an open redirect.
    await service.createSession({ householdId: 'hh_123', requesterUserId: 'usr' });

    const args = stripe.billingPortal.sessions.create.mock.calls[0]?.[0] as {
      return_url: string;
    };
    expect(args.return_url).toBe(RETURN_URL);
  });

  it('reports no_stripe_customer rather than "no plan" when the link is missing', async () => {
    const { service, prisma, stripe } = buildSvc();
    seed(prisma, { stripeCustomerId: '' });

    const result = await service.createSession({
      householdId: 'hh_123',
      requesterUserId: 'usr',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A data defect must not be reported to a paying family as an
      // absent subscription — that sends them somewhere useless.
      expect(result.error.reason).toBe('no_stripe_customer');
    }
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('returns stripe_unavailable when Stripe throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seed(prisma);
    stripe.billingPortal.sessions.create.mockRejectedValue(new Error('rate limited'));

    const result = await service.createSession({
      householdId: 'hh_123',
      requesterUserId: 'usr',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('stripe_unavailable');
  });
});
