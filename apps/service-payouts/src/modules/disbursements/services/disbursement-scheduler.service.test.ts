import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  PayoutAccountRecord,
  PayoutAccountsService,
} from '../../connect/services/payout-accounts.service';

import { __testing, DisbursementSchedulerService } from './disbursement-scheduler.service';
import { DisbursementsService } from './disbursements.service';
import { PayableBalanceProvider } from './payable-balance.provider';
import { StripeTransfersService } from './stripe-transfers.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3018,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_STUB_ONBOARDING_BASE_URL: 'https://stub.example.test',
    STRIPE_EVENTS_HEADER_NAME: 'x-internal-api-key',
    STRIPE_EVENTS_API_KEY: 'k'.repeat(40),
    PAYOUT_HOLD_DAYS: 2,
    PAYOUT_MIN_AMOUNT_MINOR: 100,
    PAYOUT_DEFAULT_CURRENCY: 'USD',
    PAYOUT_TRANSFERS_HEADER_NAME: 'x-internal-api-key',
    PAYOUT_TRANSFERS_API_KEY: 't'.repeat(40),
    ...overrides,
  };
}

interface FakeDisbursementRow {
  id: string;
  providerId: string;
  stripeAccountId: string;
  stripeTransferId: string | null;
  currency: string;
  amountMinor: bigint;
  idempotencyKey: string;
  sourceEventId: string;
  scheduledFor: Date;
  heldUntil: Date;
  initiatedAt: Date | null;
  paidAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  memo: string | null;
  status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  liveMode: boolean;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  rows: FakeDisbursementRow[] = [];
  private idCounter = 0;

  payoutDisbursement = {
    findUnique: async (args: {
      where: {
        id?: string;
        idempotencyKey?: string;
        sourceEventId?: string;
        stripeTransferId?: string;
      };
    }): Promise<FakeDisbursementRow | null> => {
      const w = args.where;
      return (
        this.rows.find((r) => {
          if (w.id !== undefined) return r.id === w.id;
          if (w.idempotencyKey !== undefined) return r.idempotencyKey === w.idempotencyKey;
          if (w.sourceEventId !== undefined) return r.sourceEventId === w.sourceEventId;
          if (w.stripeTransferId !== undefined) return r.stripeTransferId === w.stripeTransferId;
          return false;
        }) ?? null
      );
    },
    create: async (args: {
      data: Partial<FakeDisbursementRow> & { amountMinor: bigint };
    }): Promise<FakeDisbursementRow> => {
      const d = args.data;
      if (
        this.rows.some(
          (r) => r.idempotencyKey === d.idempotencyKey || r.sourceEventId === d.sourceEventId,
        )
      ) {
        const err: unknown = { code: 'P2002' };
        throw err;
      }
      const now = new Date();
      const row: FakeDisbursementRow = {
        id: `d_${++this.idCounter}`,
        providerId: d.providerId ?? '',
        stripeAccountId: d.stripeAccountId ?? '',
        stripeTransferId: d.stripeTransferId ?? null,
        currency: d.currency ?? 'USD',
        amountMinor: d.amountMinor,
        idempotencyKey: d.idempotencyKey ?? '',
        sourceEventId: d.sourceEventId ?? '',
        scheduledFor: d.scheduledFor ?? now,
        heldUntil: d.heldUntil ?? now,
        initiatedAt: d.initiatedAt ?? null,
        paidAt: d.paidAt ?? null,
        failedAt: d.failedAt ?? null,
        failureReason: d.failureReason ?? null,
        memo: d.memo ?? null,
        status: d.status ?? 'pending',
        liveMode: d.liveMode ?? false,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(row);
      return row;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeDisbursementRow>;
    }): Promise<FakeDisbursementRow> => {
      const row = this.rows.find((r) => r.id === args.where.id);
      if (row === undefined) throw new Error('not found');
      Object.assign(row, args.data);
      return row;
    },
    findMany: async (): Promise<FakeDisbursementRow[]> => [...this.rows],
  };
}

class FakeAccountsService {
  accounts = new Map<string, PayoutAccountRecord>();

  async getByProvider(providerId: string): Promise<PayoutAccountRecord | null> {
    return this.accounts.get(providerId) ?? null;
  }

  seed(providerId: string, status: PayoutAccountRecord['status']): void {
    this.accounts.set(providerId, {
      id: `acc_${providerId}`,
      providerId,
      stripeAccountId: `acct_stub_${providerId}`,
      country: 'US',
      defaultCurrency: 'USD',
      status,
      chargesEnabled: status === 'active',
      payoutsEnabled: status === 'active',
      detailsSubmitted: status !== 'pending_onboarding',
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      disabledReason: null,
      liveMode: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

function makeScheduler(args: {
  env?: Env;
  prisma?: FakePrisma;
  accounts?: FakeAccountsService;
  balances?: PayableBalanceProvider;
}): {
  scheduler: DisbursementSchedulerService;
  prisma: FakePrisma;
  accounts: FakeAccountsService;
  balances: PayableBalanceProvider;
} {
  const env = args.env ?? buildEnv();
  const prisma = args.prisma ?? new FakePrisma();
  const accounts = args.accounts ?? new FakeAccountsService();
  const balances = args.balances ?? new PayableBalanceProvider();
  const disbursements = new DisbursementsService(
    prisma as unknown as PrismaService,
    accounts as unknown as PayoutAccountsService,
    new StripeTransfersService(env),
  );
  const scheduler = new DisbursementSchedulerService(
    env,
    disbursements,
    accounts as unknown as PayoutAccountsService,
    balances,
  );
  return { scheduler, prisma, accounts, balances };
}

describe('DisbursementSchedulerService.runSweep — gates', () => {
  let scheduler: DisbursementSchedulerService;
  let accounts: FakeAccountsService;
  let balances: PayableBalanceProvider;
  let prisma: FakePrisma;

  beforeEach(() => {
    const built = makeScheduler({});
    scheduler = built.scheduler;
    accounts = built.accounts;
    balances = built.balances;
    prisma = built.prisma;
  });

  it('skips a provider with no payout account', async () => {
    balances.setBalance({
      providerId: 'pr_ghost',
      currency: 'USD',
      amountMinor: 10_000,
      lastUpdatedAt: new Date('2026-05-10T00:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    expect(result.perProvider).toHaveLength(1);
    expect(result.perProvider[0]?.decision).toBe('skipped_no_account');
    expect(result.scheduledCount).toBe(0);
  });

  it('skips a provider whose payout account is not active', async () => {
    accounts.seed('pr_restricted', 'restricted');
    balances.setBalance({
      providerId: 'pr_restricted',
      currency: 'USD',
      amountMinor: 10_000,
      lastUpdatedAt: new Date('2026-05-10T00:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    expect(result.perProvider[0]?.decision).toBe('skipped_account_not_active');
  });

  it('skips a provider with no balance row when in allow-list', async () => {
    accounts.seed('pr_a', 'active');
    const result = await scheduler.runSweep({
      asOfDate: '2026-05-16',
      providerIds: ['pr_a'],
    });
    expect(result.perProvider[0]?.decision).toBe('skipped_no_balance');
  });

  it('skips below threshold', async () => {
    accounts.seed('pr_a', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 50,
      lastUpdatedAt: new Date('2026-05-10T00:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    expect(result.perProvider[0]?.decision).toBe('skipped_below_threshold');
    expect(result.perProvider[0]?.amountMinor).toBe(50);
  });

  it('skips when the hold window has not cleared', async () => {
    accounts.seed('pr_a', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 10_000,
      // Last credit landed today — hold window NOT cleared at asOf=today
      // because (asOf+1d) - holdDays=2d = (today-1d) and today >= today-1d
      // → still inside hold.
      lastUpdatedAt: new Date('2026-05-16T10:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    expect(result.perProvider[0]?.decision).toBe('skipped_hold_not_cleared');
  });

  it('schedules a provider whose hold is cleared', async () => {
    accounts.seed('pr_a', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 10_000,
      // 5 days before the sweep — well past the T+2 hold.
      lastUpdatedAt: new Date('2026-05-11T00:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    expect(result.scheduledCount).toBe(1);
    expect(result.totalScheduledAmountMinor).toBe(10_000);
    const summary = result.perProvider[0];
    expect(summary?.decision).toBe('scheduled');
    expect(summary?.scheduledDisbursementId).not.toBeNull();
    expect(prisma.rows.length).toBe(1);
    expect(prisma.rows[0]?.idempotencyKey).toBe('sweep:2026-05-16:pr_a');
  });

  it('dry-run reports decisions without scheduling', async () => {
    accounts.seed('pr_a', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 10_000,
      lastUpdatedAt: new Date('2026-05-11T00:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16', dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.scheduledCount).toBe(0);
    expect(result.perProvider[0]?.decision).toBe('skipped_dry_run');
    expect(prisma.rows.length).toBe(0);
  });

  it('honours holdDays override (0 = no hold)', async () => {
    accounts.seed('pr_a', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 10_000,
      lastUpdatedAt: new Date('2026-05-15T22:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16', holdDays: 0 });
    expect(result.scheduledCount).toBe(1);
  });

  it('honours minAmountMinor override', async () => {
    accounts.seed('pr_a', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 50,
      lastUpdatedAt: new Date('2026-05-11T00:00:00Z'),
    });
    const result = await scheduler.runSweep({
      asOfDate: '2026-05-16',
      minAmountMinor: 10,
    });
    expect(result.scheduledCount).toBe(1);
  });

  it('sweep is idempotent across re-runs of the same date', async () => {
    accounts.seed('pr_a', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 10_000,
      lastUpdatedAt: new Date('2026-05-11T00:00:00Z'),
    });
    const first = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    const second = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    expect(first.scheduledCount).toBe(1);
    expect(second.scheduledCount).toBe(0);
    expect(second.idempotentExistingCount).toBe(1);
    expect(prisma.rows.length).toBe(1);
  });

  it('returns considered counts equal to candidates', async () => {
    accounts.seed('pr_a', 'active');
    accounts.seed('pr_b', 'active');
    balances.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 10_000,
      lastUpdatedAt: new Date('2026-05-11T00:00:00Z'),
    });
    balances.setBalance({
      providerId: 'pr_b',
      currency: 'USD',
      amountMinor: 50,
      lastUpdatedAt: new Date('2026-05-11T00:00:00Z'),
    });
    const result = await scheduler.runSweep({ asOfDate: '2026-05-16' });
    expect(result.consideredProviderCount).toBe(2);
    expect(result.scheduledCount).toBe(1);
    expect(result.skippedCount).toBe(1);
  });
});

describe('helpers', () => {
  it('buildSweepIdempotencyKey produces sweep:YYYY-MM-DD:<providerId>', () => {
    const key = __testing.buildSweepIdempotencyKey(new Date(Date.UTC(2026, 4, 16)), 'pr_abc');
    expect(key).toBe('sweep:2026-05-16:pr_abc');
  });

  it('parseCalendarDate parses YYYY-MM-DD to UTC midnight', () => {
    const out = __testing.parseCalendarDate('2026-05-16');
    expect(out.toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });
});
