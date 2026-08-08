import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  AdminSubscriptionsService,
  decodeCursor,
  encodeCursor,
} from './admin-subscriptions.service';

const NOW = new Date('2026-05-17T12:00:00.000Z');

type FakeSubscriptionRow = {
  id: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  planId: string;
  status:
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'unpaid'
    | 'canceled'
    | 'paused';
  billingInterval: 'monthly' | 'annual';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelReason:
    | 'customer_request'
    | 'payment_failure'
    | 'fraud'
    | 'admin_action'
    | 'partner_termination'
    | null;
  canceledAt: Date | null;
  defaultPaymentMethodId: string | null;
  dunningAttempts: number;
  dunningLastAttemptAt: Date | null;
  dunningGraceUntil: Date | null;
  pauseCollectionStartedAt: Date | null;
  pauseCollectionResumesAt: Date | null;
  pauseReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakePlanRow = {
  id: string;
  code: string;
  name: string;
  customerGroup: 'family' | 'provider' | 'academy';
  monthlyPrice: Decimal;
  annualPrice: Decimal;
  currency: string;
  active: boolean;
};

type FakePaymentMethodRow = {
  id: string;
  stripePaymentMethodId: string;
  kind: 'card' | 'bank_account';
  brand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  isDefault: boolean;
};

type FakeHistoryRow = {
  id: string;
  subscriptionId: string;
  event:
    | 'created'
    | 'status_changed'
    | 'plan_changed'
    | 'payment_method_changed'
    | 'trial_extended'
    | 'paused'
    | 'resumed'
    | 'canceled'
    | 'reactivated';
  fromStatus: FakeSubscriptionRow['status'] | null;
  toStatus: FakeSubscriptionRow['status'] | null;
  context: unknown;
  actorUserId: string | null;
  actorKind: string;
  source: string | null;
  occurredAt: Date;
};

function buildFakePrisma(input: {
  subscriptions: FakeSubscriptionRow[];
  plans?: FakePlanRow[];
  paymentMethods?: FakePaymentMethodRow[];
  history?: FakeHistoryRow[];
}): PrismaService {
  const subscriptions = [...input.subscriptions];
  const plans = [...(input.plans ?? [])];
  const paymentMethods = [...(input.paymentMethods ?? [])];
  const history = [...(input.history ?? [])];

  function matchesValue(value: unknown, predicate: unknown): boolean {
    if (predicate === null) return value === null;
    if (predicate instanceof Date) {
      return value instanceof Date && value.getTime() === predicate.getTime();
    }
    if (typeof predicate !== 'object') return value === predicate;
    const obj = predicate as Record<string, unknown>;
    if ('in' in obj) {
      const arr = obj['in'] as readonly unknown[];
      return arr.some((c) => matchesValue(value, c));
    }
    if ('lt' in obj) {
      const target = obj['lt'];
      if (target instanceof Date && value instanceof Date) {
        return value.getTime() < target.getTime();
      }
      return (value as number) < (target as number);
    }
    if ('equals' in obj) return matchesValue(value, obj['equals']);
    return false;
  }

  function rowMatchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, predicate] of Object.entries(where)) {
      if (key === 'OR') {
        const arr = predicate as Array<Record<string, unknown>>;
        if (!arr.some((p) => rowMatchesWhere(row, p))) return false;
        continue;
      }
      if (key === 'AND') {
        const arr = predicate as Array<Record<string, unknown>>;
        if (!arr.every((p) => rowMatchesWhere(row, p))) return false;
        continue;
      }
      if (!matchesValue(row[key], predicate)) return false;
    }
    return true;
  }

  function sortRows<T>(rows: T[], orderBy: ReadonlyArray<Record<string, 'asc' | 'desc'>>): T[] {
    return [...rows].sort((a, b) => {
      for (const clause of orderBy) {
        const entry = Object.entries(clause)[0];
        if (entry === undefined) continue;
        const [k, dir] = entry;
        const av = (a as Record<string, unknown>)[k] as Date | string;
        const bv = (b as Record<string, unknown>)[k] as Date | string;
        const cmp =
          av instanceof Date && bv instanceof Date
            ? av.getTime() - bv.getTime()
            : av < bv
              ? -1
              : av > bv
                ? 1
                : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  const prisma = {
    subscription: {
      findMany: vi.fn(
        async (args: {
          where?: Record<string, unknown>;
          orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
          take?: number;
        }): Promise<FakeSubscriptionRow[]> => {
          const where = args.where ?? {};
          let filtered = subscriptions.filter((s) =>
            rowMatchesWhere(s as unknown as Record<string, unknown>, where),
          );
          if (args.orderBy !== undefined) filtered = sortRows(filtered, args.orderBy);
          if (args.take !== undefined) filtered = filtered.slice(0, args.take);
          return filtered;
        },
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }): Promise<FakeSubscriptionRow | null> => {
          return subscriptions.find((s) => s.id === args.where.id) ?? null;
        },
      ),
    },
    plan: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }): Promise<FakePlanRow[]> => {
        const where = args.where ?? {};
        return plans.filter((p) => rowMatchesWhere(p as unknown as Record<string, unknown>, where));
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }): Promise<FakePlanRow | null> => {
        return plans.find((p) => p.id === args.where.id) ?? null;
      }),
    },
    paymentMethod: {
      findUnique: vi.fn(
        async (args: { where: { id: string } }): Promise<FakePaymentMethodRow | null> => {
          return paymentMethods.find((m) => m.id === args.where.id) ?? null;
        },
      ),
    },
    subscriptionHistory: {
      findMany: vi.fn(
        async (args: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'>;
          take?: number;
        }): Promise<FakeHistoryRow[]> => {
          const where = args.where ?? {};
          let filtered = history.filter((h) =>
            rowMatchesWhere(h as unknown as Record<string, unknown>, where),
          );
          if (args.orderBy !== undefined) {
            filtered = sortRows(filtered, [args.orderBy]);
          }
          if (args.take !== undefined) filtered = filtered.slice(0, args.take);
          return filtered;
        },
      ),
    },
  } as unknown as PrismaService;
  return prisma;
}

function makeSubscriptionRow(overrides: Partial<FakeSubscriptionRow> = {}): FakeSubscriptionRow {
  return {
    id: 'sub_1',
    stripeSubscriptionId: 'sub_stripe_1',
    stripeCustomerId: 'cus_1',
    customerId: 'hh_1',
    customerGroup: 'family',
    planId: 'plan_tier2',
    status: 'active',
    billingInterval: 'monthly',
    currentPeriodStart: NOW,
    currentPeriodEnd: new Date(NOW.getTime() + 30 * 86_400_000),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    cancelReason: null,
    canceledAt: null,
    defaultPaymentMethodId: null,
    dunningAttempts: 0,
    dunningLastAttemptAt: null,
    dunningGraceUntil: null,
    pauseCollectionStartedAt: null,
    pauseCollectionResumesAt: null,
    pauseReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePlanRow(overrides: Partial<FakePlanRow> = {}): FakePlanRow {
  return {
    id: 'plan_tier2',
    code: 'family.tier2',
    name: 'Companion Dining',
    customerGroup: 'family',
    monthlyPrice: new Decimal('299.00'),
    annualPrice: new Decimal('2990.00'),
    currency: 'USD',
    active: true,
    ...overrides,
  };
}

describe('AdminSubscriptionsService — cursor codec', () => {
  it('round-trips a createdAt + id pair', () => {
    const cursor = encodeCursor(NOW, 'sub_abc');
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt.getTime()).toBe(NOW.getTime());
    expect(decoded!.id).toBe('sub_abc');
  });

  it('returns null on undefined input', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('returns null on a non-base64url input', () => {
    expect(decodeCursor('***not-base64***')).toBeNull();
  });

  it('returns null on a base64 payload missing the pipe', () => {
    const bad = Buffer.from('no-pipe-here', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null on an unparseable ISO date', () => {
    const bad = Buffer.from('not-a-date|sub_1', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe('AdminSubscriptionsService.list', () => {
  it('returns an empty page when no subscriptions exist', async () => {
    const prisma = buildFakePrisma({ subscriptions: [] });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('denormalises plan code + name + unit price from the matching plan row', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({ id: 'sub_1', planId: 'plan_tier2', billingInterval: 'monthly' }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions).toHaveLength(1);
    const first = page.subscriptions[0]!;
    expect(first.planCode).toBe('family.tier2');
    expect(first.planName).toBe('Companion Dining');
    expect(first.unitPriceMinor).toBe(29900);
    expect(first.currency).toBe('USD');
  });

  it('picks the annual price when billingInterval is annual', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1', billingInterval: 'annual' })],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions[0]!.unitPriceMinor).toBe(299000);
  });

  it('falls back to "unknown" plan code/name when the FK does not resolve', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1', planId: 'plan_missing' })],
      plans: [],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions[0]!.planCode).toBe('unknown');
    expect(page.subscriptions[0]!.unitPriceMinor).toBe(0);
  });

  it('filters by exact customerGroup', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({ id: 'sub_1', customerGroup: 'family' }),
        makeSubscriptionRow({ id: 'sub_2', customerGroup: 'provider' }),
      ],
      plans: [makePlanRow(), makePlanRow({ id: 'plan_provider' })],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ customerGroup: 'provider', limit: 25, now: NOW });
    expect(page.subscriptions.map((s) => s.id)).toEqual(['sub_2']);
  });

  it('filters by exact status', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({ id: 'sub_1', status: 'active' }),
        makeSubscriptionRow({ id: 'sub_2', status: 'past_due' }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ status: 'past_due', limit: 25, now: NOW });
    expect(page.subscriptions.map((s) => s.id)).toEqual(['sub_2']);
  });

  it('filters by exact planId', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({ id: 'sub_1', planId: 'plan_a' }),
        makeSubscriptionRow({ id: 'sub_2', planId: 'plan_b' }),
      ],
      plans: [makePlanRow({ id: 'plan_a', code: 'a' }), makePlanRow({ id: 'plan_b', code: 'b' })],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ planId: 'plan_b', limit: 25, now: NOW });
    expect(page.subscriptions.map((s) => s.id)).toEqual(['sub_2']);
  });

  it('filters by exact customerId', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({ id: 'sub_1', customerId: 'hh_a' }),
        makeSubscriptionRow({ id: 'sub_2', customerId: 'hh_b' }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ customerId: 'hh_b', limit: 25, now: NOW });
    expect(page.subscriptions.map((s) => s.id)).toEqual(['sub_2']);
  });

  it('sorts createdAt DESC + id DESC and emits cursor when more pages remain', async () => {
    const earlier = new Date(NOW.getTime() - 5_000);
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({ id: 'sub_1', createdAt: earlier }),
        makeSubscriptionRow({ id: 'sub_2', createdAt: NOW }),
        makeSubscriptionRow({ id: 'sub_3', createdAt: NOW }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 2, now: NOW });
    expect(page.subscriptions.map((s) => s.id)).toEqual(['sub_3', 'sub_2']);
    expect(page.nextCursor).not.toBeNull();
  });

  it('does not emit a cursor when the page exhausts the rows', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1' })],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.nextCursor).toBeNull();
  });

  it('computes inDunningGrace=true for past_due with future graceUntil', async () => {
    const future = new Date(NOW.getTime() + 5_000);
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({
          id: 'sub_1',
          status: 'past_due',
          dunningGraceUntil: future,
        }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions[0]!.inDunningGrace).toBe(true);
  });

  it('computes inDunningGrace=false for past_due with expired graceUntil', async () => {
    const past = new Date(NOW.getTime() - 5_000);
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({
          id: 'sub_1',
          status: 'past_due',
          dunningGraceUntil: past,
        }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions[0]!.inDunningGrace).toBe(false);
  });

  it('computes inDunningGrace=false for active status regardless of graceUntil', async () => {
    const future = new Date(NOW.getTime() + 5_000);
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({
          id: 'sub_1',
          status: 'active',
          dunningGraceUntil: future,
        }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions[0]!.inDunningGrace).toBe(false);
  });

  it('computes isPaused=true for status=paused', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1', status: 'paused' })],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions[0]!.isPaused).toBe(true);
  });

  it('computes isPaused=true when pauseCollectionStartedAt is non-null but status not yet flipped', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({
          id: 'sub_1',
          status: 'active',
          pauseCollectionStartedAt: NOW,
        }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.subscriptions[0]!.isPaused).toBe(true);
  });

  it('clamps limit above the documented bound', async () => {
    const prisma = buildFakePrisma({ subscriptions: [], plans: [] });
    const svc = new AdminSubscriptionsService(prisma);
    const page = await svc.list({ limit: 999, now: NOW });
    expect(page.subscriptions).toEqual([]);
  });

  it('honours an opaque cursor by filtering rows strictly before the encoded marker', async () => {
    const earlier = new Date(NOW.getTime() - 5_000);
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({ id: 'sub_1', createdAt: earlier }),
        makeSubscriptionRow({ id: 'sub_2', createdAt: NOW }),
        makeSubscriptionRow({ id: 'sub_3', createdAt: NOW }),
      ],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const cursor = encodeCursor(NOW, 'sub_3');
    const page = await svc.list({ cursor, limit: 25, now: NOW });
    expect(page.subscriptions.map((s) => s.id)).toEqual(['sub_2', 'sub_1']);
  });
});

describe('AdminSubscriptionsService.getById', () => {
  it('returns null when the id does not resolve', async () => {
    const prisma = buildFakePrisma({ subscriptions: [] });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_missing', now: NOW });
    expect(detail).toBeNull();
  });

  it('returns the full detail row with plan + history when both exist', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [
        makeSubscriptionRow({
          id: 'sub_1',
          planId: 'plan_tier2',
          billingInterval: 'monthly',
          defaultPaymentMethodId: 'pm_local_1',
        }),
      ],
      plans: [makePlanRow()],
      paymentMethods: [
        {
          id: 'pm_local_1',
          stripePaymentMethodId: 'pm_card_visa',
          kind: 'card',
          brand: 'visa',
          last4: '4242',
          expiryMonth: 12,
          expiryYear: 2030,
          isDefault: true,
        },
      ],
      history: [
        {
          id: 'hist_1',
          subscriptionId: 'sub_1',
          event: 'created',
          fromStatus: null,
          toStatus: 'active',
          context: { planCode: 'family.tier2' },
          actorUserId: 'usr_a',
          actorKind: 'user',
          source: null,
          occurredAt: NOW,
        },
      ],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_1', now: NOW });
    expect(detail).not.toBeNull();
    expect(detail!.plan.code).toBe('family.tier2');
    expect(detail!.unitPriceMinor).toBe(29900);
    expect(detail!.defaultPaymentMethod).not.toBeNull();
    expect(detail!.defaultPaymentMethod!.last4).toBe('4242');
    expect(detail!.history).toHaveLength(1);
    expect(detail!.history[0]!.event).toBe('created');
  });

  it('returns a null defaultPaymentMethod when the row has no defaultPaymentMethodId', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1', defaultPaymentMethodId: null })],
      plans: [makePlanRow()],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_1', now: NOW });
    expect(detail).not.toBeNull();
    expect(detail!.defaultPaymentMethod).toBeNull();
  });

  it('returns a null defaultPaymentMethod when the id points at a missing row', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1', defaultPaymentMethodId: 'pm_missing' })],
      plans: [makePlanRow()],
      paymentMethods: [],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_1', now: NOW });
    expect(detail).not.toBeNull();
    expect(detail!.defaultPaymentMethod).toBeNull();
  });

  it('falls back to a placeholder plan when the FK does not resolve', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1', planId: 'plan_missing' })],
      plans: [],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_1', now: NOW });
    expect(detail).not.toBeNull();
    expect(detail!.plan.code).toBe('unknown');
    expect(detail!.plan.name).toBe('unknown');
    expect(detail!.unitPriceMinor).toBe(0);
  });

  it('returns the history rows newest-first capped at the documented limit', async () => {
    const history: FakeHistoryRow[] = Array.from({ length: 60 }, (_, i) => ({
      id: `hist_${i}`,
      subscriptionId: 'sub_1',
      event: 'status_changed' as const,
      fromStatus: 'incomplete' as const,
      toStatus: 'active' as const,
      context: {},
      actorUserId: null,
      actorKind: 'system',
      source: `evt_${i}`,
      occurredAt: new Date(NOW.getTime() - i * 1000),
    }));
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1' })],
      plans: [makePlanRow()],
      history,
    });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_1', now: NOW });
    expect(detail).not.toBeNull();
    expect(detail!.history).toHaveLength(50);
    expect(detail!.history[0]!.id).toBe('hist_0');
  });

  it('normalises an unknown actor_kind to "system"', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1' })],
      plans: [makePlanRow()],
      history: [
        {
          id: 'hist_1',
          subscriptionId: 'sub_1',
          event: 'status_changed',
          fromStatus: 'incomplete',
          toStatus: 'active',
          context: {},
          actorUserId: null,
          actorKind: 'mystery',
          source: 'evt_x',
          occurredAt: NOW,
        },
      ],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_1', now: NOW });
    expect(detail!.history[0]!.actorKind).toBe('system');
  });

  it('coerces a non-object context to an empty record', async () => {
    const prisma = buildFakePrisma({
      subscriptions: [makeSubscriptionRow({ id: 'sub_1' })],
      plans: [makePlanRow()],
      history: [
        {
          id: 'hist_1',
          subscriptionId: 'sub_1',
          event: 'created',
          fromStatus: null,
          toStatus: 'active',
          context: 'not-an-object',
          actorUserId: 'usr_a',
          actorKind: 'user',
          source: null,
          occurredAt: NOW,
        },
      ],
    });
    const svc = new AdminSubscriptionsService(prisma);

    const detail = await svc.getById({ subscriptionId: 'sub_1', now: NOW });
    expect(detail!.history[0]!.context).toEqual({});
  });
});
