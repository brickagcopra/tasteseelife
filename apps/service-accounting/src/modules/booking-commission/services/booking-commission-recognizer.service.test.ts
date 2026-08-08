import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookingCommissionRequest, JournalResponse } from '@taste-and-see/contracts';

import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  JournalPostingService,
  PostJournalFailure,
  Result as JournalResult,
} from '../../journals/services/journal-posting.service';
import {
  BOOKING_COMMISSION_ACCOUNT_CODES,
  BookingCommissionRecognizerService,
  buildBookingCommissionLines,
} from './booking-commission-recognizer.service';

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
 * FakePrisma covering the BookingCommissionRecognizerService's two read
 * + write surfaces:
 *
 *   - `journal.findUnique({ where: { sourceEventId }, select: { id } })`
 *     for the replay pre-flight.
 *   - `providerPayableBalance.upsert / findUnique` for the running-
 *     balance materialised view.
 *   - `$transaction` for the upsert wrapper (single-test isolation; no
 *     rollback fidelity needed — that's Testcontainers' job).
 *
 * The journal-post call goes through JournalsMock at the service-class
 * layer, so this fake doesn't need to track journals beyond a thin
 * `journals` index that the test seeds when modelling the replay path.
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
          amount: { increment: Decimal };
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
        existing.amount = existing.amount.add(args.update.amount.increment);
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
    postedAt: '2026-05-15T00:00:00.000Z',
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
  service: BookingCommissionRecognizerService;
  prisma: FakePrisma;
  journals: JournalsMock;
} {
  const prisma = new FakePrisma();
  const journals = new JournalsMock();
  const service = new BookingCommissionRecognizerService(
    prisma as unknown as PrismaService,
    journals as unknown as JournalPostingService,
  );
  return { service, prisma, journals };
}

const baseRequest: BookingCommissionRequest = {
  bookingId: 'bk_abc',
  providerId: 'prv_abc',
  householdId: 'hh_abc',
  grossAmountMinor: 15_000,
  providerAmountMinor: 12_000,
  marketplaceAmountMinor: 3_000,
  commissionRateBps: 2_000,
  currency: 'USD',
  completedAt: '2026-05-15T14:30:00.000Z',
  sourceEventId: 'evt_booking.completed_bk_abc',
};

describe('BookingCommissionRecognizerService.recognizeBookingCompleted', () => {
  let svc: BookingCommissionRecognizerService;
  let prisma: FakePrisma;
  let journals: JournalsMock;

  beforeEach(() => {
    ({ service: svc, prisma, journals } = buildService());
  });

  it('posts the four-line PDD Appendix A journal AND upserts the running balance', async () => {
    const result = await svc.recognizeBookingCompleted(baseRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.result).toBe('created');
    expect(result.value.providerId).toBe('prv_abc');
    expect(result.value.runningPayableMinor).toBe(12_000);
    expect(result.value.journalId).toMatch(/^jrnl_/);

    // Journal post: four lines, balanced.
    expect(journals.posts).toHaveLength(1);
    const posted = journals.posts[0]!.request;
    expect(posted.kind).toBe('booking_completion');
    expect(posted.lines).toEqual([
      {
        accountCode: BOOKING_COMMISSION_ACCOUNT_CODES.cash,
        debitMinor: 15_000,
        currency: 'USD',
        memo: 'booking bk_abc',
      },
      {
        accountCode: BOOKING_COMMISSION_ACCOUNT_CODES.marketplaceRevenue,
        creditMinor: 15_000,
        currency: 'USD',
        memo: 'booking bk_abc',
      },
      {
        accountCode: BOOKING_COMMISSION_ACCOUNT_CODES.marketplaceRevenueContra,
        debitMinor: 12_000,
        currency: 'USD',
        memo: 'booking bk_abc',
      },
      {
        accountCode: BOOKING_COMMISSION_ACCOUNT_CODES.providerPayable,
        creditMinor: 12_000,
        currency: 'USD',
        memo: 'booking bk_abc',
      },
    ]);

    // Sum invariant: DR = CR.
    const debitTotal = posted.lines.reduce((acc, l) => acc + (l.debitMinor ?? 0), 0);
    const creditTotal = posted.lines.reduce((acc, l) => acc + (l.creditMinor ?? 0), 0);
    expect(debitTotal).toBe(creditTotal);

    // context carries every reporting-essential field.
    expect(posted.context).toMatchObject({
      bookingId: 'bk_abc',
      providerId: 'prv_abc',
      householdId: 'hh_abc',
      commissionRateBps: 2_000,
      grossAmountMinor: 15_000,
      providerAmountMinor: 12_000,
      marketplaceAmountMinor: 3_000,
    });

    // Running-balance materialised view: one row, $120.
    expect(prisma.payableRows).toHaveLength(1);
    const balance = prisma.payableRows[0]!;
    expect(balance.providerId).toBe('prv_abc');
    expect(balance.currency).toBe('USD');
    expect(balance.amount.toFixed(2)).toBe('120.00');
  });

  it('subsequent bookings against the same provider increment the running balance', async () => {
    const first = await svc.recognizeBookingCompleted(baseRequest);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.runningPayableMinor).toBe(12_000);

    const second = await svc.recognizeBookingCompleted({
      ...baseRequest,
      bookingId: 'bk_def',
      sourceEventId: 'evt_booking.completed_bk_def',
      grossAmountMinor: 20_000,
      providerAmountMinor: 16_000,
      marketplaceAmountMinor: 4_000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.runningPayableMinor).toBe(28_000); // 120 + 160
    expect(prisma.payableRows).toHaveLength(1); // still one row, incremented
  });

  it('idempotent replay: returns the same journal id WITHOUT double-counting the running balance', async () => {
    // Seed the replay path: pretend a previous post landed.
    prisma.seedJournal(baseRequest.sourceEventId, 'jrnl_existing');
    // Seed a running balance reflecting that prior post.
    prisma.payableRows.push({
      id: 'ppb_seed',
      providerId: baseRequest.providerId,
      currency: 'USD',
      amount: new Decimal('120.00'),
      lastUpdatedAt: new Date('2026-05-15T14:30:00.000Z'),
      createdAt: new Date('2026-05-15T14:30:00.000Z'),
      updatedAt: new Date('2026-05-15T14:30:00.000Z'),
    });
    // Stub JournalPostingService.post to return the "existing" row.
    journals.scriptedResponses.push({
      ok: true,
      value: buildFakeJournalResponse(
        {
          kind: 'booking_completion',
          occurredAt: baseRequest.completedAt,
          sourceEventId: baseRequest.sourceEventId,
          description: 'previously-posted',
          lines: [],
          context: {},
        } as PostArgs,
        'jrnl_existing',
      ),
    });

    const result = await svc.recognizeBookingCompleted(baseRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('idempotent_replay');
    expect(result.value.journalId).toBe('jrnl_existing');
    expect(result.value.runningPayableMinor).toBe(12_000); // unchanged

    // The upsert MUST NOT have been called — replay path reads only.
    expect(prisma.providerPayableBalance.upsert).not.toHaveBeenCalled();
    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('120.00');
  });

  it('rejects when gross != provider + marketplace (service-layer invariant)', async () => {
    const result = await svc.recognizeBookingCompleted({
      ...baseRequest,
      grossAmountMinor: 15_000,
      providerAmountMinor: 12_000,
      marketplaceAmountMinor: 2_999, // off by 1¢
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('amount_invariant_violated');
    expect(journals.posts).toHaveLength(0);
    expect(prisma.payableRows).toHaveLength(0);
  });

  it('rejects a zero-gross booking', async () => {
    const result = await svc.recognizeBookingCompleted({
      ...baseRequest,
      grossAmountMinor: 0,
      providerAmountMinor: 0,
      marketplaceAmountMinor: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('amount_non_positive');
    expect(journals.posts).toHaveLength(0);
  });

  it('forwards a journal_post_failed failure (account_not_found)', async () => {
    journals.scriptedResponses.push({
      ok: false,
      failure: { kind: 'account_not_found', accountCode: '1000' },
    });
    const result = await svc.recognizeBookingCompleted(baseRequest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('journal_post_failed');
    if (result.failure.kind !== 'journal_post_failed') return;
    expect(result.failure.failure.kind).toBe('account_not_found');
    if (result.failure.failure.kind !== 'account_not_found') return;
    expect(result.failure.failure.accountCode).toBe('1000');
    expect(prisma.payableRows).toHaveLength(0); // no balance update on failure
  });

  it('forwards a journal_post_failed failure (period_closed)', async () => {
    journals.scriptedResponses.push({
      ok: false,
      failure: {
        kind: 'period_closed',
        periodId: 'prd_2026_04',
        periodName: '2026-04',
      },
    });
    const result = await svc.recognizeBookingCompleted({
      ...baseRequest,
      completedAt: '2026-04-30T23:59:59.999Z',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('journal_post_failed');
    if (result.failure.kind !== 'journal_post_failed') return;
    expect(result.failure.failure.kind).toBe('period_closed');
    expect(prisma.payableRows).toHaveLength(0);
  });

  it('collapses to two lines for a 100%-platform-retention booking (provider = 0)', async () => {
    const result = await svc.recognizeBookingCompleted({
      ...baseRequest,
      grossAmountMinor: 15_000,
      providerAmountMinor: 0,
      marketplaceAmountMinor: 15_000,
      commissionRateBps: 10_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(journals.posts).toHaveLength(1);
    const posted = journals.posts[0]!.request;
    // Two-line journal (Cash + Marketplace Revenue only — contra is skipped)
    expect(posted.lines).toHaveLength(2);
    expect(posted.lines[0]!.accountCode).toBe(BOOKING_COMMISSION_ACCOUNT_CODES.cash);
    expect(posted.lines[1]!.accountCode).toBe(BOOKING_COMMISSION_ACCOUNT_CODES.marketplaceRevenue);

    // Running balance still upserts (with a 0 delta).
    expect(prisma.payableRows).toHaveLength(1);
    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('0.00');
    expect(result.value.runningPayableMinor).toBe(0);
  });

  it('full-provider-portion (0%-commission booking) posts 4 lines: contra reclassifies the full gross', async () => {
    const result = await svc.recognizeBookingCompleted({
      ...baseRequest,
      grossAmountMinor: 15_000,
      providerAmountMinor: 15_000,
      marketplaceAmountMinor: 0,
      commissionRateBps: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const posted = journals.posts[0]!.request;
    expect(posted.lines).toHaveLength(4);
    // Sum still balances: DR 15000 + 15000 = CR 15000 + 15000.
    const debitTotal = posted.lines.reduce((acc, l) => acc + (l.debitMinor ?? 0), 0);
    const creditTotal = posted.lines.reduce((acc, l) => acc + (l.creditMinor ?? 0), 0);
    expect(debitTotal).toBe(30_000);
    expect(creditTotal).toBe(30_000);
    expect(result.value.runningPayableMinor).toBe(15_000);
  });

  it('records the source event id on the journal request for the relay UNIQUE-key replay', async () => {
    await svc.recognizeBookingCompleted(baseRequest);
    const posted = journals.posts[0]!.request;
    expect(posted.sourceEventId).toBe('evt_booking.completed_bk_abc');
  });

  it('honours an override description', async () => {
    await svc.recognizeBookingCompleted({
      ...baseRequest,
      description: 'Holiday dinner @ Bk_abc',
    });
    expect(journals.posts[0]!.request.description).toBe('Holiday dinner @ Bk_abc');
  });

  it('defaults description when omitted', async () => {
    await svc.recognizeBookingCompleted(baseRequest);
    const description = journals.posts[0]!.request.description;
    expect(description).toContain('bk_abc');
    expect(description).toContain('prv_abc');
  });

  it('forwards inbound context fields without clobbering the canonical reporting fields', async () => {
    await svc.recognizeBookingCompleted({
      ...baseRequest,
      context: { invoiceId: 'inv_abc', tip: 500 },
    });
    const posted = journals.posts[0]!.request;
    expect(posted.context).toMatchObject({
      bookingId: 'bk_abc',
      providerId: 'prv_abc',
      invoiceId: 'inv_abc',
      tip: 500,
    });
  });

  it('exact-cent precision: $0.01 booking is processed without rounding drift', async () => {
    const result = await svc.recognizeBookingCompleted({
      ...baseRequest,
      bookingId: 'bk_penny',
      sourceEventId: 'evt_penny',
      grossAmountMinor: 1,
      providerAmountMinor: 1,
      marketplaceAmountMinor: 0,
      commissionRateBps: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runningPayableMinor).toBe(1);
    expect(prisma.payableRows[0]!.amount.toFixed(2)).toBe('0.01');
  });
});

describe('BookingCommissionRecognizerService.getProviderPayableBalance', () => {
  it('returns null when no booking has been completed for the provider', async () => {
    const { service: svc } = buildService();
    const row = await svc.getProviderPayableBalance('prv_unknown', 'USD');
    expect(row).toBeNull();
  });

  it('returns the persisted balance with currency + lastUpdatedAt', async () => {
    const { service: svc, prisma } = buildService();
    const now = new Date('2026-05-15T14:30:00.000Z');
    prisma.payableRows.push({
      id: 'ppb_1',
      providerId: 'prv_abc',
      currency: 'USD',
      amount: new Decimal('120.00'),
      lastUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const row = await svc.getProviderPayableBalance('prv_abc', 'USD');
    expect(row).not.toBeNull();
    expect(row?.providerId).toBe('prv_abc');
    expect(row?.amountMinor).toBe(12_000);
    expect(row?.currency).toBe('USD');
    expect(row?.lastUpdatedAt).toEqual(now);
  });

  it('exact-cent round-trip: $99,999,999.99 envelope value', async () => {
    const { service: svc, prisma } = buildService();
    prisma.payableRows.push({
      id: 'ppb_1',
      providerId: 'prv_abc',
      currency: 'USD',
      amount: new Decimal('99999999.99'),
      lastUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const row = await svc.getProviderPayableBalance('prv_abc', 'USD');
    expect(row?.amountMinor).toBe(9_999_999_999);
  });
});

describe('BookingCommissionRecognizerService.readRunningPayableMinor', () => {
  it('returns 0 when no row exists for the (provider, currency)', async () => {
    const { service: svc } = buildService();
    const minor = await svc.readRunningPayableMinor('prv_unknown', 'USD');
    expect(minor).toBe(0);
  });

  it('returns the persisted minor amount', async () => {
    const { service: svc, prisma } = buildService();
    prisma.payableRows.push({
      id: 'ppb_1',
      providerId: 'prv_abc',
      currency: 'USD',
      amount: new Decimal('12.34'),
      lastUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const minor = await svc.readRunningPayableMinor('prv_abc', 'USD');
    expect(minor).toBe(1_234);
  });
});

describe('buildBookingCommissionLines (pure helper)', () => {
  it('emits four lines for the canonical PDD Appendix A shape', () => {
    const lines = buildBookingCommissionLines({
      grossAmountMinor: 15_000,
      providerAmountMinor: 12_000,
      marketplaceAmountMinor: 3_000,
      memo: 'booking bk_abc',
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ accountCode: '1000', debitMinor: 15_000 });
    expect(lines[1]).toMatchObject({ accountCode: '4100', creditMinor: 15_000 });
    expect(lines[2]).toMatchObject({ accountCode: '4500', debitMinor: 12_000 });
    expect(lines[3]).toMatchObject({ accountCode: '2100', creditMinor: 12_000 });
  });

  it('collapses to two lines when providerAmountMinor is 0', () => {
    const lines = buildBookingCommissionLines({
      grossAmountMinor: 15_000,
      providerAmountMinor: 0,
      marketplaceAmountMinor: 15_000,
      memo: 'booking bk_abc',
    });
    expect(lines).toHaveLength(2);
  });

  it('always balances (DR sum = CR sum) regardless of split', () => {
    for (const [gross, provider] of [
      [15_000, 12_000],
      [15_000, 0],
      [15_000, 15_000],
      [1, 1],
      [9_999_999_999, 0],
    ] as const) {
      const lines = buildBookingCommissionLines({
        grossAmountMinor: gross,
        providerAmountMinor: provider,
        marketplaceAmountMinor: gross - provider,
        memo: 'm',
      });
      const dr = lines.reduce((a, l) => a + (l.debitMinor ?? 0), 0);
      const cr = lines.reduce((a, l) => a + (l.creditMinor ?? 0), 0);
      expect(dr).toBe(cr);
    }
  });
});
