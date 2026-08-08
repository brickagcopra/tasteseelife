import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { SaasMetricsService } from './saas-metrics.service';

type CustomerGroup = 'family' | 'provider' | 'academy';

/** Exactly one average month in ms (365.25 / 12 days) so a balance over
 * this window normalises to its face value exactly — keeps the test math
 * legible. */
const ONE_MONTH_MS = 2_629_800_000;
const PERIOD_START = new Date('2026-05-01T00:00:00.000Z');
const PERIOD_END = new Date(PERIOD_START.getTime() + ONE_MONTH_MS);
const AS_OF = new Date('2026-05-28T02:00:00.000Z');
const METRIC_DATE = new Date(Date.UTC(2026, 4, 28));
const PRIOR_DATE = new Date(Date.UTC(2026, 4, 27));

interface BalanceRow {
  subscriptionId: string;
  customerGroup: CustomerGroup;
  planCode: string;
  originalAmount: Decimal;
  currency: string;
  servicePeriodStart: Date;
  servicePeriodEnd: Date;
  status: 'active' | 'fully_recognized' | 'canceled' | 'paused';
  /** TS-042-followup-3b2 — netted off the period by the normaliser. */
  pausedDurationSeconds: number;
}

interface SubSnapshotRow {
  metricDate: Date;
  subscriptionId: string;
  customerGroup: CustomerGroup;
  planCode: string;
  mrr: Decimal;
  currency: string;
}

interface MetricsRow {
  metricDate: Date;
  [key: string]: unknown;
}

function balance(
  subscriptionId: string,
  amount: string,
  overrides: Partial<BalanceRow> = {},
): BalanceRow {
  return {
    subscriptionId,
    customerGroup: 'family',
    planCode: 'family.tier2',
    originalAmount: new Decimal(amount),
    currency: 'USD',
    servicePeriodStart: PERIOD_START,
    servicePeriodEnd: PERIOD_END,
    status: 'active',
    pausedDurationSeconds: 0,
    ...overrides,
  };
}

class FakePrisma {
  public balances: BalanceRow[] = [];
  public subSnapshots: SubSnapshotRow[] = [];
  public metricsRows: MetricsRow[] = [];

  deferredRevenueBalance = {
    findMany: vi.fn(
      async (args: {
        where: {
          status: 'active';
          servicePeriodStart: { lte: Date };
          servicePeriodEnd: { gte: Date };
        };
      }): Promise<BalanceRow[]> =>
        this.balances.filter(
          (b) =>
            b.status === args.where.status &&
            b.servicePeriodStart.getTime() <= args.where.servicePeriodStart.lte.getTime() &&
            b.servicePeriodEnd.getTime() >= args.where.servicePeriodEnd.gte.getTime(),
        ),
    ),
  };

  saasSubscriptionMrrDaily = {
    findFirst: vi.fn(
      async (args: {
        where: { metricDate: { lt: Date } };
      }): Promise<{ metricDate: Date } | null> => {
        const earlier = this.subSnapshots
          .filter((r) => r.metricDate.getTime() < args.where.metricDate.lt.getTime())
          .sort((a, b) => b.metricDate.getTime() - a.metricDate.getTime());
        return earlier[0] === undefined ? null : { metricDate: earlier[0].metricDate };
      },
    ),
    findMany: vi.fn(
      async (args: {
        where: { metricDate: Date };
      }): Promise<Array<{ subscriptionId: string; mrr: Decimal }>> =>
        this.subSnapshots
          .filter((r) => r.metricDate.getTime() === args.where.metricDate.getTime())
          .map((r) => ({ subscriptionId: r.subscriptionId, mrr: r.mrr })),
    ),
    deleteMany: vi.fn(async (args: { where: { metricDate: Date } }): Promise<unknown> => {
      this.subSnapshots = this.subSnapshots.filter(
        (r) => r.metricDate.getTime() !== args.where.metricDate.getTime(),
      );
      return { count: 0 };
    }),
    createMany: vi.fn(async (args: { data: SubSnapshotRow[] }): Promise<unknown> => {
      this.subSnapshots.push(...args.data.map((d) => ({ ...d })));
      return { count: args.data.length };
    }),
  };

  saasMetricsDaily = {
    upsert: vi.fn(
      async (args: {
        where: { metricDate: Date };
        create: MetricsRow;
        update: Record<string, unknown>;
      }): Promise<unknown> => {
        const existing = this.metricsRows.find(
          (r) => r.metricDate.getTime() === args.where.metricDate.getTime(),
        );
        if (existing === undefined) {
          this.metricsRows.push({ ...args.create });
        } else {
          Object.assign(existing, args.update);
        }
        return {};
      },
    ),
    findMany: vi.fn(
      async (args: {
        where?: { metricDate?: { gte?: Date; lte?: Date } };
        orderBy: { metricDate: 'desc' };
        take: number;
      }): Promise<MetricsRow[]> => {
        const gte = args.where?.metricDate?.gte;
        const lte = args.where?.metricDate?.lte;
        return this.metricsRows
          .filter(
            (r) =>
              (gte === undefined || r.metricDate.getTime() >= gte.getTime()) &&
              (lte === undefined || r.metricDate.getTime() <= lte.getTime()),
          )
          .sort((a, b) => b.metricDate.getTime() - a.metricDate.getTime())
          .slice(0, args.take);
      },
    ),
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function makeService(fake: FakePrisma): SaasMetricsService {
  return new SaasMetricsService(fake as unknown as PrismaService);
}

describe('SaasMetricsService.computeForDate', () => {
  let fake: FakePrisma;
  let service: SaasMetricsService;

  beforeEach(() => {
    fake = new FakePrisma();
    service = makeService(fake);
  });

  it('computes the first-run snapshot (no prior baseline)', async () => {
    fake.balances = [balance('s1', '29.00'), balance('s2', '199.00')];

    const { metrics, subscriptionsSnapshotted } = await service.computeForDate(AS_OF);

    expect(metrics.metricDate).toBe('2026-05-28');
    expect(metrics.currency).toBe('USD');
    expect(metrics.activeSubscriptions).toBe(2);
    expect(subscriptionsSnapshotted).toBe(2);
    // MRR = 29.00 + 199.00 = 228.00 → 22800 minor; ARR ×12 = 273600 minor.
    expect(metrics.mrrMinor).toBe(22_800);
    expect(metrics.arrMinor).toBe(273_600);
    // ARPU = 228.00 / 2 = 114.00 → 11400 minor.
    expect(metrics.arpuMinor).toBe(11_400);
    // First run → everything is new, no movement, no retention.
    expect(metrics.newMrrMinor).toBe(22_800);
    expect(metrics.expansionMrrMinor).toBe(0);
    expect(metrics.contractionMrrMinor).toBe(0);
    expect(metrics.churnedMrrMinor).toBe(0);
    expect(metrics.churnedSubscriptions).toBe(0);
    expect(metrics.netNewMrrMinor).toBe(22_800);
    expect(metrics.priorMrrMinor).toBe(0);
    expect(metrics.netRevenueRetentionPpm).toBeNull();
    expect(metrics.grossRevenueRetentionPpm).toBeNull();
    expect(metrics.ltvMinor).toBeNull();
    expect(metrics.cacMinor).toBeNull();
    expect(metrics.comparisonDate).toBeNull();
    expect(metrics.computedAt).toBe('2026-05-28T02:00:00.000Z');
  });

  it('persists the daily row + per-subscription snapshot in one pass', async () => {
    fake.balances = [balance('s1', '29.00'), balance('s2', '199.00')];

    await service.computeForDate(AS_OF);

    expect(fake.metricsRows).toHaveLength(1);
    expect(fake.metricsRows[0]?.metricDate.getTime()).toBe(METRIC_DATE.getTime());
    expect(fake.subSnapshots).toHaveLength(2);
    expect(fake.subSnapshots.map((r) => r.subscriptionId).sort()).toEqual(['s1', 's2']);
    expect(fake.saasSubscriptionMrrDaily.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('decomposes new / expansion / contraction / churn against the prior snapshot', async () => {
    fake.subSnapshots = [
      snapshot('keep', '100.00'),
      snapshot('grow', '100.00'),
      snapshot('shrink', '100.00'),
      snapshot('gone', '80.00'),
    ];
    fake.balances = [
      balance('keep', '100.00'),
      balance('grow', '150.00'),
      balance('shrink', '60.00'),
      balance('fresh', '30.00'),
    ];

    const { metrics } = await service.computeForDate(AS_OF);

    // today MRR = 100 + 150 + 60 + 30 = 340.00
    expect(metrics.mrrMinor).toBe(34_000);
    expect(metrics.activeSubscriptions).toBe(4);
    expect(metrics.arpuMinor).toBe(8_500); // 340 / 4 = 85.00
    expect(metrics.newMrrMinor).toBe(3_000); // fresh
    expect(metrics.expansionMrrMinor).toBe(5_000); // grow +50
    expect(metrics.contractionMrrMinor).toBe(4_000); // shrink -40
    expect(metrics.churnedMrrMinor).toBe(8_000); // gone
    expect(metrics.churnedSubscriptions).toBe(1);
    expect(metrics.priorMrrMinor).toBe(38_000); // 100+100+100+80
    expect(metrics.netNewMrrMinor).toBe(-4_000); // 30 + 50 − 40 − 80
    expect(metrics.comparisonDate).toBe('2026-05-27');
    // NRR = (380 + 50 − 40 − 80) / 380 = 310/380 = 0.815789
    expect(metrics.netRevenueRetentionPpm).toBe(815_789);
    // GRR = (380 − 40 − 80) / 380 = 260/380 = 0.684211
    expect(metrics.grossRevenueRetentionPpm).toBe(684_211);
  });

  it('skips non-USD balances and warns', async () => {
    fake.balances = [balance('s1', '29.00'), balance('eur', '50.00', { currency: 'EUR' })];

    const { metrics, subscriptionsSnapshotted } = await service.computeForDate(AS_OF);

    expect(metrics.activeSubscriptions).toBe(1);
    expect(subscriptionsSnapshotted).toBe(1);
    expect(metrics.mrrMinor).toBe(2_900);
    expect(fake.subSnapshots.map((r) => r.subscriptionId)).toEqual(['s1']);
  });

  it('excludes a balance with a degenerate (zero/inverted) period', async () => {
    fake.balances = [
      balance('s1', '29.00'),
      balance('bad', '99.00', {
        servicePeriodStart: PERIOD_END,
        servicePeriodEnd: PERIOD_END, // zero-length → 0 MRR
      }),
    ];

    const { metrics } = await service.computeForDate(AS_OF);

    // The degenerate balance does not match the covering filter
    // (servicePeriodStart <= asOf is false), so it never reaches the
    // normaliser — assert via the active-sub count regardless.
    expect(metrics.activeSubscriptions).toBe(1);
    expect(metrics.mrrMinor).toBe(2_900);
  });

  it('sums multiple active balances for the same subscription', async () => {
    fake.balances = [balance('s1', '29.00'), balance('s1', '10.00')];

    const { metrics } = await service.computeForDate(AS_OF);

    expect(metrics.activeSubscriptions).toBe(1);
    expect(metrics.mrrMinor).toBe(3_900); // 29 + 10
    expect(fake.subSnapshots).toHaveLength(1);
  });

  it('is idempotent on recompute for the same date (upsert + snapshot replace)', async () => {
    fake.balances = [balance('s1', '29.00')];

    await service.computeForDate(AS_OF);
    await service.computeForDate(AS_OF);

    expect(fake.metricsRows).toHaveLength(1);
    expect(fake.subSnapshots).toHaveLength(1);
    expect(fake.saasSubscriptionMrrDaily.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('handles an empty ledger (zero active balances)', async () => {
    const { metrics, subscriptionsSnapshotted } = await service.computeForDate(AS_OF);

    expect(metrics.activeSubscriptions).toBe(0);
    expect(subscriptionsSnapshotted).toBe(0);
    expect(metrics.mrrMinor).toBe(0);
    expect(metrics.arpuMinor).toBe(0);
    expect(metrics.newMrrMinor).toBe(0);
    expect(fake.subSnapshots).toHaveLength(0);
    expect(fake.metricsRows).toHaveLength(1);
  });
});

function snapshot(subscriptionId: string, mrr: string): SubSnapshotRow {
  return {
    metricDate: PRIOR_DATE,
    subscriptionId,
    customerGroup: 'family',
    planCode: 'family.tier2',
    mrr: new Decimal(mrr),
    currency: 'USD',
  };
}

function metricsRow(metricDate: Date, overrides: Partial<MetricsRow> = {}): MetricsRow {
  return {
    metricDate,
    currency: 'USD',
    mrr: new Decimal('228.00'),
    arr: new Decimal('2736.00'),
    arpu: new Decimal('114.00'),
    activeSubscriptions: 2,
    newMrr: new Decimal('0'),
    expansionMrr: new Decimal('0'),
    contractionMrr: new Decimal('0'),
    churnedMrr: new Decimal('0'),
    churnedSubscriptions: 0,
    netNewMrr: new Decimal('0'),
    priorMrr: new Decimal('228.00'),
    netRevenueRetention: new Decimal('1.027100'),
    grossRevenueRetention: new Decimal('0.992547'),
    ltv: null,
    cac: null,
    comparisonDate: null,
    computedAt: new Date('2026-05-28T02:00:00.000Z'),
    ...overrides,
  };
}

describe('SaasMetricsService.listForDateRange', () => {
  let fake: FakePrisma;
  let service: SaasMetricsService;

  beforeEach(() => {
    fake = new FakePrisma();
    service = makeService(fake);
  });

  it('returns an empty series + null bounds when no snapshots exist', async () => {
    const result = await service.listForDateRange({});
    expect(result.metrics).toEqual([]);
    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
  });

  it('returns the series in ascending metricDate order with echoed bounds', async () => {
    // Seed out of order; the b-tree scan is desc, the service reverses to asc.
    fake.metricsRows = [
      metricsRow(new Date(Date.UTC(2026, 4, 27))),
      metricsRow(new Date(Date.UTC(2026, 4, 25))),
      metricsRow(new Date(Date.UTC(2026, 4, 26))),
    ];

    const result = await service.listForDateRange({});

    expect(result.metrics.map((m) => m.metricDate)).toEqual([
      '2026-05-25',
      '2026-05-26',
      '2026-05-27',
    ]);
    expect(result.from).toBe('2026-05-25');
    expect(result.to).toBe('2026-05-27');
  });

  it('maps decimals to minor units and ratios to ppm', async () => {
    fake.metricsRows = [metricsRow(new Date(Date.UTC(2026, 4, 28)))];

    const result = await service.listForDateRange({});
    const record = result.metrics[0];

    expect(record?.mrrMinor).toBe(22_800);
    expect(record?.arrMinor).toBe(273_600);
    expect(record?.arpuMinor).toBe(11_400);
    expect(record?.netRevenueRetentionPpm).toBe(1_027_100);
    expect(record?.grossRevenueRetentionPpm).toBe(992_547);
    expect(record?.ltvMinor).toBeNull();
    expect(record?.cacMinor).toBeNull();
    expect(record?.comparisonDate).toBeNull();
    expect(record?.computedAt).toBe('2026-05-28T02:00:00.000Z');
  });

  it('preserves a non-null comparisonDate and retention nulls', async () => {
    fake.metricsRows = [
      metricsRow(new Date(Date.UTC(2026, 4, 28)), {
        comparisonDate: new Date(Date.UTC(2026, 4, 27)),
        netRevenueRetention: null,
        grossRevenueRetention: null,
      }),
    ];

    const result = await service.listForDateRange({});
    const record = result.metrics[0];

    expect(record?.comparisonDate).toBe('2026-05-27');
    expect(record?.netRevenueRetentionPpm).toBeNull();
    expect(record?.grossRevenueRetentionPpm).toBeNull();
  });

  it('applies the inclusive from/to date filter (midnight-UTC bounds)', async () => {
    fake.metricsRows = [
      metricsRow(new Date(Date.UTC(2026, 4, 24))),
      metricsRow(new Date(Date.UTC(2026, 4, 26))),
      metricsRow(new Date(Date.UTC(2026, 4, 28))),
    ];

    const result = await service.listForDateRange({
      from: new Date(Date.UTC(2026, 4, 25)),
      to: new Date(Date.UTC(2026, 4, 27)),
    });

    expect(result.metrics.map((m) => m.metricDate)).toEqual(['2026-05-26']);
    const call = fake.saasMetricsDaily.findMany.mock.calls[0]?.[0];
    expect(call?.where?.metricDate?.gte?.getTime()).toBe(Date.UTC(2026, 4, 25));
    expect(call?.where?.metricDate?.lte?.getTime()).toBe(Date.UTC(2026, 4, 27));
  });

  it('omits the where clause entirely when neither bound is supplied', async () => {
    fake.metricsRows = [metricsRow(new Date(Date.UTC(2026, 4, 28)))];

    await service.listForDateRange({});

    const call = fake.saasMetricsDaily.findMany.mock.calls[0]?.[0];
    expect(call?.where).toBeUndefined();
    expect(call?.take).toBe(400);
    expect(call?.orderBy).toEqual({ metricDate: 'desc' });
  });
});
