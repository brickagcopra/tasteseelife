import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { InvoicesService } from './invoices.service';

interface FakeSubscription {
  id: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
}

class FakePrisma {
  public subscriptions: FakeSubscription[] = [];
  subscription = {
    /**
     * The scoped read (TS-124-followup-scoping). Applies every clause the
     * service passes — a fake that ignored `customerId` / `customerGroup`
     * would make the scoping tests pass against an unscoped service,
     * which is the one thing they exist to catch.
     */
    findFirst: vi.fn(
      async (args: {
        where: { id: string; customerId: string; customerGroup: string };
        select?: Record<string, boolean>;
      }): Promise<FakeSubscription | null> => {
        return (
          this.subscriptions.find(
            (s) =>
              s.id === args.where.id &&
              s.customerId === args.where.customerId &&
              s.customerGroup === args.where.customerGroup,
          ) ?? null
        );
      },
    ),
    /** The existence probe on the miss path — primary key only. */
    findUnique: vi.fn(
      async (args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }): Promise<FakeSubscription | null> => {
        return this.subscriptions.find((s) => s.id === args.where.id) ?? null;
      },
    ),
  };
}

interface FakeStripe {
  invoices: { list: ReturnType<typeof vi.fn> };
}

function buildStripeInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_default',
    customer: 'cus_test',
    subscription: 'sub_stripe_xyz',
    status: 'paid',
    number: 'TASTESEE-0001',
    description: 'Tier 2 Companion Dining — May 2026',
    currency: 'usd',
    amount_due: 29900,
    amount_paid: 29900,
    amount_remaining: 0,
    hosted_invoice_url: 'https://invoice.stripe.com/i/in_default',
    invoice_pdf: 'https://files.stripe.com/i/in_default/pdf',
    period_start: 1_715_904_000,
    period_end: 1_718_582_400,
    created: 1_715_904_000,
    status_transitions: {
      finalized_at: 1_715_904_000,
      marked_uncollectible_at: null,
      paid_at: 1_715_904_001,
      voided_at: null,
    },
    due_date: null,
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function buildSvc(): { service: InvoicesService; prisma: FakePrisma; stripe: FakeStripe } {
  const prisma = new FakePrisma();
  const stripe: FakeStripe = { invoices: { list: vi.fn() } };
  const service = new InvoicesService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
  );
  return { service, prisma, stripe };
}

function seedSubscription(
  prisma: FakePrisma,
  overrides: Partial<FakeSubscription> = {},
): FakeSubscription {
  const sub: FakeSubscription = {
    id: 'sub_local_xyz',
    stripeSubscriptionId: 'sub_stripe_xyz',
    stripeCustomerId: 'cus_test',
    customerId: 'hh_123',
    customerGroup: 'family',
    ...overrides,
  };
  prisma.subscriptions.push(sub);
  return sub;
}

describe('InvoicesService.list', () => {
  it('lists Stripe invoices for the local subscription and maps to the wire DTO', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.invoices.list.mockResolvedValue({
      object: 'list',
      url: '/v1/invoices',
      has_more: false,
      data: [
        buildStripeInvoice({ id: 'in_a' }),
        buildStripeInvoice({ id: 'in_b', status: 'open' }),
      ],
    });

    const result = await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_123',
      requesterUserId: 'usr_payer',
      limit: 12,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoices).toHaveLength(2);
    expect(result.value.invoices[0]?.id).toBe('in_a');
    expect(result.value.invoices[0]?.subscriptionId).toBe('sub_local_xyz');
    expect(result.value.invoices[0]?.stripeSubscriptionId).toBe('sub_stripe_xyz');
    expect(result.value.invoices[0]?.amountDueUsdMinor).toBe(29900);
    expect(result.value.invoices[0]?.amountPaidUsdMinor).toBe(29900);
    expect(result.value.invoices[0]?.hostedInvoiceUrl).toBe(
      'https://invoice.stripe.com/i/in_default',
    );
    expect(result.value.invoices[0]?.paidAt).toBe('2024-05-17T00:00:01.000Z');
    expect(result.value.invoices[1]?.status).toBe('open');
    expect(result.value.hasMore).toBe(false);
    expect(result.value.nextStartingAfter).toBeNull();
    expect(stripe.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_stripe_xyz',
      limit: 12,
    });
  });

  it('returns a cursor when Stripe reports has_more', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.invoices.list.mockResolvedValue({
      object: 'list',
      url: '/v1/invoices',
      has_more: true,
      data: [buildStripeInvoice({ id: 'in_a' }), buildStripeInvoice({ id: 'in_b' })],
    });

    const result = await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_123',
      requesterUserId: 'usr_payer',
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasMore).toBe(true);
    expect(result.value.nextStartingAfter).toBe('in_b');
  });

  it('forwards startingAfter to Stripe when supplied', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.invoices.list.mockResolvedValue({
      object: 'list',
      url: '/v1/invoices',
      has_more: false,
      data: [],
    });

    await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_123',
      requesterUserId: 'usr_payer',
      limit: 12,
      startingAfter: 'in_cursor',
    });
    expect(stripe.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_stripe_xyz',
      limit: 12,
      starting_after: 'in_cursor',
    });
  });

  it('returns subscription_not_found when the local row does not exist', async () => {
    const { service, stripe } = buildSvc();
    const result = await service.list({
      subscriptionId: 'sub_missing',
      householdId: 'hh_123',
      requesterUserId: 'usr',
      limit: 12,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('subscription_not_found');
    }
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });

  it('refuses a subscription belonging to another household (TS-124-followup-scoping)', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma); // owned by hh_123

    const result = await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_intruder',
      requesterUserId: 'usr_other_family',
      limit: 12,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The SAME failure a nonexistent id produces. Anything more
      // specific confirms that a guessed subscription id exists.
      expect(result.error.reason).toBe('subscription_not_found');
    }
    // Nothing about the other household's billing was fetched.
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });

  it('scopes the lookup in the WHERE clause, on both customerId and customerGroup', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.invoices.list.mockResolvedValue({
      object: 'list',
      url: '/v1/invoices',
      has_more: false,
      data: [],
    });

    await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_123',
      requesterUserId: 'usr_payer',
      limit: 12,
    });

    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'sub_local_xyz',
          customerId: 'hh_123',
          customerGroup: 'family',
        },
      }),
    );
  });

  it('does not match a non-family subscription whose customerId collides with the household id', async () => {
    const { service, prisma, stripe } = buildSvc();
    // `subscriptions.customer_id` is a soft FK whose target schema depends
    // on `customer_group`, so an id from another schema can equal a
    // household id. Matching the id alone would serve a provider's
    // billing history to a family.
    seedSubscription(prisma, { customerGroup: 'provider' });

    const result = await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_123',
      requesterUserId: 'usr_payer',
      limit: 12,
    });

    expect(result.ok).toBe(false);
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });

  it('still returns 404-shaped failure when the miss probe itself fails', async () => {
    const { service, prisma, stripe } = buildSvc();
    prisma.subscription.findUnique.mockRejectedValue(new Error('connection reset'));

    const result = await service.list({
      subscriptionId: 'sub_missing',
      householdId: 'hh_123',
      requesterUserId: 'usr',
      limit: 12,
    });

    // The probe is a log-enrichment detail; it must never convert a
    // correct refusal into a 500.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('subscription_not_found');
    }
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });

  it('returns stripe_unavailable when Stripe throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.invoices.list.mockRejectedValue(new Error('rate limited'));

    const result = await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_123',
      requesterUserId: 'usr',
      limit: 12,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('stripe_unavailable');
    }
  });

  it('maps a draft invoice with null number / hosted url through correctly', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.invoices.list.mockResolvedValue({
      object: 'list',
      url: '/v1/invoices',
      has_more: false,
      data: [
        buildStripeInvoice({
          id: 'in_draft',
          status: 'draft',
          number: null,
          hosted_invoice_url: null,
          invoice_pdf: null,
          amount_paid: 0,
          amount_remaining: 29900,
          status_transitions: {
            finalized_at: null,
            marked_uncollectible_at: null,
            paid_at: null,
            voided_at: null,
          },
        }),
      ],
    });

    const result = await service.list({
      subscriptionId: 'sub_local_xyz',
      householdId: 'hh_123',
      requesterUserId: 'usr',
      limit: 12,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoices[0]?.status).toBe('draft');
    expect(result.value.invoices[0]?.number).toBeNull();
    expect(result.value.invoices[0]?.hostedInvoiceUrl).toBeNull();
    expect(result.value.invoices[0]?.paidAt).toBeNull();
  });

  it('throws when Stripe returns a non-USD currency (Phase 1 USD-only)', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.invoices.list.mockResolvedValue({
      object: 'list',
      url: '/v1/invoices',
      has_more: false,
      data: [buildStripeInvoice({ currency: 'eur' })],
    });

    await expect(
      service.list({
        subscriptionId: 'sub_local_xyz',
        householdId: 'hh_123',
        requesterUserId: 'usr',
        limit: 12,
      }),
    ).rejects.toThrow(/unsupported invoice currency/);
  });
});
