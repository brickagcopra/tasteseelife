import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApplyCouponRedemptionRequest, JournalResponse } from '@taste-and-see/contracts';

import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  JournalPostingService,
  PostJournalFailure,
  Result as JournalResult,
} from '../../journals/services/journal-posting.service';
import { PlanAccountResolverService } from '../../revenue-recognition/services/plan-account-resolver.service';
import {
  COUPON_CONTRA_REVENUE_ACCOUNT_CODE,
  CouponContraRevenueService,
} from './coupon-contra-revenue.service';

interface FakeJournalRow {
  id: string;
  sourceEventId: string;
}

/**
 * FakePrisma covering the CouponContraRevenueService's single read path
 * (`journal.findUnique({ where: { sourceEventId } })` for the replay
 * pre-flight). Mirrors the slim FakePrisma in booking-commission-
 * recognizer's test — single-test isolation, no rollback fidelity.
 */
class FakePrisma {
  public journals: FakeJournalRow[] = [];
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

  seedJournal(sourceEventId: string, id?: string): FakeJournalRow {
    this.autoId += 1;
    const row: FakeJournalRow = {
      id: id ?? `jrnl_seed_${this.autoId}`,
      sourceEventId,
    };
    this.journals.push(row);
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
  service: CouponContraRevenueService;
  prisma: FakePrisma;
  journals: JournalsMock;
} {
  const prisma = new FakePrisma();
  const journals = new JournalsMock();
  const accounts = new PlanAccountResolverService();
  const service = new CouponContraRevenueService(
    prisma as unknown as PrismaService,
    journals as unknown as JournalPostingService,
    accounts,
  );
  return { service, prisma, journals };
}

const baseRequest: ApplyCouponRedemptionRequest = {
  couponRedemptionId: 'cred_abc',
  subscriptionId: 'sub_abc',
  customerId: 'cust_abc',
  customerGroup: 'family',
  planCode: 'family.tier2',
  discountAmountMinor: 5_000,
  currency: 'USD',
  occurredAt: '2026-05-12T10:00:00.000Z',
  sourceEventId: 'evt_coupon.redeemed_cred_abc',
};

describe('CouponContraRevenueService.applyCouponRedemption', () => {
  let svc: CouponContraRevenueService;
  let prisma: FakePrisma;
  let journals: JournalsMock;

  beforeEach(() => {
    ({ service: svc, prisma, journals } = buildService());
  });

  it('posts the two-line PDD Appendix A coupon journal', async () => {
    const result = await svc.applyCouponRedemption(baseRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.result).toBe('created');
    expect(result.value.discountAmountMinor).toBe(5_000);
    expect(result.value.journalId).toMatch(/^jrnl_/);

    expect(journals.posts).toHaveLength(1);
    const posted = journals.posts[0]!.request;
    expect(posted.kind).toBe('coupon_redemption');
    expect(posted.lines).toEqual([
      {
        accountCode: COUPON_CONTRA_REVENUE_ACCOUNT_CODE,
        debitMinor: 5_000,
        currency: 'USD',
        memo: 'coupon cred_abc on sub_abc',
      },
      {
        accountCode: '4000.family.tier2',
        creditMinor: 5_000,
        currency: 'USD',
        memo: 'coupon cred_abc on sub_abc',
      },
    ]);

    // Sum invariant: DR = CR.
    const debitTotal = posted.lines.reduce((acc, l) => acc + (l.debitMinor ?? 0), 0);
    const creditTotal = posted.lines.reduce((acc, l) => acc + (l.creditMinor ?? 0), 0);
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(5_000);

    // Context carries every reporting-essential field.
    expect(posted.context).toMatchObject({
      couponRedemptionId: 'cred_abc',
      subscriptionId: 'sub_abc',
      customerId: 'cust_abc',
      customerGroup: 'family',
      planCode: 'family.tier2',
      discountAmountMinor: 5_000,
    });
  });

  it('resolves the revenue account from the plan code', async () => {
    const result = await svc.applyCouponRedemption({
      ...baseRequest,
      planCode: 'provider.elite',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const posted = journals.posts[0]!.request;
    const creditLine = posted.lines.find((l) => (l.creditMinor ?? 0) > 0);
    expect(creditLine?.accountCode).toBe('4000.provider.elite');
  });

  it('idempotent replay: returns the existing journal id with result=idempotent_replay', async () => {
    // Seed the replay path: pretend a previous post landed.
    prisma.seedJournal(baseRequest.sourceEventId, 'jrnl_existing');
    // Stub JournalPostingService.post to return the existing row.
    journals.scriptedResponses.push({
      ok: true,
      value: buildFakeJournalResponse(
        {
          kind: 'coupon_redemption',
          occurredAt: baseRequest.occurredAt,
          sourceEventId: baseRequest.sourceEventId,
          description: 'previously-posted',
          lines: [],
          context: {},
        } as PostArgs,
        'jrnl_existing',
      ),
    });

    const result = await svc.applyCouponRedemption(baseRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('idempotent_replay');
    expect(result.value.journalId).toBe('jrnl_existing');
  });

  it('rejects a zero-discount redemption', async () => {
    const result = await svc.applyCouponRedemption({
      ...baseRequest,
      discountAmountMinor: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('amount_non_positive');
    expect(journals.posts).toHaveLength(0);
  });

  it('bubbles journal-post failures as journal_post_failed', async () => {
    journals.scriptedResponses.push({
      ok: false,
      failure: { kind: 'account_not_found', accountCode: '4000.family.tier2' },
    });

    const result = await svc.applyCouponRedemption(baseRequest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('journal_post_failed');
    if (result.failure.kind !== 'journal_post_failed') return;
    expect(result.failure.failure).toEqual({
      kind: 'account_not_found',
      accountCode: '4000.family.tier2',
    });
  });

  it('uses the supplied description when provided', async () => {
    const customDesc = 'Spring 2026 promo discount on sub_abc';
    await svc.applyCouponRedemption({
      ...baseRequest,
      description: customDesc,
    });
    expect(journals.posts[0]!.request.description).toBe(customDesc);
  });

  it('falls back to a synthesised description when omitted', async () => {
    await svc.applyCouponRedemption(baseRequest);
    expect(journals.posts[0]!.request.description).toBe(
      'Coupon redemption: cred_abc on subscription sub_abc',
    );
  });

  it('merges request.context into the journal context (request keys do not override resolved keys)', async () => {
    await svc.applyCouponRedemption({
      ...baseRequest,
      context: { stripeInvoiceId: 'in_test', customField: 42 },
    });
    expect(journals.posts[0]!.request.context).toMatchObject({
      couponRedemptionId: 'cred_abc',
      stripeInvoiceId: 'in_test',
      customField: 42,
    });
  });
});
