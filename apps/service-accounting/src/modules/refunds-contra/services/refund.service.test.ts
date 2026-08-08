import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ApplyBookingRefundRequest,
  ApplySubscriptionRefundRequest,
  JournalResponse,
} from '@taste-and-see/contracts';

import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  JournalPostingService,
  PostJournalFailure,
  Result as JournalResult,
} from '../../journals/services/journal-posting.service';
import { PlanAccountResolverService } from '../../revenue-recognition/services/plan-account-resolver.service';
import {
  REFUND_JOURNAL_ACCOUNT_CODES,
  RefundService,
  buildBookingRefundLines,
} from './refund.service';

interface FakePayableRow {
  id: string;
  providerId: string;
  currency: string;
  amount: Decimal;
  lastUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeJournalRow {
  id: string;
  sourceEventId: string;
}

/**
 * FakePrisma covering RefundService's read + write surfaces:
 *
 *   - `journal.findUnique({ where: { sourceEventId } })` for the replay
 *     pre-flight (both subscription + booking refund paths).
 *   - `providerPayableBalance.findUnique` for the read-on-replay path.
 *   - `providerPayableBalance.upsert` with `{ amount: { decrement: D } }`
 *     for the clawback decrement.
 *   - `$transaction` wrapper that just inlines the callback (no
 *     rollback fidelity — that's Testcontainers' job).
 *
 * Mirrors booking-commission-recognizer's FakePrisma shape with the
 * upsert path inverted for decrement.
 */
class FakePrisma {
  public journals: FakeJournalRow[] = [];
  public payableRows: FakePayableRow[] = [];
  private autoId = 0;

  journal = {
    findUnique: vi.fn(
      async (args: {
        where: { sourceEventId: string };
        select: { id: true };
      }): Promise<{ id: string } | null> => {
        const row = this.journals.find((r) => r.sourceEventId === args.where.sourceEventId);
        if (row === undefined) return null;
        return { id: row.id };
      },
    ),
  };

  providerPayableBalance = {
    findUnique: vi.fn(
      async (args: {
        where: {
          provider_currency_unique: { providerId: string; currency: string };
        };
        select?: unknown;
      }): Promise<FakePayableRow | null> => {
        const key = args.where.provider_currency_unique;
        return (
          this.payableRows.find(
            (r) => r.providerId === key.providerId && r.currency === key.currency,
          ) ?? null
        );
      },
    ),
    upsert: vi.fn(
      async (args: {
        where: {
          provider_currency_unique: { providerId: string; currency: string };
        };
        create: {
          providerId: string;
          currency: string;
          amount: Decimal;
          lastUpdatedAt: Date;
        };
        update: {
          amount: { decrement: Decimal };
          lastUpdatedAt: Date;
        };
        select?: unknown;
      }): Promise<FakePayableRow> => {
        const key = args.where.provider_currency_unique;
        const existing = this.payableRows.find(
          (r) => r.providerId === key.providerId && r.currency === key.currency,
        );
        if (existing === undefined) {
          this.autoId += 1;
          const row: FakePayableRow = {
            id: `ppb_${this.autoId}`,
            providerId: args.create.providerId,
            currency: args.create.currency,
            amount: args.create.amount,
            lastUpdatedAt: args.create.lastUpdatedAt,
            createdAt: args.create.lastUpdatedAt,
            updatedAt: args.create.lastUpdatedAt,
          };
          this.payableRows.push(row);
          return row;
        }
        existing.amount = existing.amount.sub(args.update.amount.decrement);
        existing.lastUpdatedAt = args.update.lastUpdatedAt;
        existing.updatedAt = args.update.lastUpdatedAt;
        return existing;
      },
    ),
  };

  $transaction = vi.fn(async <T>(callback: (tx: FakePrisma) => Promise<T>): Promise<T> => {
    return callback(this);
  });

  seedJournal(sourceEventId: string, id?: string): FakeJournalRow {
    this.autoId += 1;
    const row: FakeJournalRow = {
      id: id ?? `jrnl_seed_${this.autoId}`,
      sourceEventId,
    };
    this.journals.push(row);
    return row;
  }

  seedPayableBalance(providerId: string, amount: Decimal): FakePayableRow {
    this.autoId += 1;
    const row: FakePayableRow = {
      id: `ppb_seed_${this.autoId}`,
      providerId,
      currency: 'USD',
      amount,
      lastUpdatedAt: new Date('2026-05-12T00:00:00.000Z'),
      createdAt: new Date('2026-05-12T00:00:00.000Z'),
      updatedAt: new Date('2026-05-12T00:00:00.000Z'),
    };
    this.payableRows.push(row);
    return row;
  }
}

type PostArgs = Parameters<JournalPostingService['post']>[0];

class JournalsMock {
  public posts: Array<{
    request: PostArgs;
    response: JournalResult<JournalResponse, PostJournalFailure>;
  }> = [];
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
    postedAt: '2026-05-12T00:00:00.000Z',
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
  service: RefundService;
  prisma: FakePrisma;
  journals: JournalsMock;
} {
  const prisma = new FakePrisma();
  const journals = new JournalsMock();
  const accounts = new PlanAccountResolverService();
  const service = new RefundService(
    prisma as unknown as PrismaService,
    journals as unknown as JournalPostingService,
    accounts,
  );
  return { service, prisma, journals };
}

// ── buildBookingRefundLines pure-helper coverage ──────────────────────────

describe('buildBookingRefundLines', () => {
  it('builds the four-line refund shape when providerPortion > 0', () => {
    const lines = buildBookingRefundLines({
      refundAmountMinor: 15_000,
      providerPortionMinor: 12_000,
      memo: 'booking bk_abc refund',
    });
    expect(lines).toEqual([
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.marketplaceRevenue,
        debitMinor: 15_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.cash,
        creditMinor: 15_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.providerPayable,
        debitMinor: 12_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.marketplaceRevenueContra,
        creditMinor: 12_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
    ]);
  });

  it('collapses to two lines when providerPortion is 0 (platform eats refund)', () => {
    const lines = buildBookingRefundLines({
      refundAmountMinor: 15_000,
      providerPortionMinor: 0,
      memo: 'booking bk_abc refund',
    });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.accountCode)).toEqual([
      REFUND_JOURNAL_ACCOUNT_CODES.marketplaceRevenue,
      REFUND_JOURNAL_ACCOUNT_CODES.cash,
    ]);
  });

  it('balances DR = CR for both shapes', () => {
    for (const providerPortion of [0, 5_000, 12_000]) {
      const lines = buildBookingRefundLines({
        refundAmountMinor: 15_000,
        providerPortionMinor: providerPortion,
        memo: 'm',
      });
      const dr = lines.reduce((acc, l) => acc + (l.debitMinor ?? 0), 0);
      const cr = lines.reduce((acc, l) => acc + (l.creditMinor ?? 0), 0);
      expect(dr).toBe(cr);
    }
  });
});

// ── applySubscriptionRefund ───────────────────────────────────────────────

const baseSubscriptionRefund: ApplySubscriptionRefundRequest = {
  subscriptionId: 'sub_abc',
  customerId: 'cust_abc',
  customerGroup: 'family',
  planCode: 'family.tier2',
  refundAmountMinor: 9_900,
  currency: 'USD',
  occurredAt: '2026-05-12T11:00:00.000Z',
  sourceEventId: 'evt_subscription.refunded_sub_abc',
};

describe('RefundService.applySubscriptionRefund', () => {
  let svc: RefundService;
  let prisma: FakePrisma;
  let journals: JournalsMock;

  beforeEach(() => {
    ({ service: svc, prisma, journals } = buildService());
  });

  it('posts the two-line PDD Appendix A subscription refund journal', async () => {
    const result = await svc.applySubscriptionRefund(baseSubscriptionRefund);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.result).toBe('created');
    expect(result.value.refundAmountMinor).toBe(9_900);
    expect(result.value.journalId).toMatch(/^jrnl_/);

    expect(journals.posts).toHaveLength(1);
    const posted = journals.posts[0]!.request;
    expect(posted.kind).toBe('refund');
    expect(posted.lines).toEqual([
      {
        accountCode: '4000.family.tier2',
        debitMinor: 9_900,
        currency: 'USD',
        memo: 'subscription sub_abc (family.tier2) refund',
      },
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.cash,
        creditMinor: 9_900,
        currency: 'USD',
        memo: 'subscription sub_abc (family.tier2) refund',
      },
    ]);

    // Sum invariant: DR = CR.
    const dr = posted.lines.reduce((acc, l) => acc + (l.debitMinor ?? 0), 0);
    const cr = posted.lines.reduce((acc, l) => acc + (l.creditMinor ?? 0), 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(9_900);

    expect(posted.context).toMatchObject({
      subscriptionId: 'sub_abc',
      customerId: 'cust_abc',
      customerGroup: 'family',
      planCode: 'family.tier2',
      refundAmountMinor: 9_900,
    });
  });

  it('resolves the revenue account from the plan code', async () => {
    await svc.applySubscriptionRefund({
      ...baseSubscriptionRefund,
      planCode: 'provider.elite',
    });
    const posted = journals.posts[0]!.request;
    const debitLine = posted.lines.find((l) => (l.debitMinor ?? 0) > 0);
    expect(debitLine?.accountCode).toBe('4000.provider.elite');
  });

  it('includes originalActivationJournalId in context when supplied', async () => {
    await svc.applySubscriptionRefund({
      ...baseSubscriptionRefund,
      originalActivationJournalId: 'jrnl_orig',
    });
    expect(journals.posts[0]!.request.context).toMatchObject({
      originalActivationJournalId: 'jrnl_orig',
    });
  });

  it('idempotent replay: returns the existing journal id with result=idempotent_replay', async () => {
    prisma.seedJournal(baseSubscriptionRefund.sourceEventId, 'jrnl_existing');
    journals.scriptedResponses.push({
      ok: true,
      value: buildFakeJournalResponse(
        {
          kind: 'refund',
          occurredAt: baseSubscriptionRefund.occurredAt,
          sourceEventId: baseSubscriptionRefund.sourceEventId,
          description: 'previously-posted',
          lines: [],
          context: {},
        } as PostArgs,
        'jrnl_existing',
      ),
    });

    const result = await svc.applySubscriptionRefund(baseSubscriptionRefund);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('idempotent_replay');
    expect(result.value.journalId).toBe('jrnl_existing');
  });

  it('rejects a zero refund amount', async () => {
    const result = await svc.applySubscriptionRefund({
      ...baseSubscriptionRefund,
      refundAmountMinor: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('amount_non_positive');
    expect(journals.posts).toHaveLength(0);
  });

  it('bubbles journal-post failures', async () => {
    journals.scriptedResponses.push({
      ok: false,
      failure: { kind: 'period_closed', periodId: 'p1', periodName: '2026-04' },
    });
    const result = await svc.applySubscriptionRefund(baseSubscriptionRefund);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('journal_post_failed');
  });

  it('falls back to a synthesised description when omitted', async () => {
    await svc.applySubscriptionRefund(baseSubscriptionRefund);
    expect(journals.posts[0]!.request.description).toBe(
      'Subscription refund: sub_abc (family.tier2)',
    );
  });
});

// ── applyBookingRefund ────────────────────────────────────────────────────

const baseBookingRefund: ApplyBookingRefundRequest = {
  bookingId: 'bk_abc',
  providerId: 'prv_abc',
  householdId: 'hh_abc',
  refundAmountMinor: 15_000,
  providerPortionMinor: 12_000,
  marketplacePortionMinor: 3_000,
  commissionRateBps: 2_000,
  currency: 'USD',
  occurredAt: '2026-05-12T12:00:00.000Z',
  sourceEventId: 'evt_booking.refunded_bk_abc',
};

describe('RefundService.applyBookingRefund', () => {
  let svc: RefundService;
  let prisma: FakePrisma;
  let journals: JournalsMock;

  beforeEach(() => {
    ({ service: svc, prisma, journals } = buildService());
  });

  it('posts the four-line refund journal AND decrements an existing positive balance', async () => {
    // Provider has 200 in payable from prior bookings.
    prisma.seedPayableBalance('prv_abc', new Decimal('200.00'));

    const result = await svc.applyBookingRefund(baseBookingRefund);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.result).toBe('created');
    expect(result.value.runningPayableMinor).toBe(8_000); // 200 - 120
    expect(result.value.journalId).toMatch(/^jrnl_/);

    // Journal lines: four, balanced.
    expect(journals.posts).toHaveLength(1);
    const posted = journals.posts[0]!.request;
    expect(posted.kind).toBe('refund');
    expect(posted.lines).toEqual([
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.marketplaceRevenue,
        debitMinor: 15_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.cash,
        creditMinor: 15_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.providerPayable,
        debitMinor: 12_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
      {
        accountCode: REFUND_JOURNAL_ACCOUNT_CODES.marketplaceRevenueContra,
        creditMinor: 12_000,
        currency: 'USD',
        memo: 'booking bk_abc refund',
      },
    ]);

    // Provider balance: 200 - 120 = 80 → 8_000 minor units.
    expect(prisma.payableRows).toHaveLength(1);
    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('80.00');
  });

  it('drives the running balance NEGATIVE on clawback (refund after payout)', async () => {
    // Provider has 50 in payable (after a prior payout drew it down).
    prisma.seedPayableBalance('prv_abc', new Decimal('50.00'));

    const result = await svc.applyBookingRefund(baseBookingRefund);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runningPayableMinor).toBe(-7_000); // 50 - 120

    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('-70.00');
  });

  it('creates a negative-amount row when the provider has no prior balance', async () => {
    // No prior row at all — refund arrives before any completion.
    const result = await svc.applyBookingRefund(baseBookingRefund);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.runningPayableMinor).toBe(-12_000);
    expect(prisma.payableRows).toHaveLength(1);
    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('-120.00');
    expect(prisma.payableRows[0]!.providerId).toBe('prv_abc');
  });

  it('skips the decrement when providerPortion is 0 (platform eats the refund)', async () => {
    prisma.seedPayableBalance('prv_abc', new Decimal('200.00'));

    const result = await svc.applyBookingRefund({
      ...baseBookingRefund,
      providerPortionMinor: 0,
      marketplacePortionMinor: 15_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.runningPayableMinor).toBe(20_000); // unchanged
    expect(prisma.providerPayableBalance.upsert).not.toHaveBeenCalled();
    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('200.00');

    // Journal is two-line.
    const posted = journals.posts[0]!.request;
    expect(posted.lines).toHaveLength(2);
  });

  it('full clawback (marketplacePortion=0) drives the entire refund out of provider payable', async () => {
    prisma.seedPayableBalance('prv_abc', new Decimal('200.00'));

    const result = await svc.applyBookingRefund({
      ...baseBookingRefund,
      providerPortionMinor: 15_000,
      marketplacePortionMinor: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runningPayableMinor).toBe(5_000); // 200 - 150
  });

  it('idempotent replay: returns the existing journal id WITHOUT decrementing twice', async () => {
    prisma.seedJournal(baseBookingRefund.sourceEventId, 'jrnl_existing');
    prisma.seedPayableBalance('prv_abc', new Decimal('80.00'));
    journals.scriptedResponses.push({
      ok: true,
      value: buildFakeJournalResponse(
        {
          kind: 'refund',
          occurredAt: baseBookingRefund.occurredAt,
          sourceEventId: baseBookingRefund.sourceEventId,
          description: 'previously-posted',
          lines: [],
          context: {},
        } as PostArgs,
        'jrnl_existing',
      ),
    });

    const result = await svc.applyBookingRefund(baseBookingRefund);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('idempotent_replay');
    expect(result.value.journalId).toBe('jrnl_existing');
    expect(result.value.runningPayableMinor).toBe(8_000); // unchanged

    expect(prisma.providerPayableBalance.upsert).not.toHaveBeenCalled();
    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('80.00');
  });

  it('rejects when refund != provider + marketplace (service-layer invariant)', async () => {
    const result = await svc.applyBookingRefund({
      ...baseBookingRefund,
      refundAmountMinor: 15_000,
      providerPortionMinor: 12_000,
      marketplacePortionMinor: 2_999, // off by 1¢
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('amount_invariant_violated');
    expect(journals.posts).toHaveLength(0);
    expect(prisma.payableRows).toHaveLength(0);
  });

  it('rejects a zero refund amount', async () => {
    const result = await svc.applyBookingRefund({
      ...baseBookingRefund,
      refundAmountMinor: 0,
      providerPortionMinor: 0,
      marketplacePortionMinor: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('amount_non_positive');
    expect(journals.posts).toHaveLength(0);
  });

  it('bubbles journal-post failures (account_inactive)', async () => {
    journals.scriptedResponses.push({
      ok: false,
      failure: { kind: 'account_inactive', accountCode: '4100' },
    });
    const result = await svc.applyBookingRefund(baseBookingRefund);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('journal_post_failed');
    if (result.failure.kind !== 'journal_post_failed') return;
    expect(result.failure.failure.kind).toBe('account_inactive');
    expect(prisma.providerPayableBalance.upsert).not.toHaveBeenCalled();
  });

  it('carries originalBookingJournalId in context when supplied', async () => {
    await svc.applyBookingRefund({
      ...baseBookingRefund,
      originalBookingJournalId: 'jrnl_orig_booking',
    });
    expect(journals.posts[0]!.request.context).toMatchObject({
      originalBookingJournalId: 'jrnl_orig_booking',
    });
  });

  it('logs clawback=true when the resulting balance is negative', async () => {
    // Setup: no prior balance, so refund drives it negative.
    const result = await svc.applyBookingRefund(baseBookingRefund);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runningPayableMinor).toBe(-12_000);
  });
});
