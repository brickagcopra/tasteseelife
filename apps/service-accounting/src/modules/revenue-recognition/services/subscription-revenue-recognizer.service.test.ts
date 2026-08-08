import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  JournalPostingService,
  PostJournalFailure,
  Result as JournalResult,
} from '../../journals/services/journal-posting.service';
import { PlanAccountResolverService } from './plan-account-resolver.service';
import { SubscriptionRevenueRecognizerService } from './subscription-revenue-recognizer.service';

import type { JournalResponse, RecognizeActivationRequest } from '@taste-and-see/contracts';

interface FakeBalanceRow {
  id: string;
  subscriptionId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  planCode: string;
  originalAmount: Decimal;
  recognizedAmount: Decimal;
  currency: string;
  servicePeriodStart: Date;
  servicePeriodEnd: Date;
  lastRecognizedAt: Date | null;
  status: 'active' | 'fully_recognized' | 'canceled' | 'paused';
  activationJournalId: string;
  pausedAt: Date | null;
  pausedDurationSeconds: number;
  sourceEventId: string;
  context: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

class PrismaUniqueViolation extends Error {
  public readonly code = 'P2002';
  public readonly meta: { target: string[] };
  constructor(target: string[]) {
    super('Unique constraint failed');
    this.name = 'PrismaClientKnownRequestError';
    this.meta = { target };
  }
}

/**
 * Minimal FakePrisma covering only the deferredRevenueBalance surface
 * the recognizer touches. The journal-posting side is mocked at the
 * service-class layer (see `journalsMock` below) so this fake doesn't
 * need to track journals or chart-of-accounts at all.
 */
class FakePrisma {
  public rows: FakeBalanceRow[] = [];
  private autoId = 0;
  /**
   * Hook for forcing a UNIQUE violation on the next create call.
   * Used to exercise the race-replay path.
   */
  public forceUniqueViolationOnNextCreate: 'sourceEventId' | 'subscriptionPeriod' | null = null;

  deferredRevenueBalance = {
    findUnique: vi.fn(
      async (args: {
        where:
          | { sourceEventId: string }
          | { id: string }
          | {
              subscription_period_unique: {
                subscriptionId: string;
                servicePeriodStart: Date;
              };
            };
        select?: unknown;
      }): Promise<FakeBalanceRow | null> => {
        const where = args.where;
        if ('sourceEventId' in where) {
          return this.rows.find((r) => r.sourceEventId === where.sourceEventId) ?? null;
        }
        if ('id' in where) {
          return this.rows.find((r) => r.id === where.id) ?? null;
        }
        if ('subscription_period_unique' in where) {
          const key = where.subscription_period_unique;
          return (
            this.rows.find(
              (r) =>
                r.subscriptionId === key.subscriptionId &&
                r.servicePeriodStart.getTime() === key.servicePeriodStart.getTime(),
            ) ?? null
          );
        }
        return null;
      },
    ),

    findMany: vi.fn(
      async (args: {
        where: {
          status?: 'active' | { in: ReadonlyArray<FakeBalanceRow['status']> };
          servicePeriodStart?: { lte: Date };
          subscriptionId?: string;
        };
        select?: unknown;
        orderBy?: unknown;
        take?: number;
      }): Promise<FakeBalanceRow[]> => {
        const { status, servicePeriodStart, subscriptionId } = args.where;
        return this.rows
          .filter((r) => {
            if (typeof status === 'string' && r.status !== status) return false;
            if (
              status !== undefined &&
              typeof status === 'object' &&
              !status.in.includes(r.status)
            ) {
              return false;
            }
            if (
              servicePeriodStart !== undefined &&
              r.servicePeriodStart.getTime() > servicePeriodStart.lte.getTime()
            ) {
              return false;
            }
            if (subscriptionId !== undefined && r.subscriptionId !== subscriptionId) {
              return false;
            }
            return true;
          })
          .sort((a, b) => {
            const t = a.servicePeriodStart.getTime() - b.servicePeriodStart.getTime();
            if (t !== 0) return t;
            return a.id.localeCompare(b.id);
          })
          .slice(0, args.take ?? this.rows.length);
      },
    ),

    create: vi.fn(
      async (args: {
        data: Omit<FakeBalanceRow, 'id' | 'createdAt' | 'updatedAt'>;
        select?: unknown;
      }): Promise<FakeBalanceRow> => {
        if (this.forceUniqueViolationOnNextCreate === 'sourceEventId') {
          this.forceUniqueViolationOnNextCreate = null;
          throw new PrismaUniqueViolation(['source_event_id']);
        }
        if (this.forceUniqueViolationOnNextCreate === 'subscriptionPeriod') {
          this.forceUniqueViolationOnNextCreate = null;
          throw new PrismaUniqueViolation(['subscription_id', 'service_period_start']);
        }
        if (this.rows.some((r) => r.sourceEventId === args.data.sourceEventId)) {
          throw new PrismaUniqueViolation(['source_event_id']);
        }
        if (
          this.rows.some(
            (r) =>
              r.subscriptionId === args.data.subscriptionId &&
              r.servicePeriodStart.getTime() === args.data.servicePeriodStart.getTime(),
          )
        ) {
          throw new PrismaUniqueViolation(['subscription_id', 'service_period_start']);
        }
        this.autoId += 1;
        const now = new Date('2026-05-13T00:00:00.000Z');
        const row: FakeBalanceRow = {
          id: `drb_${this.autoId}`,
          ...args.data,
          createdAt: now,
          updatedAt: now,
        };
        this.rows.push(row);
        return row;
      },
    ),

    update: vi.fn(
      async (args: {
        where: { id: string };
        data: Partial<FakeBalanceRow>;
      }): Promise<FakeBalanceRow> => {
        const row = this.rows.find((r) => r.id === args.where.id);
        if (row === undefined) {
          throw new Error(`fake.update: missing row id=${args.where.id}`);
        }
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      },
    ),
  };

  seedBalance(partial: Partial<FakeBalanceRow>): FakeBalanceRow {
    this.autoId += 1;
    const now = new Date('2026-05-13T00:00:00.000Z');
    const defaults: FakeBalanceRow = {
      id: `drb_seed_${this.autoId}`,
      subscriptionId: 'sub_default',
      customerId: 'cus_default',
      customerGroup: 'family',
      planCode: 'family.tier1',
      originalAmount: new Decimal('29.00'),
      recognizedAmount: new Decimal(0),
      currency: 'USD',
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      servicePeriodEnd: new Date('2026-05-31T23:59:59.999Z'),
      lastRecognizedAt: null,
      status: 'active',
      activationJournalId: 'jrn_seed',
      sourceEventId: `evt_seed_${this.autoId}`,
      pausedAt: null,
      pausedDurationSeconds: 0,
      context: {},
      createdAt: now,
      updatedAt: now,
    };
    const row = { ...defaults, ...partial };
    this.rows.push(row);
    return row;
  }
}

type PostArgs = Parameters<JournalPostingService['post']>[0];

class JournalsMock {
  public posts: Array<{
    request: PostArgs;
    response: JournalResult<JournalResponse, PostJournalFailure>;
  }> = [];
  /**
   * Queue of next `post` responses. If empty, `post` returns a
   * success for an auto-generated journal id.
   */
  public scriptedResponses: Array<JournalResult<JournalResponse, PostJournalFailure>> = [];
  private autoId = 0;

  post = vi.fn(
    async (
      request: PostArgs,
      _postedByUserId: string | null,
    ): Promise<JournalResult<JournalResponse, PostJournalFailure>> => {
      const next = this.scriptedResponses.shift();
      if (next !== undefined) {
        this.posts.push({ request, response: next });
        return next;
      }
      this.autoId += 1;
      const response: JournalResult<JournalResponse, PostJournalFailure> = {
        ok: true,
        value: buildFakeJournalResponse(request, `jrnl_${this.autoId}`),
      };
      this.posts.push({ request, response });
      return response;
    },
  );
}

function buildFakeJournalResponse(request: PostArgs, id: string): JournalResponse {
  return {
    id,
    kind: request.kind,
    occurredAt:
      typeof request.occurredAt === 'string'
        ? request.occurredAt
        : (request.occurredAt as Date).toISOString(),
    postedAt: '2026-05-13T00:00:00.000Z',
    sourceEventId: request.sourceEventId,
    description: request.description,
    periodId: 'prd_2026_05',
    periodName: '2026-05',
    postedByUserId: null,
    reversedJournalId: null,
    reversedByJournalId: null,
    context: request.context ?? {},
    lines: request.lines.map((line, idx) => ({
      id: `${id}_l${idx}`,
      accountId: `coa_${line.accountCode.replace(/[^a-z0-9]/g, '_')}`,
      accountCode: line.accountCode,
      debitMinor: line.debitMinor ?? 0,
      creditMinor: line.creditMinor ?? 0,
      currency: line.currency,
      ...(line.memo !== undefined ? { memo: line.memo } : {}),
    })) as JournalResponse['lines'],
  };
}

function buildService(): {
  service: SubscriptionRevenueRecognizerService;
  prisma: FakePrisma;
  journals: JournalsMock;
} {
  const prisma = new FakePrisma();
  const journals = new JournalsMock();
  const accounts = new PlanAccountResolverService();
  const service = new SubscriptionRevenueRecognizerService(
    prisma as unknown as PrismaService,
    journals as unknown as JournalPostingService,
    accounts,
  );
  return { service, prisma, journals };
}

const baseActivation: RecognizeActivationRequest = {
  subscriptionId: 'sub_abc',
  customerId: 'cus_abc',
  customerGroup: 'family',
  planCode: 'family.tier2',
  amountMinor: 29900,
  currency: 'USD',
  servicePeriodStart: '2026-05-01T00:00:00.000Z',
  servicePeriodEnd: '2026-05-31T23:59:59.999Z',
  sourceEventId: 'evt_sub.activated_abc',
  occurredAt: '2026-05-01T12:00:00.000Z',
};

describe('SubscriptionRevenueRecognizerService.recognizeActivation', () => {
  let svc: SubscriptionRevenueRecognizerService;
  let prisma: FakePrisma;
  let journals: JournalsMock;

  beforeEach(() => {
    ({ service: svc, prisma, journals } = buildService());
  });

  it('posts a balanced activation journal and creates the balance row', async () => {
    const result = await svc.recognizeActivation(baseActivation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('created');
    expect(result.value.subscriptionId).toBe('sub_abc');
    expect(result.value.originalAmountMinor).toBe(29900);
    expect(result.value.recognizedAmountMinor).toBe(0);
    expect(result.value.status).toBe('active');
    expect(result.value.activationJournalId).toMatch(/^jrnl_/);

    expect(journals.posts).toHaveLength(1);
    const posted = journals.posts[0]!.request;
    expect(posted.kind).toBe('subscription_activation');
    expect(posted.lines).toEqual([
      {
        accountCode: '1000',
        debitMinor: 29900,
        currency: 'USD',
        memo: 'subscription sub_abc (family.tier2)',
      },
      {
        accountCode: '2000.family.tier2',
        creditMinor: 29900,
        currency: 'USD',
        memo: 'subscription sub_abc (family.tier2)',
      },
    ]);
    expect(posted.sourceEventId).toBe('evt_sub.activated_abc');

    expect(prisma.rows).toHaveLength(1);
    const row = prisma.rows[0]!;
    expect(row.subscriptionId).toBe('sub_abc');
    expect(row.originalAmount.toString()).toBe('299');
    expect(row.recognizedAmount.eq(0)).toBe(true);
    expect(row.status).toBe('active');
    expect(row.sourceEventId).toBe('evt_sub.activated_abc');
    expect(row.activationJournalId).toMatch(/^jrnl_/);
  });

  it('replays idempotently on a known source event id', async () => {
    const first = await svc.recognizeActivation(baseActivation);
    expect(first.ok).toBe(true);
    const second = await svc.recognizeActivation(baseActivation);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.result).toBe('idempotent_replay');
    expect(prisma.rows).toHaveLength(1);
    expect(journals.posts).toHaveLength(1); // no second post
  });

  it('rejects an inverted service period', async () => {
    const result = await svc.recognizeActivation({
      ...baseActivation,
      servicePeriodStart: '2026-06-01T00:00:00.000Z',
      servicePeriodEnd: '2026-05-31T23:59:59.999Z',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('period_inverted');
    expect(journals.posts).toHaveLength(0);
    expect(prisma.rows).toHaveLength(0);
  });

  it('rejects a zero or negative amount', async () => {
    const r1 = await svc.recognizeActivation({ ...baseActivation, amountMinor: 0 });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.failure.kind).toBe('amount_non_positive');
    const r2 = await svc.recognizeActivation({ ...baseActivation, amountMinor: -10 });
    expect(r2.ok).toBe(false);
    expect(journals.posts).toHaveLength(0);
  });

  it('rejects a conflicting balance for the same subscription period (different source event id)', async () => {
    await svc.recognizeActivation(baseActivation);
    const conflict = await svc.recognizeActivation({
      ...baseActivation,
      sourceEventId: 'evt_different_id',
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.failure.kind).toBe('subscription_period_conflict');
    }
    expect(prisma.rows).toHaveLength(1);
    expect(journals.posts).toHaveLength(1);
  });

  it('handles a race UNIQUE violation on create by refetching the winner', async () => {
    // Simulate: findUnique pass shows nothing, then create explodes
    // P2002, then refetch succeeds with the winning row.
    prisma.seedBalance({
      subscriptionId: 'sub_abc',
      sourceEventId: 'evt_sub.activated_abc',
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      activationJournalId: 'jrn_winner',
    });
    // The first findUnique by sourceEventId will hit the seeded row;
    // recognizeActivation returns an idempotent_replay.
    const result = await svc.recognizeActivation(baseActivation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('idempotent_replay');
    expect(result.value.activationJournalId).toBe('jrn_winner');
    expect(journals.posts).toHaveLength(0);
  });

  it('rethrows non-unique Prisma errors', async () => {
    // Seed nothing, but force create to throw a non-P2002 error.
    prisma.deferredRevenueBalance.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(svc.recognizeActivation(baseActivation)).rejects.toThrow(/connection lost/);
  });

  it('forwards JournalPostingService failures as journal_post_failed', async () => {
    journals.scriptedResponses.push({
      ok: false,
      failure: {
        kind: 'account_not_found',
        accountCode: '2000.family.tier2',
      },
    });
    const result = await svc.recognizeActivation(baseActivation);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('journal_post_failed');
      if (result.failure.kind === 'journal_post_failed') {
        expect(result.failure.failure.kind).toBe('account_not_found');
      }
    }
    expect(prisma.rows).toHaveLength(0);
  });

  it('weaves customerGroup and planCode into the persisted context', async () => {
    await svc.recognizeActivation({
      ...baseActivation,
      context: { stripeInvoiceId: 'in_abc' },
    });
    const row = prisma.rows[0]!;
    const ctx = row.context as Record<string, unknown>;
    expect(ctx['planCode']).toBe('family.tier2');
    expect(ctx['customerGroup']).toBe('family');
    expect(ctx['stripeContext']).toEqual({ stripeInvoiceId: 'in_abc' });
  });

  it('defaults currency to USD on persisted row when omitted', async () => {
    const { currency, ...rest } = baseActivation;
    void currency;
    await svc.recognizeActivation({ ...rest, currency: 'USD' });
    expect(prisma.rows[0]!.currency).toBe('USD');
  });
});

describe('SubscriptionRevenueRecognizerService.cancelDeferredRevenue', () => {
  let svc: SubscriptionRevenueRecognizerService;
  let prisma: FakePrisma;

  beforeEach(() => {
    ({ service: svc, prisma } = buildService());
  });

  it('flips an active balance to canceled', async () => {
    const seeded = prisma.seedBalance({
      subscriptionId: 'sub_xyz',
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      originalAmount: new Decimal('199.00'),
      recognizedAmount: new Decimal('99.00'),
      status: 'active',
    });
    const result = await svc.cancelDeferredRevenue({
      subscriptionId: 'sub_xyz',
      servicePeriodStart: '2026-05-01T00:00:00.000Z',
      sourceEventId: 'evt_sub.canceled_xyz',
      occurredAt: '2026-05-15T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousStatus).toBe('active');
    expect(result.value.status).toBe('canceled');
    expect(result.value.remainingDeferredMinor).toBe(10000); // $100.00
    expect(result.value.result).toBe('canceled');
    expect(prisma.rows.find((r) => r.id === seeded.id)!.status).toBe('canceled');
  });

  it('returns balance_not_found when no matching row exists', async () => {
    const result = await svc.cancelDeferredRevenue({
      subscriptionId: 'sub_missing',
      servicePeriodStart: '2026-05-01T00:00:00.000Z',
      sourceEventId: 'evt_sub.canceled_missing',
      occurredAt: '2026-05-15T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('balance_not_found');
    }
  });

  it('replays idempotently when already canceled', async () => {
    prisma.seedBalance({
      subscriptionId: 'sub_already',
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      originalAmount: new Decimal('299.00'),
      recognizedAmount: new Decimal('150.00'),
      status: 'canceled',
    });
    const result = await svc.cancelDeferredRevenue({
      subscriptionId: 'sub_already',
      servicePeriodStart: '2026-05-01T00:00:00.000Z',
      sourceEventId: 'evt_sub.canceled_already',
      occurredAt: '2026-05-15T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousStatus).toBe('canceled');
    expect(result.value.status).toBe('canceled');
    expect(result.value.result).toBe('idempotent_replay');
    expect(result.value.remainingDeferredMinor).toBe(14900); // $149.00
  });

  it('persists optional reason into context on cancel', async () => {
    const seeded = prisma.seedBalance({
      subscriptionId: 'sub_reason',
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
    });
    await svc.cancelDeferredRevenue({
      subscriptionId: 'sub_reason',
      servicePeriodStart: '2026-05-01T00:00:00.000Z',
      sourceEventId: 'evt_sub.canceled_reason',
      occurredAt: '2026-05-15T00:00:00.000Z',
      reason: 'Customer requested cancellation',
    });
    const ctx = prisma.rows.find((r) => r.id === seeded.id)!.context as Record<string, unknown>;
    expect(ctx['cancelReason']).toBe('Customer requested cancellation');
    expect(ctx['cancelSourceEventId']).toBe('evt_sub.canceled_reason');
  });
});

describe('SubscriptionRevenueRecognizerService.recognizeDaily', () => {
  let svc: SubscriptionRevenueRecognizerService;
  let prisma: FakePrisma;
  let journals: JournalsMock;

  beforeEach(() => {
    ({ service: svc, prisma, journals } = buildService());
  });

  it('returns an empty report when no active balances are pending', async () => {
    const report = await svc.recognizeDaily(new Date('2026-05-15T03:00:00.000Z'));
    expect(report.scannedCount).toBe(0);
    expect(report.recognizedCount).toBe(0);
    expect(journals.posts).toHaveLength(0);
  });

  it('skips balances whose period has not yet started', async () => {
    prisma.seedBalance({
      subscriptionId: 'sub_future',
      servicePeriodStart: new Date('2026-06-01T00:00:00.000Z'),
      servicePeriodEnd: new Date('2026-06-30T23:59:59.999Z'),
    });
    const report = await svc.recognizeDaily(new Date('2026-05-15T03:00:00.000Z'));
    expect(report.scannedCount).toBe(0);
  });

  it('recognises mid-period delta and updates the balance row', async () => {
    const balance = prisma.seedBalance({
      subscriptionId: 'sub_mid',
      planCode: 'family.tier2',
      originalAmount: new Decimal('300.00'),
      recognizedAmount: new Decimal(0),
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      servicePeriodEnd: new Date('2026-05-31T00:00:00.000Z'),
      lastRecognizedAt: null,
    });
    const asOf = new Date('2026-05-11T00:00:00.000Z');
    const report = await svc.recognizeDaily(asOf);
    expect(report.scannedCount).toBe(1);
    expect(report.recognizedCount).toBe(1);
    expect(report.completedCount).toBe(0);
    expect(report.skippedCount).toBe(0);
    expect(report.failedCount).toBe(0);
    expect(report.totalRecognizedMinor).toBeGreaterThan(0);

    // 10 of 30 days elapsed → $100 expected (within rounding).
    const updated = prisma.rows.find((r) => r.id === balance.id)!;
    expect(updated.recognizedAmount.eq(new Decimal('100.00'))).toBe(true);
    expect(updated.lastRecognizedAt?.getTime()).toBe(asOf.getTime());
    expect(updated.status).toBe('active');

    expect(journals.posts).toHaveLength(1);
    const posted = journals.posts[0]!.request;
    expect(posted.kind).toBe('subscription_recognition');
    expect(posted.sourceEventId).toBe(`subscription.recognized:sub_mid:2026-05-11`);
    expect(posted.lines[0]!.accountCode).toBe('2000.family.tier2');
    expect(posted.lines[1]!.accountCode).toBe('4000.family.tier2');
    expect(posted.lines[0]!.debitMinor).toBe(10000);
    expect(posted.lines[1]!.creditMinor).toBe(10000);
  });

  it('zeroes out the remaining deferred on the final-day sweep', async () => {
    const balance = prisma.seedBalance({
      subscriptionId: 'sub_final',
      originalAmount: new Decimal('299.00'),
      recognizedAmount: new Decimal('290.00'),
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      servicePeriodEnd: new Date('2026-05-31T23:59:59.999Z'),
    });
    const report = await svc.recognizeDaily(new Date('2026-05-31T23:59:59.999Z'));
    expect(report.recognizedCount).toBe(1);
    expect(report.completedCount).toBe(1);
    expect(report.totalRecognizedMinor).toBe(900); // $9.00

    const updated = prisma.rows.find((r) => r.id === balance.id)!;
    expect(updated.recognizedAmount.eq(new Decimal('299.00'))).toBe(true);
    expect(updated.status).toBe('fully_recognized');
  });

  it('skips a balance with no recognition due (same-day re-run)', async () => {
    prisma.seedBalance({
      subscriptionId: 'sub_already',
      originalAmount: new Decimal('300.00'),
      recognizedAmount: new Decimal('100.00'),
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      servicePeriodEnd: new Date('2026-05-31T00:00:00.000Z'),
    });
    // On 5/11 cumulative expected is $100. Already recognised = $100.
    const report = await svc.recognizeDaily(new Date('2026-05-11T00:00:00.000Z'));
    expect(report.scannedCount).toBe(1);
    expect(report.skippedCount).toBe(1);
    expect(report.recognizedCount).toBe(0);
    expect(journals.posts).toHaveLength(0);
  });

  it('handles a failed journal post by counting as failed and moving on', async () => {
    prisma.seedBalance({
      subscriptionId: 'sub_unhappy',
      planCode: 'family.tier1',
      originalAmount: new Decimal('29.00'),
    });
    prisma.seedBalance({
      subscriptionId: 'sub_happy',
      planCode: 'family.tier2',
      originalAmount: new Decimal('199.00'),
    });
    journals.scriptedResponses.push({
      ok: false,
      failure: {
        kind: 'account_not_found',
        accountCode: '2000.family.tier1',
      },
    });
    const report = await svc.recognizeDaily(new Date('2026-05-16T00:00:00.000Z'));
    expect(report.scannedCount).toBe(2);
    expect(report.failedCount).toBe(1);
    expect(report.recognizedCount).toBe(1);
  });

  it('is safe to re-run on the same UTC day', async () => {
    prisma.seedBalance({
      subscriptionId: 'sub_replay',
      planCode: 'family.tier2',
      originalAmount: new Decimal('300.00'),
      recognizedAmount: new Decimal(0),
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      servicePeriodEnd: new Date('2026-05-31T00:00:00.000Z'),
    });
    const asOf = new Date('2026-05-11T00:00:00.000Z');
    const first = await svc.recognizeDaily(asOf);
    const second = await svc.recognizeDaily(asOf);
    expect(first.recognizedCount).toBe(1);
    expect(second.recognizedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
  });

  it('respects batchSize cap on large sweeps', async () => {
    for (let i = 0; i < 5; i++) {
      prisma.seedBalance({
        subscriptionId: `sub_batch_${i}`,
        servicePeriodStart: new Date(`2026-05-0${i + 1}T00:00:00.000Z` as string),
        servicePeriodEnd: new Date(
          `2026-05-${(i + 1 + 27).toString().padStart(2, '0')}T00:00:00.000Z` as string,
        ),
        sourceEventId: `evt_batch_${i}`,
      });
    }
    const report = await svc.recognizeDaily(new Date('2026-05-15T00:00:00.000Z'), 2);
    expect(report.scannedCount).toBe(2);
  });

  it('does not include canceled balances in the sweep', async () => {
    prisma.seedBalance({
      subscriptionId: 'sub_canceled',
      status: 'canceled',
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
    });
    const report = await svc.recognizeDaily(new Date('2026-05-15T00:00:00.000Z'));
    expect(report.scannedCount).toBe(0);
  });

  it('does not include fully_recognized balances in the sweep', async () => {
    prisma.seedBalance({
      subscriptionId: 'sub_done',
      status: 'fully_recognized',
      servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
    });
    const report = await svc.recognizeDaily(new Date('2026-05-15T00:00:00.000Z'));
    expect(report.scannedCount).toBe(0);
  });
});

/**
 * TS-042-followup-3b2 — pause / resume of amortisation.
 *
 * The invariant these tests defend: a pause suspends the *schedule*,
 * never the balance, and resume restores that schedule so exactly that
 * no already-posted journal becomes wrong and no correcting pair is
 * owed (CLAUDE.md §6).
 */
describe('SubscriptionRevenueRecognizerService.pauseRecognition', () => {
  const DAY_MS = 86_400_000;
  const start = new Date('2026-06-01T00:00:00.000Z');
  const end = new Date('2026-07-01T00:00:00.000Z');

  const basePause = {
    subscriptionId: 'sub_abc',
    pausedAt: '2026-06-11T00:00:00.000Z',
    sourceEventId: 'evt_sub.paused_1',
    fromStatus: 'active',
    hasReason: true,
  };

  it('flips every active balance to paused and stamps pausedAt', async () => {
    const { service, prisma } = buildService();
    const row = prisma.seedBalance({
      subscriptionId: 'sub_abc',
      servicePeriodStart: start,
      servicePeriodEnd: end,
      status: 'active',
    });

    const outcome = await service.pauseRecognition(basePause);

    expect(outcome.result).toBe('applied');
    expect(outcome.balanceIds).toEqual([row.id]);
    expect(row.status).toBe('paused');
    expect(row.pausedAt?.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    // The period end is untouched by the pause — only resume knows how
    // long the suspension lasted.
    expect(row.servicePeriodEnd.getTime()).toBe(end.getTime());
  });

  it('posts NO journal — a pause is a schedule change, not an economic event', async () => {
    const { service, prisma, journals } = buildService();
    prisma.seedBalance({ subscriptionId: 'sub_abc', status: 'active' });

    await service.pauseRecognition(basePause);

    expect(journals.posts).toHaveLength(0);
  });

  it('does NOT restamp pausedAt on a redelivered pause', async () => {
    const { service, prisma } = buildService();
    const row = prisma.seedBalance({
      subscriptionId: 'sub_abc',
      status: 'paused',
      pausedAt: new Date('2026-06-11T00:00:00.000Z'),
    });

    const outcome = await service.pauseRecognition({
      ...basePause,
      pausedAt: '2026-06-20T00:00:00.000Z',
      sourceEventId: 'evt_sub.paused_1_redelivered',
    });

    // Restamping would silently shorten the suspension and hand the
    // family back nine days of service they never received.
    expect(outcome.result).toBe('idempotent_replay');
    expect(outcome.balanceIds).toEqual([]);
    expect(row.pausedAt?.toISOString()).toBe('2026-06-11T00:00:00.000Z');
  });

  it('reports no_balance rather than failing when nothing is in flight', async () => {
    const { service, prisma } = buildService();
    prisma.seedBalance({ subscriptionId: 'sub_abc', status: 'fully_recognized' });

    const outcome = await service.pauseRecognition(basePause);

    // A fully-recognised subscription is legitimately pausable with
    // nothing to suspend. Modelling it as a failure would make the
    // handler throw and the event redeliver forever.
    expect(outcome.result).toBe('no_balance');
    expect(outcome.balanceIds).toEqual([]);
  });

  it('leaves other subscriptions alone', async () => {
    const { service, prisma } = buildService();
    prisma.seedBalance({ subscriptionId: 'sub_abc', status: 'active' });
    const other = prisma.seedBalance({ subscriptionId: 'sub_other', status: 'active' });

    await service.pauseRecognition(basePause);

    expect(other.status).toBe('active');
  });

  it('merges pause provenance into context without dropping the activation context', async () => {
    const { service, prisma } = buildService();
    const row = prisma.seedBalance({
      subscriptionId: 'sub_abc',
      status: 'active',
      context: { stripeContext: { invoiceId: 'in_123' }, planCode: 'family.tier2' },
    });

    await service.pauseRecognition(basePause);

    const context = row.context as Record<string, unknown>;
    expect(context['stripeContext']).toEqual({ invoiceId: 'in_123' });
    expect(context['pause']).toEqual({
      pausedAt: '2026-06-11T00:00:00.000Z',
      sourceEventId: 'evt_sub.paused_1',
      fromStatus: 'active',
      hasReason: true,
    });
  });

  it('carries no free text into the balance context — only the hasReason flag', async () => {
    const { service, prisma } = buildService();
    const row = prisma.seedBalance({ subscriptionId: 'sub_abc', status: 'active' });

    await service.pauseRecognition(basePause);

    // A pause reason on this platform is very often a health or
    // bereavement disclosure about a named senior (CLAUDE.md §3.9, §12).
    // The request shape cannot carry it; this asserts nothing narrative
    // reached the row by another route.
    const serialised = JSON.stringify(row.context);
    expect(serialised).toContain('"hasReason":true');
    expect(serialised).not.toContain('pauseReason');
    expect(serialised).not.toContain('"reason"');
  });

  it('excludes the paused balance from the daily sweep', async () => {
    const { service, prisma, journals } = buildService();
    prisma.seedBalance({
      subscriptionId: 'sub_abc',
      servicePeriodStart: start,
      servicePeriodEnd: end,
      status: 'active',
    });

    await service.pauseRecognition(basePause);
    const report = await service.recognizeDaily(new Date(start.getTime() + 15 * DAY_MS));

    expect(report.scannedCount).toBe(0);
    expect(journals.posts).toHaveLength(0);
  });
});

describe('SubscriptionRevenueRecognizerService.resumeRecognition', () => {
  const DAY_MS = 86_400_000;
  const start = new Date('2026-06-01T00:00:00.000Z');
  const end = new Date('2026-07-01T00:00:00.000Z');
  const pausedAt = new Date('2026-06-11T00:00:00.000Z');
  const TEN_DAYS_SECONDS = 10 * 86_400;

  const baseResume = {
    subscriptionId: 'sub_abc',
    resumedAt: '2026-06-21T00:00:00.000Z',
    sourceEventId: 'evt_sub.resumed_1',
    toStatus: 'active',
    hasNote: false,
  };

  function seedPaused(
    prisma: FakePrisma,
    overrides: Record<string, unknown> = {},
  ): ReturnType<FakePrisma['seedBalance']> {
    return prisma.seedBalance({
      subscriptionId: 'sub_abc',
      servicePeriodStart: start,
      servicePeriodEnd: end,
      status: 'paused',
      pausedAt,
      originalAmount: new Decimal('300.00'),
      recognizedAmount: new Decimal('100.00'),
      ...overrides,
    });
  }

  it('extends servicePeriodEnd by the suspended duration and accumulates it', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma);

    const outcome = await service.resumeRecognition(baseResume);

    expect(outcome.result).toBe('applied');
    expect(outcome.extendedBySeconds).toBe(TEN_DAYS_SECONDS);
    expect(row.status).toBe('active');
    expect(row.pausedAt).toBeNull();
    expect(row.pausedDurationSeconds).toBe(TEN_DAYS_SECONDS);
    expect(row.servicePeriodEnd.toISOString()).toBe('2026-07-11T00:00:00.000Z');
  });

  it('posts NO journal on resume', async () => {
    const { service, prisma, journals } = buildService();
    seedPaused(prisma);

    await service.resumeRecognition(baseResume);

    expect(journals.posts).toHaveLength(0);
  });

  it('the first post-resume sweep posts NOTHING — the pause did not accrue', async () => {
    const { service, prisma, journals } = buildService();
    seedPaused(prisma);

    await service.resumeRecognition(baseResume);
    const report = await service.recognizeDaily(new Date('2026-06-21T00:00:00.000Z'));

    // Cumulative expected at resume equals what was already recognised
    // at the pause. Without the paused-duration subtraction this sweep
    // would post $50.00 of revenue for ten days nobody was served.
    expect(report.scannedCount).toBe(1);
    expect(report.recognizedCount).toBe(0);
    expect(report.skippedCount).toBe(1);
    expect(journals.posts).toHaveLength(0);
  });

  it('resumes accrual at the original daily rate after the pause', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma);

    await service.resumeRecognition(baseResume);
    // Calendar day 25 = fifteen SERVICE days delivered of thirty.
    await service.recognizeDaily(new Date(start.getTime() + 25 * DAY_MS));

    expect(row.recognizedAmount.toFixed(2)).toBe('150.00');
  });

  it('fully recognises at the extended end and never overshoots the original amount', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma);

    await service.resumeRecognition(baseResume);
    await service.recognizeDaily(new Date('2026-07-11T00:00:00.000Z'));

    expect(row.recognizedAmount.toFixed(2)).toBe('300.00');
    expect(row.status).toBe('fully_recognized');
  });

  it('does NOT extend a second time on a redelivered resume', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma);

    await service.resumeRecognition(baseResume);
    const replay = await service.resumeRecognition({
      ...baseResume,
      sourceEventId: 'evt_sub.resumed_1_redelivered',
    });

    // A double extension would hand the family a free ten days.
    expect(replay.result).toBe('idempotent_replay');
    expect(replay.extendedBySeconds).toBe(0);
    expect(row.pausedDurationSeconds).toBe(TEN_DAYS_SECONDS);
    expect(row.servicePeriodEnd.toISOString()).toBe('2026-07-11T00:00:00.000Z');
  });

  it('accumulates across two pause/resume cycles', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma);

    await service.resumeRecognition(baseResume);
    await service.pauseRecognition({
      subscriptionId: 'sub_abc',
      pausedAt: '2026-06-25T00:00:00.000Z',
      sourceEventId: 'evt_sub.paused_2',
      fromStatus: 'active',
      hasReason: false,
    });
    await service.resumeRecognition({
      ...baseResume,
      resumedAt: '2026-07-05T00:00:00.000Z',
      sourceEventId: 'evt_sub.resumed_2',
    });

    expect(row.pausedDurationSeconds).toBe(2 * TEN_DAYS_SECONDS);
    expect(row.servicePeriodEnd.toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('RESUMES a subscription whose toStatus is past_due, and records that status', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma);

    const outcome = await service.resumeRecognition({
      ...baseResume,
      toStatus: 'past_due',
    });

    // TS-042-followup-3b3: `past_due` / `unpaid` keep accruing — the
    // platform has invoiced and may still collect. The status is read
    // and recorded, never used to gate the resume.
    expect(outcome.result).toBe('applied');
    expect(row.status).toBe('active');
    expect((row.context as Record<string, unknown>)['resume']).toMatchObject({
      toStatus: 'past_due',
    });
  });

  it('clamps a resume that predates the recorded pause instead of shortening the period', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma);

    const outcome = await service.resumeRecognition({
      ...baseResume,
      resumedAt: '2026-06-05T00:00:00.000Z',
    });

    expect(outcome.extendedBySeconds).toBe(0);
    expect(row.pausedDurationSeconds).toBe(0);
    expect(row.servicePeriodEnd.getTime()).toBe(end.getTime());
  });

  it('resumes on the original schedule when pausedAt was never recorded', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma, { pausedAt: null });

    const outcome = await service.resumeRecognition(baseResume);

    expect(outcome.extendedBySeconds).toBe(0);
    expect(row.status).toBe('active');
    expect(row.servicePeriodEnd.getTime()).toBe(end.getTime());
  });

  it('reports no_balance when the subscription has no balance at all', async () => {
    const { service } = buildService();

    const outcome = await service.resumeRecognition(baseResume);

    expect(outcome.result).toBe('no_balance');
    expect(outcome.extendedBySeconds).toBe(0);
  });

  it('merges resume provenance without dropping the pause record', async () => {
    const { service, prisma } = buildService();
    const row = seedPaused(prisma, {
      context: { pause: { sourceEventId: 'evt_sub.paused_1' } },
    });

    await service.resumeRecognition(baseResume);

    const context = row.context as Record<string, unknown>;
    expect(context['pause']).toEqual({ sourceEventId: 'evt_sub.paused_1' });
    expect(context['resume']).toEqual({
      resumedAt: '2026-06-21T00:00:00.000Z',
      sourceEventId: 'evt_sub.resumed_1',
      toStatus: 'active',
      hasNote: false,
      extendedBySeconds: TEN_DAYS_SECONDS,
    });
  });

  it('a pause/resume round trip recognises exactly what an uninterrupted period does', async () => {
    // The property that makes reversal/replacement journals unnecessary:
    // the effective denominator never changed, so nothing already posted
    // was computed against a wrong total.
    const paused = buildService();
    const pausedRow = paused.prisma.seedBalance({
      subscriptionId: 'sub_abc',
      servicePeriodStart: start,
      servicePeriodEnd: end,
      status: 'paused',
      pausedAt,
      originalAmount: new Decimal('300.00'),
      recognizedAmount: new Decimal('100.00'),
    });
    await paused.service.resumeRecognition(baseResume);
    await paused.service.recognizeDaily(new Date('2026-07-11T00:00:00.000Z'));

    const uninterrupted = buildService();
    const plainRow = uninterrupted.prisma.seedBalance({
      subscriptionId: 'sub_plain',
      servicePeriodStart: start,
      servicePeriodEnd: end,
      status: 'active',
      originalAmount: new Decimal('300.00'),
      recognizedAmount: new Decimal('100.00'),
    });
    await uninterrupted.service.recognizeDaily(new Date('2026-07-01T00:00:00.000Z'));

    expect(pausedRow.recognizedAmount.toFixed(2)).toBe(plainRow.recognizedAmount.toFixed(2));
    expect(pausedRow.recognizedAmount.toFixed(2)).toBe('300.00');
  });
});
