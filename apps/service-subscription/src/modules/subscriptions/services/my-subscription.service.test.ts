import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { MySubscriptionService } from './my-subscription.service';

interface FakePlan {
  code: string;
  name: string;
  monthlyPrice: Decimal;
  annualPrice: Decimal;
  currency: string;
}

interface FakeRow {
  status: string;
  billingInterval: 'monthly' | 'annual';
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  dunningAttempts: number;
  dunningGraceUntil: Date | null;
  pauseCollectionResumesAt: Date | null;
  createdAt: Date;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  plan: FakePlan;
}

class FakePrisma {
  public rows: FakeRow[] = [];
  subscription = {
    findMany: vi.fn(
      async (args: {
        where: { customerId: string; customerGroup: string };
        orderBy?: { createdAt: 'asc' | 'desc' };
      }): Promise<FakeRow[]> => {
        const matches = this.rows.filter(
          (r) =>
            r.customerId === args.where.customerId && r.customerGroup === args.where.customerGroup,
        );
        matches.sort((a, b) =>
          args.orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return matches;
      },
    ),
  };
}

function buildSvc(): { service: MySubscriptionService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  return {
    service: new MySubscriptionService(prisma as unknown as PrismaService),
    prisma,
  };
}

function seed(prisma: FakePrisma, overrides: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    status: 'active',
    billingInterval: 'monthly',
    currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    dunningAttempts: 0,
    dunningGraceUntil: null,
    pauseCollectionResumesAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    customerId: 'hh_123',
    customerGroup: 'family',
    plan: {
      code: 'tier-2-companion',
      name: 'Companion Dining',
      monthlyPrice: new Decimal('299.00'),
      annualPrice: new Decimal('3229.20'),
      currency: 'USD',
    },
    ...overrides,
  };
  prisma.rows.push(row);
  return row;
}

const ASK = { householdId: 'hh_123', requesterUserId: 'usr_payer' } as const;

describe('MySubscriptionService.read', () => {
  it('returns the family view of the household’s membership', async () => {
    const { service, prisma } = buildSvc();
    seed(prisma);

    const result = await service.read(ASK);

    expect(result).toEqual({
      planCode: 'tier-2-companion',
      planName: 'Companion Dining',
      status: 'active',
      billingInterval: 'monthly',
      unitPriceUsdMinor: 29900,
      currency: 'USD',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      trialEnd: null,
      cancelAtPeriodEnd: false,
      paymentTrouble: false,
      paymentDueBy: null,
      pauseResumesAt: null,
    });
  });

  it('exposes no Stripe ids, no attempt count, and no pause reason', async () => {
    const { service, prisma } = buildSvc();
    seed(prisma, { dunningAttempts: 3, status: 'past_due' });

    const result = await service.read(ASK);

    // The fields that must never cross to a family. `dunningAttempts` in
    // particular: the dunning copy refuses to state the retry count
    // because "this is our 3rd attempt" is a collections notice, and a
    // screen that shows it reintroduces exactly that.
    const keys = Object.keys(result ?? {});
    expect(keys).not.toContain('dunningAttempts');
    expect(keys).not.toContain('stripeSubscriptionId');
    expect(keys).not.toContain('stripeCustomerId');
    expect(keys).not.toContain('pauseReason');
    expect(keys).not.toContain('customerId');
    expect(JSON.stringify(result)).not.toContain('3');
  });

  it('scopes the read to the household AND the family customer group', async () => {
    const { service, prisma } = buildSvc();
    seed(prisma);

    await service.read(ASK);

    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'hh_123', customerGroup: 'family' },
      }),
    );
  });

  it('returns null for another household', async () => {
    const { service, prisma } = buildSvc();
    seed(prisma);

    expect(await service.read({ householdId: 'hh_other', requesterUserId: 'usr' })).toBeNull();
  });

  it('returns null for a household with no membership', async () => {
    const { service } = buildSvc();
    expect(await service.read(ASK)).toBeNull();
  });

  it('does not serve a non-family subscription whose customerId collides', async () => {
    const { service, prisma } = buildSvc();
    seed(prisma, { customerGroup: 'provider' });
    expect(await service.read(ASK)).toBeNull();
  });

  it('prices an annual membership from the annual column', async () => {
    const { service, prisma } = buildSvc();
    seed(prisma, { billingInterval: 'annual' });

    const result = await service.read(ASK);

    expect(result?.unitPriceUsdMinor).toBe(322_920);
    expect(result?.billingInterval).toBe('annual');
  });

  describe('paymentTrouble', () => {
    it('is true on past_due', async () => {
      const { service, prisma } = buildSvc();
      seed(prisma, { status: 'past_due', dunningAttempts: 1 });
      expect((await service.read(ASK))?.paymentTrouble).toBe(true);
    });

    it('is true on unpaid', async () => {
      const { service, prisma } = buildSvc();
      seed(prisma, { status: 'unpaid', dunningAttempts: 4 });
      expect((await service.read(ASK))?.paymentTrouble).toBe(true);
    });

    it('is true while the row is still active but an attempt has failed', async () => {
      // The window that matters: Stripe has not moved the status yet, but
      // the family has already had an email. A portal saying "all fine"
      // here would contradict our own outbound mail.
      const { service, prisma } = buildSvc();
      seed(prisma, { status: 'active', dunningAttempts: 1 });
      expect((await service.read(ASK))?.paymentTrouble).toBe(true);
    });

    it('is false for a healthy membership', async () => {
      const { service, prisma } = buildSvc();
      seed(prisma, { status: 'active', dunningAttempts: 0 });
      expect((await service.read(ASK))?.paymentTrouble).toBe(false);
    });
  });

  describe('paymentDueBy', () => {
    it('carries the grace deadline while there is trouble', async () => {
      const { service, prisma } = buildSvc();
      seed(prisma, {
        status: 'past_due',
        dunningAttempts: 2,
        dunningGraceUntil: new Date('2026-09-15T00:00:00.000Z'),
      });
      expect((await service.read(ASK))?.paymentDueBy).toBe('2026-09-15T00:00:00.000Z');
    });

    it('is null on a healthy membership even if a stale deadline is on the row', async () => {
      // Surfacing a leftover deadline would invent a warning about a
      // membership that is fine.
      const { service, prisma } = buildSvc();
      seed(prisma, {
        status: 'active',
        dunningAttempts: 0,
        dunningGraceUntil: new Date('2026-03-01T00:00:00.000Z'),
      });
      const result = await service.read(ASK);
      expect(result?.paymentTrouble).toBe(false);
      expect(result?.paymentDueBy).toBeNull();
    });
  });

  describe('which row is "my plan"', () => {
    it('prefers a live membership over a newer cancelled one', async () => {
      const { service, prisma } = buildSvc();
      seed(prisma, {
        status: 'past_due',
        dunningAttempts: 1,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        plan: {
          code: 'live',
          name: 'The live one',
          monthlyPrice: new Decimal('299.00'),
          annualPrice: new Decimal('3229.20'),
          currency: 'USD',
        },
      });
      seed(prisma, {
        status: 'canceled',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        plan: {
          code: 'dead',
          name: 'The cancelled one',
          monthlyPrice: new Decimal('99.00'),
          annualPrice: new Decimal('1069.20'),
          currency: 'USD',
        },
      });

      // Recency alone would show the cancelled row and tell a family in
      // dunning that they have nothing to worry about.
      expect((await service.read(ASK))?.planCode).toBe('live');
    });

    it('still shows the most recent membership when every one has ended', async () => {
      const { service, prisma } = buildSvc();
      seed(prisma, {
        status: 'canceled',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        plan: {
          code: 'older',
          name: 'Older',
          monthlyPrice: new Decimal('99.00'),
          annualPrice: new Decimal('1069.20'),
          currency: 'USD',
        },
      });
      seed(prisma, {
        status: 'canceled',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        plan: {
          code: 'newer',
          name: 'Newer',
          monthlyPrice: new Decimal('99.00'),
          annualPrice: new Decimal('1069.20'),
          currency: 'USD',
        },
      });

      // An empty page for a household that demonstrably had a plan reads
      // as data loss, not as "you cancelled".
      expect((await service.read(ASK))?.planCode).toBe('newer');
    });
  });

  it('throws rather than emitting an unsupported currency', async () => {
    const { service, prisma } = buildSvc();
    seed(prisma, {
      plan: {
        code: 'eu',
        name: 'Euro plan',
        monthlyPrice: new Decimal('299.00'),
        annualPrice: new Decimal('3229.20'),
        currency: 'EUR',
      },
    });

    await expect(service.read(ASK)).rejects.toThrow(/unsupported currency/);
  });
});
