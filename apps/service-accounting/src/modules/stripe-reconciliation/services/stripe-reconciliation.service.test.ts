import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';

import type { StripeDayReport, StripeReportReader } from './stripe-report-reader.service';
import { StripeReconciliationService } from './stripe-reconciliation.service';

function buildEnv(toleranceMinor = 0): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3015,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    SERVICE_VERSION: 'test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 30,
    INTERNAL_POST_JOURNAL_API_KEY: 'k'.repeat(32),
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: toleranceMinor,
  } as Env;
}

interface CheckRow {
  id: string;
  reconciliationDate: Date;
  category: 'balance' | 'activity';
  status: 'matched' | 'mismatch_open' | 'mismatch_resolved' | 'skipped_stub';
  mode: 'live' | 'stub';
  currency: string;
  expectedAmount: string;
  actualAmount: string | null;
  deltaAmount: string | null;
  toleranceAmount: string;
  stripeTransactionCount: number | null;
  windowStart: Date;
  windowEnd: Date;
  detail: string;
  computedAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolutionNotes: string | null;
}

class FakePrisma {
  cashAccountId: string | null = 'acct_cash';
  /** Ledger Cash net balance (minor units), all-time. */
  balanceMinor = 0;
  /** Ledger Cash net movement (minor units), windowed. */
  movementMinor = 0;
  rows: CheckRow[] = [];
  private seq = 0;

  chartOfAccount = {
    findUnique: vi.fn(async (_args: { where: { code: string } }) =>
      this.cashAccountId === null ? null : { id: this.cashAccountId },
    ),
  };

  journalLine = {
    aggregate: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const minor = 'journal' in args.where ? this.movementMinor : this.balanceMinor;
      return { _sum: { debit: new Decimal(minor).div(100), credit: new Decimal(0) } };
    }),
  };

  stripeReconciliationCheck = {
    findUnique: vi.fn(
      async (args: {
        where: {
          id?: string;
          reconciliation_date_category_unique?: {
            reconciliationDate: Date;
            category: string;
          };
        };
      }) => {
        if (args.where.id !== undefined) {
          const id = args.where.id;
          return this.rows.find((r) => r.id === id) ?? null;
        }
        const key = args.where.reconciliation_date_category_unique!;
        return (
          this.rows.find(
            (r) =>
              r.reconciliationDate.getTime() === key.reconciliationDate.getTime() &&
              r.category === key.category,
          ) ?? null
        );
      },
    ),
    upsert: vi.fn(
      async (args: {
        where: {
          reconciliation_date_category_unique: { reconciliationDate: Date; category: string };
        };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = args.where.reconciliation_date_category_unique;
        const idx = this.rows.findIndex(
          (r) =>
            r.reconciliationDate.getTime() === key.reconciliationDate.getTime() &&
            r.category === key.category,
        );
        if (idx >= 0) {
          this.rows[idx] = { ...this.rows[idx]!, ...(args.update as Partial<CheckRow>) };
          return this.rows[idx];
        }
        const row: CheckRow = {
          ...(args.create as unknown as CheckRow),
          id: `chk_${this.seq++}`,
        };
        this.rows.push(row);
        return row;
      },
    ),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const idx = this.rows.findIndex((r) => r.id === args.where.id);
      if (idx < 0) throw new Error('not found');
      this.rows[idx] = { ...this.rows[idx]!, ...(args.data as Partial<CheckRow>) };
      return this.rows[idx];
    }),
    findMany: vi.fn(
      async (args: {
        where: { status?: string; reconciliationDate?: { gte?: Date; lte?: Date } };
        take: number;
      }) => {
        let out = [...this.rows];
        if (args.where.status !== undefined) {
          out = out.filter((r) => r.status === args.where.status);
        }
        const range = args.where.reconciliationDate;
        if (range?.gte !== undefined) {
          out = out.filter((r) => r.reconciliationDate.getTime() >= range.gte!.getTime());
        }
        if (range?.lte !== undefined) {
          out = out.filter((r) => r.reconciliationDate.getTime() <= range.lte!.getTime());
        }
        out.sort((a, b) => {
          const d = b.reconciliationDate.getTime() - a.reconciliationDate.getTime();
          if (d !== 0) return d;
          return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
        });
        return out.slice(0, args.take);
      },
    ),
  };
}

function fakeReader(report: StripeDayReport | null): StripeReportReader {
  return { read: vi.fn(async () => report) } as unknown as StripeReportReader;
}

const AS_OF = new Date('2026-05-28T12:00:00.000Z');

function build(
  prisma: FakePrisma,
  report: StripeDayReport | null,
  env: Env = buildEnv(),
): StripeReconciliationService {
  return new StripeReconciliationService(
    prisma as unknown as PrismaService,
    fakeReader(report),
    env,
  );
}

describe('StripeReconciliationService.reconcile', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = new FakePrisma();
  });

  it('records skipped_stub checks with null Stripe figures in stub mode', async () => {
    prisma.balanceMinor = 100_000;
    prisma.movementMinor = 25_000;
    const svc = build(prisma, null);

    const result = await svc.reconcile({ asOf: AS_OF });

    expect(result.mode).toBe('stub');
    expect(result.reconciliationDate).toBe('2026-05-28');
    expect(result.openMismatchCount).toBe(0);
    expect(result.checks).toHaveLength(2);
    const balance = result.checks.find((c) => c.category === 'balance')!;
    expect(balance.status).toBe('skipped_stub');
    expect(balance.mode).toBe('stub');
    expect(balance.expectedAmountMinor).toBe(100_000);
    expect(balance.actualAmountMinor).toBeNull();
    expect(balance.deltaAmountMinor).toBeNull();
    expect(balance.stripeTransactionCount).toBeNull();
    const activity = result.checks.find((c) => c.category === 'activity')!;
    expect(activity.expectedAmountMinor).toBe(25_000);
    expect(activity.status).toBe('skipped_stub');
  });

  it('records matched checks when Stripe agrees with the ledger', async () => {
    prisma.balanceMinor = 100_000;
    prisma.movementMinor = 25_000;
    const svc = build(prisma, {
      balanceMinor: 100_000,
      activityNetMinor: 25_000,
      transactionCount: 7,
    });

    const result = await svc.reconcile({ asOf: AS_OF });

    expect(result.mode).toBe('live');
    expect(result.openMismatchCount).toBe(0);
    const balance = result.checks.find((c) => c.category === 'balance')!;
    expect(balance.status).toBe('matched');
    expect(balance.actualAmountMinor).toBe(100_000);
    expect(balance.deltaAmountMinor).toBe(0);
    expect(balance.stripeTransactionCount).toBeNull();
    const activity = result.checks.find((c) => c.category === 'activity')!;
    expect(activity.status).toBe('matched');
    expect(activity.actualAmountMinor).toBe(25_000);
    expect(activity.stripeTransactionCount).toBe(7);
  });

  it('opens a mismatch ticket when Stripe diverges beyond tolerance', async () => {
    prisma.balanceMinor = 100_000;
    prisma.movementMinor = 25_000;
    const svc = build(prisma, {
      balanceMinor: 99_000,
      activityNetMinor: 25_000,
      transactionCount: 7,
    });

    const result = await svc.reconcile({ asOf: AS_OF });

    expect(result.openMismatchCount).toBe(1);
    const balance = result.checks.find((c) => c.category === 'balance')!;
    expect(balance.status).toBe('mismatch_open');
    expect(balance.actualAmountMinor).toBe(99_000);
    expect(balance.deltaAmountMinor).toBe(-1_000);
    const activity = result.checks.find((c) => c.category === 'activity')!;
    expect(activity.status).toBe('matched');
  });

  it('treats a divergence within tolerance as matched', async () => {
    prisma.balanceMinor = 100_000;
    prisma.movementMinor = 25_000;
    const svc = build(
      prisma,
      { balanceMinor: 100_050, activityNetMinor: 25_000, transactionCount: 1 },
      buildEnv(100),
    );

    const result = await svc.reconcile({ asOf: AS_OF });

    expect(result.openMismatchCount).toBe(0);
    expect(result.checks.find((c) => c.category === 'balance')!.status).toBe('matched');
  });

  it('is idempotent: a re-run upserts the same (date, category) rows', async () => {
    prisma.balanceMinor = 100_000;
    prisma.movementMinor = 25_000;
    const svc = build(prisma, {
      balanceMinor: 100_000,
      activityNetMinor: 25_000,
      transactionCount: 3,
    });

    await svc.reconcile({ asOf: AS_OF });
    await svc.reconcile({ asOf: AS_OF });

    expect(prisma.rows).toHaveLength(2);
  });

  it('preserves a human resolution when a re-run still mismatches', async () => {
    prisma.balanceMinor = 100_000;
    // Seed a previously-resolved balance ticket that still diverges.
    prisma.rows.push({
      id: 'chk_existing',
      reconciliationDate: new Date('2026-05-28T00:00:00.000Z'),
      category: 'balance',
      status: 'mismatch_resolved',
      mode: 'live',
      currency: 'USD',
      expectedAmount: '1000.00',
      actualAmount: '990.00',
      deltaAmount: '-10.00',
      toleranceAmount: '0.00',
      stripeTransactionCount: null,
      windowStart: new Date('2026-05-28T00:00:00.000Z'),
      windowEnd: new Date('2026-05-29T00:00:00.000Z'),
      detail: 'prior',
      computedAt: new Date('2026-05-29T03:00:00.000Z'),
      resolvedAt: new Date('2026-05-29T10:00:00.000Z'),
      resolvedByUserId: 'user_ops',
      resolutionNotes: 'Known timing gap — accepted.',
    });
    const svc = build(prisma, {
      balanceMinor: 99_000,
      activityNetMinor: 0,
      transactionCount: 0,
    });

    const result = await svc.reconcile({ asOf: AS_OF });

    const balance = result.checks.find((c) => c.category === 'balance')!;
    expect(balance.status).toBe('mismatch_resolved');
    expect(balance.resolvedByUserId).toBe('user_ops');
    expect(balance.resolutionNotes).toBe('Known timing gap — accepted.');
    // A still-mismatching but human-resolved ticket is NOT counted as open.
    expect(result.openMismatchCount).toBe(0);
  });

  it('clears a prior resolution when the check newly matches', async () => {
    prisma.balanceMinor = 100_000;
    prisma.rows.push({
      id: 'chk_existing',
      reconciliationDate: new Date('2026-05-28T00:00:00.000Z'),
      category: 'balance',
      status: 'mismatch_resolved',
      mode: 'live',
      currency: 'USD',
      expectedAmount: '1000.00',
      actualAmount: '990.00',
      deltaAmount: '-10.00',
      toleranceAmount: '0.00',
      stripeTransactionCount: null,
      windowStart: new Date('2026-05-28T00:00:00.000Z'),
      windowEnd: new Date('2026-05-29T00:00:00.000Z'),
      detail: 'prior',
      computedAt: new Date('2026-05-29T03:00:00.000Z'),
      resolvedAt: new Date('2026-05-29T10:00:00.000Z'),
      resolvedByUserId: 'user_ops',
      resolutionNotes: 'Known timing gap — accepted.',
    });
    const svc = build(prisma, {
      balanceMinor: 100_000,
      activityNetMinor: 0,
      transactionCount: 0,
    });

    const result = await svc.reconcile({ asOf: AS_OF });

    const balance = result.checks.find((c) => c.category === 'balance')!;
    expect(balance.status).toBe('matched');
    expect(balance.resolvedAt).toBeNull();
    expect(balance.resolvedByUserId).toBeNull();
    expect(balance.resolutionNotes).toBeNull();
  });

  it('defaults to yesterday when no asOf is supplied', async () => {
    const svc = build(prisma, null);
    const result = await svc.reconcile({ now: new Date('2026-05-29T03:00:00.000Z') });
    expect(result.reconciliationDate).toBe('2026-05-28');
  });

  it('throws when the Cash account is not seeded', async () => {
    prisma.cashAccountId = null;
    const svc = build(prisma, null);
    await expect(svc.reconcile({ asOf: AS_OF })).rejects.toThrow(/Cash account/);
  });
});

describe('StripeReconciliationService.listChecks', () => {
  let prisma: FakePrisma;

  beforeEach(async () => {
    prisma = new FakePrisma();
    prisma.balanceMinor = 50_000;
    prisma.movementMinor = 10_000;
    const svc = build(prisma, { balanceMinor: 0, activityNetMinor: 0, transactionCount: 0 });
    await svc.reconcile({ asOf: new Date('2026-05-27T12:00:00.000Z') });
    await svc.reconcile({ asOf: new Date('2026-05-28T12:00:00.000Z') });
  });

  it('returns mapped checks newest-first with the echoed effective window', async () => {
    const svc = build(prisma, null);
    const result = await svc.listChecks({});
    expect(result.checks.length).toBe(4);
    expect(result.to).toBe('2026-05-28');
    expect(result.from).toBe('2026-05-27');
    expect(result.checks[0]!.reconciliationDate).toBe('2026-05-28');
  });

  it('filters by status', async () => {
    const svc = build(prisma, null);
    const result = await svc.listChecks({ status: 'mismatch_open' });
    expect(result.checks.every((c) => c.status === 'mismatch_open')).toBe(true);
  });

  it('returns null bounds for an empty result', async () => {
    const empty = build(new FakePrisma(), null);
    const result = await empty.listChecks({ status: 'matched' });
    expect(result.checks).toHaveLength(0);
    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
  });
});

describe('StripeReconciliationService.resolveCheck', () => {
  let prisma: FakePrisma;

  function seedOpen(): void {
    prisma.rows.push({
      id: 'chk_open',
      reconciliationDate: new Date('2026-05-28T00:00:00.000Z'),
      category: 'balance',
      status: 'mismatch_open',
      mode: 'live',
      currency: 'USD',
      expectedAmount: '1000.00',
      actualAmount: '990.00',
      deltaAmount: '-10.00',
      toleranceAmount: '0.00',
      stripeTransactionCount: null,
      windowStart: new Date('2026-05-28T00:00:00.000Z'),
      windowEnd: new Date('2026-05-29T00:00:00.000Z'),
      detail: 'open',
      computedAt: new Date('2026-05-29T03:00:00.000Z'),
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionNotes: null,
    });
  }

  beforeEach(() => {
    prisma = new FakePrisma();
  });

  it('resolves an open mismatch with actor + notes', async () => {
    seedOpen();
    const svc = build(prisma, null);
    const result = await svc.resolveCheck({
      checkId: 'chk_open',
      actorUserId: 'user_admin',
      resolutionNotes: 'Explained by a delayed payout.',
      now: new Date('2026-05-30T09:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.check.status).toBe('mismatch_resolved');
      expect(result.check.resolvedByUserId).toBe('user_admin');
      expect(result.check.resolutionNotes).toBe('Explained by a delayed payout.');
      expect(result.check.resolvedAt).toBe('2026-05-30T09:00:00.000Z');
    }
  });

  it('returns not_found for an unknown id', async () => {
    const svc = build(prisma, null);
    const result = await svc.resolveCheck({
      checkId: 'nope',
      actorUserId: 'user_admin',
      resolutionNotes: 'x',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns not_open for a check that is not an open mismatch', async () => {
    prisma.rows.push({
      id: 'chk_matched',
      reconciliationDate: new Date('2026-05-28T00:00:00.000Z'),
      category: 'activity',
      status: 'matched',
      mode: 'live',
      currency: 'USD',
      expectedAmount: '0.00',
      actualAmount: '0.00',
      deltaAmount: '0.00',
      toleranceAmount: '0.00',
      stripeTransactionCount: 0,
      windowStart: new Date('2026-05-28T00:00:00.000Z'),
      windowEnd: new Date('2026-05-29T00:00:00.000Z'),
      detail: 'matched',
      computedAt: new Date('2026-05-29T03:00:00.000Z'),
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionNotes: null,
    });
    const svc = build(prisma, null);
    const result = await svc.resolveCheck({
      checkId: 'chk_matched',
      actorUserId: 'user_admin',
      resolutionNotes: 'x',
    });
    expect(result).toEqual({ ok: false, reason: 'not_open' });
  });
});
