import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { AdminDeferredRevenueService } from './admin-deferred-revenue.service';

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

interface StoredBalance {
  readonly id: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly customerGroup: 'family' | 'provider' | 'academy';
  readonly planCode: string;
  readonly currency: string;
  readonly status: 'active' | 'fully_recognized' | 'canceled' | 'paused';
  readonly pausedAt: Date | null;
  readonly pausedDurationSeconds: number;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly originalAmount: string;
  readonly recognizedAmount: string;
}

interface CountArgs {
  readonly where?: {
    readonly status?: string;
    readonly pausedAt?: null;
    readonly servicePeriodEnd?: { readonly lt?: Date };
  };
}

interface FindManyArgs {
  readonly take?: number;
}

/**
 * In-memory `deferred_revenue_balances` that evaluates the three
 * predicates the service actually issues, so a test asserting "the count
 * is not the page size" is asserting against a store that would let it be.
 */
function buildPrismaStub(rows: readonly StoredBalance[]): PrismaService {
  const matches = (row: StoredBalance, args: CountArgs): boolean => {
    const where = args.where ?? {};
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.pausedAt === null && row.pausedAt !== null) return false;
    const before = where.servicePeriodEnd?.lt;
    if (before !== undefined && !(row.servicePeriodEnd.getTime() < before.getTime())) {
      return false;
    }
    return true;
  };

  return {
    deferredRevenueBalance: {
      count: vi.fn(async (args: CountArgs) => rows.filter((r) => matches(r, args)).length),
      aggregate: vi.fn(async (args: CountArgs) => {
        const selected = rows.filter((r) => matches(r, args));
        const sum = (pick: (r: StoredBalance) => string): string =>
          selected.reduce((acc, r) => acc + Math.round(Number(pick(r)) * 100), 0).toString();
        const pausedInstants = selected
          .map((r) => r.pausedAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime());
        return {
          _sum: {
            originalAmount:
              selected.length === 0
                ? null
                : decimal((Number(sum((r) => r.originalAmount)) / 100).toFixed(2)),
            recognizedAmount:
              selected.length === 0
                ? null
                : decimal((Number(sum((r) => r.recognizedAmount)) / 100).toFixed(2)),
          },
          // Postgres MIN skips NULLs.
          _min: { pausedAt: pausedInstants[0] ?? null },
        };
      }),
      findMany: vi.fn(async (args: CountArgs & FindManyArgs) => {
        const selected = rows
          .filter((r) => matches(r, args))
          .slice()
          .sort((a, b) => {
            // NULLS FIRST, then pausedAt ASC, then id ASC.
            if (a.pausedAt === null && b.pausedAt !== null) return -1;
            if (b.pausedAt === null && a.pausedAt !== null) return 1;
            const byPaused = (a.pausedAt?.getTime() ?? 0) - (b.pausedAt?.getTime() ?? 0);
            if (byPaused !== 0) return byPaused;
            return a.id.localeCompare(b.id);
          });
        const page = args.take === undefined ? selected : selected.slice(0, args.take);
        return page.map((r) => ({
          id: r.id,
          subscriptionId: r.subscriptionId,
          customerId: r.customerId,
          customerGroup: r.customerGroup,
          planCode: r.planCode,
          currency: r.currency,
          pausedAt: r.pausedAt,
          pausedDurationSeconds: r.pausedDurationSeconds,
          servicePeriodStart: r.servicePeriodStart,
          servicePeriodEnd: r.servicePeriodEnd,
          originalAmount: decimal(r.originalAmount),
          recognizedAmount: decimal(r.recognizedAmount),
        }));
      }),
    },
  } as unknown as PrismaService;
}

const ASOF = new Date('2026-06-01T00:00:00.000Z');

function paused(overrides: Partial<StoredBalance> = {}): StoredBalance {
  return {
    id: 'drb_1',
    subscriptionId: 'sub_1',
    customerId: 'hh_1',
    customerGroup: 'family',
    planCode: 'family.tier2',
    currency: 'USD',
    status: 'paused',
    pausedAt: new Date('2026-05-25T00:00:00.000Z'),
    pausedDurationSeconds: 0,
    servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
    servicePeriodEnd: new Date('2026-06-15T00:00:00.000Z'),
    originalAmount: '299.00',
    recognizedAmount: '120.00',
    ...overrides,
  };
}

describe('AdminDeferredRevenueService.listPaused', () => {
  it('returns an all-clear view when nothing is paused', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([paused({ status: 'active' })]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.summary.pausedCount).toBe(0);
    expect(view.summary.oldestPausedAt).toBeNull();
    expect(view.summary.totalRemainingDeferredMinor).toBe(0);
    expect(view.balances).toEqual([]);
    expect(view.truncated).toBe(false);
  });

  it('reads only paused rows — an active balance is not stuck', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([
        paused({ id: 'drb_paused' }),
        paused({ id: 'drb_active', status: 'active' }),
        paused({ id: 'drb_cancelled', status: 'canceled' }),
      ]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.summary.pausedCount).toBe(1);
    expect(view.balances.map((b) => b.balanceId)).toEqual(['drb_paused']);
  });

  it('computes the stranded amount as original minus recognised, in minor units', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([paused({ originalAmount: '299.00', recognizedAmount: '120.55' })]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.balances[0]?.originalAmountMinor).toBe(29_900);
    expect(view.balances[0]?.recognizedAmountMinor).toBe(12_055);
    expect(view.balances[0]?.remainingDeferredMinor).toBe(17_845);
    expect(view.summary.totalRemainingDeferredMinor).toBe(17_845);
  });

  it('measures the current pause age against asOf, truncated to seconds', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([
        paused({ pausedAt: new Date('2026-05-31T23:00:00.000Z'), pausedDurationSeconds: 42 }),
      ]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.balances[0]?.pausedForSeconds).toBe(3_600);
    // Prior windows are a separate number — how much service time has
    // already been given back, not how long it is stopped now.
    expect(view.balances[0]?.priorPausedSeconds).toBe(42);
  });

  it('clamps a pause age to zero when asOf precedes the pause instant', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([paused({ pausedAt: new Date('2026-06-02T00:00:00.000Z') })]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.balances[0]?.pausedForSeconds).toBe(0);
  });

  it('reports a null age — never zero — for a paused row with no pause instant', async () => {
    const service = new AdminDeferredRevenueService(buildPrismaStub([paused({ pausedAt: null })]));

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.balances[0]?.pausedAt).toBeNull();
    expect(view.balances[0]?.pausedForSeconds).toBeNull();
    expect(view.summary.unknownPausedAtCount).toBe(1);
    // Nothing establishes an oldest pause, and the count says why.
    expect(view.summary.oldestPausedAt).toBeNull();
  });

  it('sorts unknown-age rows above the longest-suspended known one', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([
        paused({ id: 'drb_recent', pausedAt: new Date('2026-05-30T00:00:00.000Z') }),
        paused({ id: 'drb_ancient', pausedAt: new Date('2026-01-01T00:00:00.000Z') }),
        paused({ id: 'drb_unknown', pausedAt: null }),
      ]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.balances.map((b) => b.balanceId)).toEqual([
      'drb_unknown',
      'drb_ancient',
      'drb_recent',
    ]);
    // MIN over the known instants only.
    expect(view.summary.oldestPausedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(view.summary.unknownPausedAtCount).toBe(1);
  });

  it('flags a balance whose service period has already ended', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([
        paused({
          id: 'drb_expired',
          servicePeriodEnd: new Date('2026-05-15T00:00:00.000Z'),
        }),
        paused({ id: 'drb_live', servicePeriodEnd: new Date('2026-07-01T00:00:00.000Z') }),
      ]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    const byId = new Map(view.balances.map((b) => [b.balanceId, b]));
    expect(byId.get('drb_expired')?.pastServicePeriodEnd).toBe(true);
    expect(byId.get('drb_live')?.pastServicePeriodEnd).toBe(false);
    expect(view.summary.pastServicePeriodEndCount).toBe(1);
  });

  it('counts and totals over EVERY paused row while enumerating only one page', async () => {
    // The property the surface exists for: a capped enumeration must not
    // cap the answer to "how much revenue is stranded".
    const rows = Array.from({ length: 5 }, (_, i) =>
      paused({
        id: `drb_${i}`,
        pausedAt: new Date(`2026-05-0${i + 1}T00:00:00.000Z`),
        originalAmount: '100.00',
        recognizedAmount: '0.00',
      }),
    );
    const service = new AdminDeferredRevenueService(buildPrismaStub(rows));

    const view = await service.listPaused({ asOf: ASOF, limit: 2 });

    expect(view.balances).toHaveLength(2);
    expect(view.summary.pausedCount).toBe(5);
    expect(view.summary.totalRemainingDeferredMinor).toBe(50_000);
    expect(view.truncated).toBe(true);
  });

  it('does not call a full page truncated', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => paused({ id: `drb_${i}` }));
    const service = new AdminDeferredRevenueService(buildPrismaStub(rows));

    const view = await service.listPaused({ asOf: ASOF, limit: 2 });

    expect(view.balances).toHaveLength(2);
    expect(view.truncated).toBe(false);
  });

  it('never reports a negative stranded amount', async () => {
    const service = new AdminDeferredRevenueService(
      buildPrismaStub([paused({ originalAmount: '100.00', recognizedAmount: '150.00' })]),
    );

    const view = await service.listPaused({ asOf: ASOF, limit: 50 });

    expect(view.balances[0]?.remainingDeferredMinor).toBe(0);
    expect(view.summary.totalRemainingDeferredMinor).toBe(0);
  });
});

describe('AdminDeferredRevenueService.summarizePaused', () => {
  it('answers the stock question without enumerating anything', async () => {
    const prisma = buildPrismaStub([
      paused({ id: 'drb_1' }),
      paused({ id: 'drb_2', servicePeriodEnd: new Date('2026-05-01T00:00:00.000Z') }),
    ]);
    const service = new AdminDeferredRevenueService(prisma);

    const summary = await service.summarizePaused(ASOF);

    expect(summary.pausedCount).toBe(2);
    expect(summary.pastServicePeriodEndCount).toBe(1);
    // The gauge path must not pay for rows it does not read.
    expect(prisma.deferredRevenueBalance.findMany).not.toHaveBeenCalled();
  });
});
