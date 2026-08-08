import { describe, expect, it } from 'vitest';

import {
  DISBURSEMENT_AMOUNT_MINOR_MAX,
  DISBURSEMENT_FAILURE_REASON_MAX_LENGTH,
  DISBURSEMENT_HOLD_DAYS_MAX,
  DISBURSEMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  DISBURSEMENT_LIST_LIMIT_DEFAULT,
  DISBURSEMENT_LIST_LIMIT_MAX,
  DISBURSEMENT_MEMO_MAX_LENGTH,
  DISBURSEMENT_SWEEP_PROVIDER_FILTER_MAX,
  IngestPayoutTransferEventRequestSchema,
  IngestPayoutTransferEventResponseSchema,
  ListMyPayoutDisbursementsQuerySchema,
  ListPayoutDisbursementsQuerySchema,
  PayoutDisbursementResponseSchema,
  PayoutDisbursementStatusSchema,
  PayoutDisbursementsListResponseSchema,
  PayoutSweepProviderSummarySchema,
  PayoutTransferEventOutcomeSchema,
  RunDisbursementSweepRequestSchema,
  RunDisbursementSweepResponseSchema,
  SchedulePayoutDisbursementRequestSchema,
  SchedulePayoutDisbursementResponseSchema,
} from '../http/payout-disbursement.schema';

const ISO_NOW = '2026-05-16T12:00:00.000Z';
const TODAY = '2026-05-16';

function buildDisbursement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd_abc12345',
    providerId: 'pr_abc',
    stripeAccountId: 'acct_stub_pr_abc',
    stripeTransferId: null,
    currency: 'USD',
    amountMinor: 10_000,
    status: 'pending',
    idempotencyKey: 'sweep:2026-05-16:pr_abc',
    sourceEventId: 'payout:disbursement:d_abc12345',
    scheduledFor: TODAY,
    heldUntil: ISO_NOW,
    initiatedAt: null,
    paidAt: null,
    failedAt: null,
    failureReason: null,
    memo: null,
    liveMode: false,
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    ...overrides,
  };
}

describe('PayoutDisbursementStatusSchema', () => {
  it.each(['pending', 'in_transit', 'paid', 'failed', 'canceled'] as const)('accepts %s', (v) => {
    expect(PayoutDisbursementStatusSchema.parse(v)).toBe(v);
  });

  it('rejects an unknown status', () => {
    expect(() => PayoutDisbursementStatusSchema.parse('unknown')).toThrow();
  });
});

describe('PayoutTransferEventOutcomeSchema', () => {
  it('accepts paid and failed', () => {
    expect(PayoutTransferEventOutcomeSchema.parse('paid')).toBe('paid');
    expect(PayoutTransferEventOutcomeSchema.parse('failed')).toBe('failed');
  });

  it('rejects sibling statuses like pending', () => {
    expect(() => PayoutTransferEventOutcomeSchema.parse('pending')).toThrow();
  });
});

describe('RunDisbursementSweepRequestSchema', () => {
  it('accepts the minimal happy body and defaults dryRun=false', () => {
    const parsed = RunDisbursementSweepRequestSchema.parse({ asOfDate: TODAY });
    expect(parsed.asOfDate).toBe(TODAY);
    expect(parsed.dryRun).toBe(false);
  });

  it('accepts optional knobs', () => {
    const parsed = RunDisbursementSweepRequestSchema.parse({
      asOfDate: TODAY,
      holdDays: 0,
      providerIds: ['pr_a', 'pr_b'],
      dryRun: true,
      minAmountMinor: 500,
    });
    expect(parsed.holdDays).toBe(0);
    expect(parsed.providerIds).toEqual(['pr_a', 'pr_b']);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.minAmountMinor).toBe(500);
  });

  it('rejects a non-YYYY-MM-DD asOfDate', () => {
    expect(() => RunDisbursementSweepRequestSchema.parse({ asOfDate: '2026/05/16' })).toThrow();
  });

  it(`rejects holdDays > ${DISBURSEMENT_HOLD_DAYS_MAX}`, () => {
    expect(() =>
      RunDisbursementSweepRequestSchema.parse({
        asOfDate: TODAY,
        holdDays: DISBURSEMENT_HOLD_DAYS_MAX + 1,
      }),
    ).toThrow();
  });

  it('rejects a negative minAmountMinor', () => {
    expect(() =>
      RunDisbursementSweepRequestSchema.parse({
        asOfDate: TODAY,
        minAmountMinor: -1,
      }),
    ).toThrow();
  });

  it(`rejects more than ${DISBURSEMENT_SWEEP_PROVIDER_FILTER_MAX} providerIds`, () => {
    const ids = Array.from(
      { length: DISBURSEMENT_SWEEP_PROVIDER_FILTER_MAX + 1 },
      (_, i) => `pr_${i}`,
    );
    expect(() =>
      RunDisbursementSweepRequestSchema.parse({ asOfDate: TODAY, providerIds: ids }),
    ).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      RunDisbursementSweepRequestSchema.parse({ asOfDate: TODAY, foo: 'bar' }),
    ).toThrow();
  });
});

describe('SchedulePayoutDisbursementRequestSchema', () => {
  const happy = {
    providerId: 'pr_abc',
    amountMinor: 5_000,
    currency: 'USD',
    idempotencyKey: 'manual:ops-2026-05-16:abc',
    scheduledFor: TODAY,
  };

  it('accepts the minimal happy body', () => {
    const parsed = SchedulePayoutDisbursementRequestSchema.parse(happy);
    expect(parsed.providerId).toBe('pr_abc');
    expect(parsed.amountMinor).toBe(5_000);
  });

  it('accepts optional sourceEventId + memo', () => {
    const parsed = SchedulePayoutDisbursementRequestSchema.parse({
      ...happy,
      sourceEventId: 'manual:abc',
      memo: 'dispute hold release',
    });
    expect(parsed.sourceEventId).toBe('manual:abc');
    expect(parsed.memo).toBe('dispute hold release');
  });

  it('rejects zero amountMinor', () => {
    expect(() =>
      SchedulePayoutDisbursementRequestSchema.parse({ ...happy, amountMinor: 0 }),
    ).toThrow();
  });

  it('rejects a non-integer amountMinor', () => {
    expect(() =>
      SchedulePayoutDisbursementRequestSchema.parse({ ...happy, amountMinor: 0.5 }),
    ).toThrow();
  });

  it(`rejects amountMinor > ${DISBURSEMENT_AMOUNT_MINOR_MAX}`, () => {
    expect(() =>
      SchedulePayoutDisbursementRequestSchema.parse({
        ...happy,
        amountMinor: DISBURSEMENT_AMOUNT_MINOR_MAX + 1,
      }),
    ).toThrow();
  });

  it('rejects lower-case currency', () => {
    expect(() =>
      SchedulePayoutDisbursementRequestSchema.parse({ ...happy, currency: 'usd' }),
    ).toThrow();
  });

  it(`rejects idempotencyKey > ${DISBURSEMENT_IDEMPOTENCY_KEY_MAX_LENGTH} chars`, () => {
    expect(() =>
      SchedulePayoutDisbursementRequestSchema.parse({
        ...happy,
        idempotencyKey: 'x'.repeat(DISBURSEMENT_IDEMPOTENCY_KEY_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it(`rejects memo > ${DISBURSEMENT_MEMO_MAX_LENGTH} chars`, () => {
    expect(() =>
      SchedulePayoutDisbursementRequestSchema.parse({
        ...happy,
        memo: 'x'.repeat(DISBURSEMENT_MEMO_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() => SchedulePayoutDisbursementRequestSchema.parse({ ...happy, foo: 'bar' })).toThrow();
  });
});

describe('IngestPayoutTransferEventRequestSchema', () => {
  const base = {
    stripeEventId: 'evt_xyz',
    eventType: 'transfer.paid',
    stripeTransferId: 'tr_abc',
    outcome: 'paid' as const,
    occurredAt: ISO_NOW,
  };

  it('accepts a paid event without a failureReason', () => {
    const parsed = IngestPayoutTransferEventRequestSchema.parse(base);
    expect(parsed.outcome).toBe('paid');
  });

  it('requires failureReason when outcome=failed', () => {
    expect(() =>
      IngestPayoutTransferEventRequestSchema.parse({ ...base, outcome: 'failed' }),
    ).toThrow();
  });

  it('accepts a failed event with a failureReason', () => {
    const parsed = IngestPayoutTransferEventRequestSchema.parse({
      ...base,
      outcome: 'failed',
      eventType: 'transfer.failed',
      failureReason: 'account_closed',
    });
    expect(parsed.outcome).toBe('failed');
    expect(parsed.failureReason).toBe('account_closed');
  });

  it(`rejects failureReason > ${DISBURSEMENT_FAILURE_REASON_MAX_LENGTH}`, () => {
    expect(() =>
      IngestPayoutTransferEventRequestSchema.parse({
        ...base,
        outcome: 'failed',
        failureReason: 'x'.repeat(DISBURSEMENT_FAILURE_REASON_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('rejects malformed occurredAt', () => {
    expect(() =>
      IngestPayoutTransferEventRequestSchema.parse({ ...base, occurredAt: '2026/05/16' }),
    ).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() => IngestPayoutTransferEventRequestSchema.parse({ ...base, foo: 'bar' })).toThrow();
  });
});

describe('PayoutDisbursementResponseSchema', () => {
  it('accepts a pending row', () => {
    const parsed = PayoutDisbursementResponseSchema.parse(buildDisbursement());
    expect(parsed.status).toBe('pending');
    expect(parsed.stripeTransferId).toBeNull();
  });

  it('accepts a paid row with timestamps + transfer id', () => {
    const parsed = PayoutDisbursementResponseSchema.parse(
      buildDisbursement({
        status: 'paid',
        stripeTransferId: 'tr_abc',
        initiatedAt: ISO_NOW,
        paidAt: ISO_NOW,
        liveMode: true,
      }),
    );
    expect(parsed.status).toBe('paid');
    expect(parsed.stripeTransferId).toBe('tr_abc');
  });

  it('accepts a failed row with failureReason', () => {
    const parsed = PayoutDisbursementResponseSchema.parse(
      buildDisbursement({
        status: 'failed',
        stripeTransferId: 'tr_def',
        initiatedAt: ISO_NOW,
        failedAt: ISO_NOW,
        failureReason: 'account_closed',
      }),
    );
    expect(parsed.status).toBe('failed');
    expect(parsed.failureReason).toBe('account_closed');
  });

  it('rejects malformed createdAt', () => {
    expect(() =>
      PayoutDisbursementResponseSchema.parse(buildDisbursement({ createdAt: 'yesterday' })),
    ).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      PayoutDisbursementResponseSchema.parse(buildDisbursement({ extra: 'x' })),
    ).toThrow();
  });
});

describe('SchedulePayoutDisbursementResponseSchema', () => {
  it('accepts created outcome', () => {
    const parsed = SchedulePayoutDisbursementResponseSchema.parse({
      outcome: 'created',
      disbursement: buildDisbursement(),
    });
    expect(parsed.outcome).toBe('created');
  });

  it('accepts existing outcome', () => {
    const parsed = SchedulePayoutDisbursementResponseSchema.parse({
      outcome: 'existing',
      disbursement: buildDisbursement(),
    });
    expect(parsed.outcome).toBe('existing');
  });

  it('rejects unknown outcome', () => {
    expect(() =>
      SchedulePayoutDisbursementResponseSchema.parse({
        outcome: 'unknown',
        disbursement: buildDisbursement(),
      }),
    ).toThrow();
  });
});

describe('PayoutSweepProviderSummarySchema', () => {
  it.each([
    'scheduled',
    'idempotent_existing',
    'skipped_no_account',
    'skipped_account_not_active',
    'skipped_no_balance',
    'skipped_below_threshold',
    'skipped_hold_not_cleared',
    'skipped_dry_run',
  ] as const)('accepts decision %s', (decision) => {
    const parsed = PayoutSweepProviderSummarySchema.parse({
      providerId: 'pr_abc',
      decision,
      amountMinor: 0,
      currency: 'USD',
      scheduledDisbursementId: null,
    });
    expect(parsed.decision).toBe(decision);
  });

  it('accepts a scheduled decision with disbursement id', () => {
    const parsed = PayoutSweepProviderSummarySchema.parse({
      providerId: 'pr_abc',
      decision: 'scheduled',
      amountMinor: 10_000,
      currency: 'USD',
      scheduledDisbursementId: 'd_abc',
    });
    expect(parsed.scheduledDisbursementId).toBe('d_abc');
  });
});

describe('RunDisbursementSweepResponseSchema', () => {
  it('accepts an empty sweep summary', () => {
    const parsed = RunDisbursementSweepResponseSchema.parse({
      asOfDate: TODAY,
      holdDays: 2,
      minAmountMinor: 100,
      dryRun: false,
      consideredProviderCount: 0,
      scheduledCount: 0,
      idempotentExistingCount: 0,
      skippedCount: 0,
      totalScheduledAmountMinor: 0,
      currency: 'USD',
      perProvider: [],
    });
    expect(parsed.scheduledCount).toBe(0);
    expect(parsed.perProvider).toEqual([]);
  });

  it('accepts a sweep with per-provider entries', () => {
    const parsed = RunDisbursementSweepResponseSchema.parse({
      asOfDate: TODAY,
      holdDays: 2,
      minAmountMinor: 100,
      dryRun: false,
      consideredProviderCount: 2,
      scheduledCount: 1,
      idempotentExistingCount: 0,
      skippedCount: 1,
      totalScheduledAmountMinor: 5_000,
      currency: 'USD',
      perProvider: [
        {
          providerId: 'pr_a',
          decision: 'scheduled',
          amountMinor: 5_000,
          currency: 'USD',
          scheduledDisbursementId: 'd_a',
        },
        {
          providerId: 'pr_b',
          decision: 'skipped_below_threshold',
          amountMinor: 50,
          currency: 'USD',
          scheduledDisbursementId: null,
        },
      ],
    });
    expect(parsed.perProvider).toHaveLength(2);
  });
});

describe('IngestPayoutTransferEventResponseSchema', () => {
  it('accepts applied outcome with disbursement', () => {
    const parsed = IngestPayoutTransferEventResponseSchema.parse({
      outcome: 'applied',
      disbursement: buildDisbursement({ status: 'paid' }),
    });
    expect(parsed.outcome).toBe('applied');
  });

  it('accepts ignored outcome with null disbursement', () => {
    const parsed = IngestPayoutTransferEventResponseSchema.parse({
      outcome: 'ignored',
      disbursement: null,
    });
    expect(parsed.disbursement).toBeNull();
  });
});

describe('ListPayoutDisbursementsQuerySchema', () => {
  it('coerces limit from string', () => {
    const parsed = ListPayoutDisbursementsQuerySchema.parse({ limit: '25' });
    expect(parsed.limit).toBe(25);
  });

  it('defaults limit', () => {
    const parsed = ListPayoutDisbursementsQuerySchema.parse({});
    expect(parsed.limit).toBe(DISBURSEMENT_LIST_LIMIT_DEFAULT);
  });

  it(`rejects limit > ${DISBURSEMENT_LIST_LIMIT_MAX}`, () => {
    expect(() =>
      ListPayoutDisbursementsQuerySchema.parse({ limit: DISBURSEMENT_LIST_LIMIT_MAX + 1 }),
    ).toThrow();
  });

  it('accepts every filter', () => {
    const parsed = ListPayoutDisbursementsQuerySchema.parse({
      limit: '10',
      cursor: 'abc',
      providerId: 'pr_a',
      status: 'paid',
      scheduledOnOrAfter: '2026-01-01',
      scheduledOnOrBefore: '2026-12-31',
    });
    expect(parsed.providerId).toBe('pr_a');
    expect(parsed.status).toBe('paid');
  });
});

describe('ListMyPayoutDisbursementsQuerySchema', () => {
  it('accepts an empty body', () => {
    const parsed = ListMyPayoutDisbursementsQuerySchema.parse({});
    expect(parsed.limit).toBe(DISBURSEMENT_LIST_LIMIT_DEFAULT);
  });

  it('rejects providerId field (strict mode — self-service surface)', () => {
    expect(() => ListMyPayoutDisbursementsQuerySchema.parse({ providerId: 'pr_a' })).toThrow();
  });
});

describe('PayoutDisbursementsListResponseSchema', () => {
  it('accepts an empty list', () => {
    const parsed = PayoutDisbursementsListResponseSchema.parse({
      rows: [],
      nextCursor: null,
    });
    expect(parsed.rows).toEqual([]);
  });

  it('accepts a paged list with cursor', () => {
    const parsed = PayoutDisbursementsListResponseSchema.parse({
      rows: [buildDisbursement(), buildDisbursement({ id: 'd_2' })],
      nextCursor: 'd_2',
    });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.nextCursor).toBe('d_2');
  });
});
