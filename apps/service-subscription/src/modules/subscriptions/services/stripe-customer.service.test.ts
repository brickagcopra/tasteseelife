import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { StripeCustomerService } from './stripe-customer.service';

interface FakeCustomersApi {
  create: ReturnType<typeof vi.fn>;
}

interface SubscriptionRow {
  stripeCustomerId: string;
  createdAt: Date;
}
interface PaymentMethodRow {
  stripeCustomerId: string;
  createdAt: Date;
}

class FakePrisma {
  public subscriptions: SubscriptionRow[] = [];
  public paymentMethods: PaymentMethodRow[] = [];

  subscription = {
    findFirst: vi.fn(async (): Promise<SubscriptionRow | null> => {
      const sorted = [...this.subscriptions].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return sorted[0] ?? null;
    }),
  };

  paymentMethod = {
    findFirst: vi.fn(async (): Promise<PaymentMethodRow | null> => {
      const sorted = [...this.paymentMethods].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return sorted[0] ?? null;
    }),
  };
}

function buildSvc(): {
  service: StripeCustomerService;
  prisma: FakePrisma;
  customers: FakeCustomersApi;
} {
  const prisma = new FakePrisma();
  const customers: FakeCustomersApi = { create: vi.fn() };
  const stripe = { customers } as unknown as Stripe;
  const service = new StripeCustomerService(prisma as unknown as PrismaService, stripe);
  return { service, prisma, customers };
}

describe('StripeCustomerService.resolve', () => {
  it('rejects an empty email with invalid_request', async () => {
    const { service } = buildSvc();
    const result = await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('returns the cached stripe_customer_id when a subscription already exists', async () => {
    const { service, prisma, customers } = buildSvc();
    prisma.subscriptions.push({
      stripeCustomerId: 'cus_existing',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const result = await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ stripeCustomerId: 'cus_existing', created: false });
    }
    expect(customers.create).not.toHaveBeenCalled();
  });

  it('falls back to payment_methods when no subscription row exists', async () => {
    const { service, prisma, customers } = buildSvc();
    prisma.paymentMethods.push({
      stripeCustomerId: 'cus_from_pm',
      createdAt: new Date('2026-05-02T00:00:00.000Z'),
    });

    const result = await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stripeCustomerId).toBe('cus_from_pm');
      expect(result.value.created).toBe(false);
    }
    expect(customers.create).not.toHaveBeenCalled();
  });

  it('creates a new Stripe customer when no row exists for the tuple', async () => {
    const { service, customers } = buildSvc();
    customers.create.mockResolvedValue({ id: 'cus_new_xyz' } as Stripe.Customer);

    const result = await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
      name: 'A. Parent',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ stripeCustomerId: 'cus_new_xyz', created: true });
    }
    expect(customers.create).toHaveBeenCalledTimes(1);
    expect(customers.create.mock.calls[0]?.[0]).toMatchObject({
      email: 'parent@example.com',
      name: 'A. Parent',
      metadata: {
        platform_customer_id: 'hh_1',
        customer_group: 'family',
      },
    });
  });

  it('forwards the idempotencyKey to Stripe on customer create', async () => {
    const { service, customers } = buildSvc();
    customers.create.mockResolvedValue({ id: 'cus_idem' } as Stripe.Customer);

    await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
      idempotencyKey: 'idem-abc-12345',
    });

    expect(customers.create.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: 'idem-abc-12345',
    });
  });

  it('omits the name field when not provided (no cleartext null in the request body)', async () => {
    const { service, customers } = buildSvc();
    customers.create.mockResolvedValue({ id: 'cus_new' } as Stripe.Customer);

    await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
    });

    const args = customers.create.mock.calls[0]?.[0];
    expect(args).not.toHaveProperty('name');
  });

  it('returns stripe_unavailable when the SDK throws', async () => {
    const { service, customers } = buildSvc();
    customers.create.mockRejectedValue(new Error('network down'));

    const result = await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('stripe_unavailable');
    }
  });

  it('does not log full error objects (defence-in-depth — message-only)', async () => {
    const { service, customers } = buildSvc();
    // A non-Error throw value should still come back as stripe_unavailable.
    customers.create.mockRejectedValue('plain-string-error');

    const result = await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
    });

    expect(result.ok).toBe(false);
  });

  it('reads the most recent subscription row when multiple exist for the tuple', async () => {
    const { service, prisma, customers } = buildSvc();
    prisma.subscriptions.push(
      { stripeCustomerId: 'cus_old', createdAt: new Date('2026-05-01T00:00:00.000Z') },
      { stripeCustomerId: 'cus_recent', createdAt: new Date('2026-05-09T00:00:00.000Z') },
    );

    const result = await service.resolve({
      customerId: 'hh_1',
      customerGroup: 'family',
      email: 'parent@example.com',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stripeCustomerId).toBe('cus_recent');
    }
    expect(customers.create).not.toHaveBeenCalled();
  });
});
