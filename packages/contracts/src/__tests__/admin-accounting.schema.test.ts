import { describe, expect, it } from 'vitest';

import {
  ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR,
  ADMIN_JOURNALS_LIST_LIMIT_DEFAULT,
  ADMIN_JOURNALS_LIST_LIMIT_MAX,
  ADMIN_PAUSED_BALANCES_LIST_LIMIT_DEFAULT,
  ADMIN_PAUSED_BALANCES_LIST_LIMIT_MAX,
  ADMIN_PERIOD_EVENTS_LIST_LIMIT_DEFAULT,
  ADMIN_PERIOD_EVENTS_LIST_LIMIT_MAX,
  AdminJournalDetailResponseSchema,
  AdminJournalDetailSchema,
  AdminJournalLineSchema,
  AdminJournalSummarySchema,
  AdminJournalsListQuerySchema,
  AdminJournalsListResponseSchema,
  AdminPausedDeferredRevenueBalanceSchema,
  AdminPausedDeferredRevenueQuerySchema,
  AdminPausedDeferredRevenueResponseSchema,
  AdminPausedDeferredRevenueSummarySchema,
  AdminPeriodEventSchema,
  AdminPeriodEventsListQuerySchema,
  AdminPeriodEventsListResponseSchema,
  AdminTrialBalanceQuerySchema,
  AdminTrialBalanceResponseSchema,
  AdminTrialBalanceRowSchema,
  type AdminJournalDetail,
  type AdminJournalLine,
  type AdminJournalSummary,
  type AdminPausedDeferredRevenueBalance,
  type AdminPausedDeferredRevenueSummary,
  type AdminPeriodEvent,
  type AdminTrialBalanceRow,
} from '../http/admin-accounting.schema';

const NOW_ISO = '2026-05-18T12:00:00.000Z';

const sampleLine: AdminJournalLine = {
  id: 'jln_abc',
  accountId: 'acc_abc',
  accountCode: '1000',
  accountName: 'Cash',
  debitMinor: 29_900,
  creditMinor: 0,
  currency: 'USD',
  memo: 'Activation deposit',
};

const sampleSummary: AdminJournalSummary = {
  id: 'jnl_abc',
  kind: 'subscription_activation',
  occurredAt: NOW_ISO,
  postedAt: NOW_ISO,
  sourceEventId: 'evt_sub_act_abc',
  description: 'Tier 2 Companion Dining activation',
  periodId: 'per_abc',
  periodName: '2026-05',
  postedByUserId: null,
  reversedJournalId: null,
  reversedByJournalId: null,
  lineCount: 2,
  totalDebitMinor: 29_900,
  totalCreditMinor: 29_900,
  currency: 'USD',
};

const sampleDetail: AdminJournalDetail = {
  id: 'jnl_abc',
  kind: 'subscription_activation',
  occurredAt: NOW_ISO,
  postedAt: NOW_ISO,
  sourceEventId: 'evt_sub_act_abc',
  description: 'Tier 2 Companion Dining activation',
  periodId: 'per_abc',
  periodName: '2026-05',
  postedByUserId: null,
  reversedJournalId: null,
  reversedByJournalId: null,
  totalDebitMinor: 29_900,
  totalCreditMinor: 29_900,
  currency: 'USD',
  context: { stripeInvoiceId: 'in_abc' },
  lines: [
    sampleLine,
    {
      id: 'jln_def',
      accountId: 'acc_def',
      accountCode: '2000.family.tier2',
      accountName: 'Deferred Revenue — Tier 2 Companion Dining',
      debitMinor: 0,
      creditMinor: 29_900,
      currency: 'USD',
      memo: null,
    },
  ],
};

const sampleTrialBalanceRow: AdminTrialBalanceRow = {
  accountId: 'acc_abc',
  accountCode: '1000',
  accountName: 'Cash',
  accountType: 'asset',
  normalBalance: 'debit',
  debitTotalMinor: 100_000,
  creditTotalMinor: 30_000,
  netDebitMinor: 70_000,
  netCreditMinor: 0,
  currency: 'USD',
};

const samplePeriodEvent: AdminPeriodEvent = {
  id: 'ple_abc',
  periodId: 'per_abc',
  periodName: '2026-05',
  kind: 'close',
  actorUserId: 'usr_admin_abc',
  sourceEventId: 'admin_close_abc',
  reasonCode: 'monthly_close',
  description: 'Routine monthly close for May.',
  occurredAt: NOW_ISO,
  createdAt: NOW_ISO,
};

describe('AdminJournalsListQuerySchema', () => {
  it('returns a fully-defaulted parse when no filters supplied', () => {
    const parsed = AdminJournalsListQuerySchema.parse({});
    expect(parsed.limit).toBe(ADMIN_JOURNALS_LIST_LIMIT_DEFAULT);
    expect(parsed.periodId).toBeUndefined();
    expect(parsed.periodName).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a numeric-string limit (URL query params arrive as strings)', () => {
    const parsed = AdminJournalsListQuerySchema.parse({ limit: '40' });
    expect(parsed.limit).toBe(40);
  });

  it('rejects a limit above the bound', () => {
    expect(
      AdminJournalsListQuerySchema.safeParse({
        limit: ADMIN_JOURNALS_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a zero / negative limit', () => {
    expect(AdminJournalsListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AdminJournalsListQuerySchema.safeParse({ limit: -1 }).success).toBe(false);
  });

  it('accepts a valid periodName (YYYY-MM)', () => {
    const parsed = AdminJournalsListQuerySchema.parse({ periodName: '2026-05' });
    expect(parsed.periodName).toBe('2026-05');
  });

  it('rejects a malformed periodName', () => {
    expect(AdminJournalsListQuerySchema.safeParse({ periodName: 'May 2026' }).success).toBe(false);
    expect(AdminJournalsListQuerySchema.safeParse({ periodName: '2026-13' }).success).toBe(false);
  });

  it('accepts every JournalKind enum value', () => {
    for (const kind of [
      'subscription_activation',
      'subscription_recognition',
      'subscription_cancellation',
      'booking_completion',
      'provider_payout',
      'refund',
      'coupon_redemption',
      'payment_processing_fee',
      'manual_adjustment',
      'period_close',
      'reversal',
    ] as const) {
      const parsed = AdminJournalsListQuerySchema.parse({ kind });
      expect(parsed.kind).toBe(kind);
    }
  });

  it('rejects an unknown kind value', () => {
    expect(AdminJournalsListQuerySchema.safeParse({ kind: 'mystery' }).success).toBe(false);
  });

  it('rejects an empty periodId', () => {
    expect(AdminJournalsListQuerySchema.safeParse({ periodId: '' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminJournalsListQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false);
  });
});

describe('AdminJournalLineSchema', () => {
  it('round-trips a debit line', () => {
    const parsed = AdminJournalLineSchema.parse(sampleLine);
    expect(parsed).toEqual(sampleLine);
  });

  it('round-trips a credit line with null memo', () => {
    const parsed = AdminJournalLineSchema.parse({
      ...sampleLine,
      debitMinor: 0,
      creditMinor: 29_900,
      memo: null,
    });
    expect(parsed.creditMinor).toBe(29_900);
    expect(parsed.memo).toBeNull();
  });

  it('rejects a non-integer debit', () => {
    expect(AdminJournalLineSchema.safeParse({ ...sampleLine, debitMinor: 100.5 }).success).toBe(
      false,
    );
  });

  it('rejects a negative debit', () => {
    expect(AdminJournalLineSchema.safeParse({ ...sampleLine, debitMinor: -1 }).success).toBe(false);
  });

  it('rejects an invalid accountCode', () => {
    expect(
      AdminJournalLineSchema.safeParse({ ...sampleLine, accountCode: 'NOT_A_CODE!' }).success,
    ).toBe(false);
  });

  it('rejects a non-USD currency (Phase-1 enum)', () => {
    expect(AdminJournalLineSchema.safeParse({ ...sampleLine, currency: 'EUR' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminJournalLineSchema.safeParse({ ...sampleLine, extra: 'nope' }).success).toBe(false);
  });
});

describe('AdminJournalSummarySchema', () => {
  it('round-trips the sample summary', () => {
    const parsed = AdminJournalSummarySchema.parse(sampleSummary);
    expect(parsed).toEqual(sampleSummary);
  });

  it('accepts a manual_adjustment with a postedByUserId', () => {
    const parsed = AdminJournalSummarySchema.parse({
      ...sampleSummary,
      kind: 'manual_adjustment',
      postedByUserId: 'usr_admin_abc',
    });
    expect(parsed.kind).toBe('manual_adjustment');
    expect(parsed.postedByUserId).toBe('usr_admin_abc');
  });

  it('accepts a reversed journal carrying the reversal pointer', () => {
    const parsed = AdminJournalSummarySchema.parse({
      ...sampleSummary,
      reversedByJournalId: 'jnl_reversal_abc',
    });
    expect(parsed.reversedByJournalId).toBe('jnl_reversal_abc');
  });

  it('rejects a non-integer total', () => {
    expect(
      AdminJournalSummarySchema.safeParse({
        ...sampleSummary,
        totalDebitMinor: 1.5,
      }).success,
    ).toBe(false);
  });

  it('rejects a negative total', () => {
    expect(
      AdminJournalSummarySchema.safeParse({
        ...sampleSummary,
        totalCreditMinor: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects a lineCount below the minimum (2)', () => {
    expect(AdminJournalSummarySchema.safeParse({ ...sampleSummary, lineCount: 1 }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminJournalSummarySchema.safeParse({ ...sampleSummary, extra: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('AdminJournalDetailSchema', () => {
  it('round-trips the sample detail', () => {
    const parsed = AdminJournalDetailSchema.parse(sampleDetail);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.context).toEqual({ stripeInvoiceId: 'in_abc' });
  });

  it('rejects a detail with fewer than 2 lines', () => {
    expect(
      AdminJournalDetailSchema.safeParse({ ...sampleDetail, lines: [sampleLine] }).success,
    ).toBe(false);
  });

  it('accepts an empty context jsonb', () => {
    const parsed = AdminJournalDetailSchema.parse({ ...sampleDetail, context: {} });
    expect(parsed.context).toEqual({});
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminJournalDetailSchema.safeParse({ ...sampleDetail, extra: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('AdminJournalsListResponseSchema', () => {
  it('accepts an empty list with null cursor', () => {
    const parsed = AdminJournalsListResponseSchema.parse({
      journals: [],
      nextCursor: null,
    });
    expect(parsed.journals).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
  });

  it('accepts a populated list with a non-null cursor', () => {
    const parsed = AdminJournalsListResponseSchema.parse({
      journals: [sampleSummary],
      nextCursor: 'abc123',
    });
    expect(parsed.journals).toHaveLength(1);
    expect(parsed.nextCursor).toBe('abc123');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminJournalsListResponseSchema.safeParse({
        journals: [],
        nextCursor: null,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminJournalDetailResponseSchema', () => {
  it('wraps the detail in a `journal` envelope', () => {
    const parsed = AdminJournalDetailResponseSchema.parse({ journal: sampleDetail });
    expect(parsed.journal.id).toBe('jnl_abc');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminJournalDetailResponseSchema.safeParse({
        journal: sampleDetail,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminTrialBalanceQuerySchema', () => {
  it('accepts an empty (all-time) query', () => {
    const parsed = AdminTrialBalanceQuerySchema.parse({});
    expect(parsed.periodId).toBeUndefined();
    expect(parsed.periodName).toBeUndefined();
    expect(parsed.currency).toBeUndefined();
  });

  it('accepts a periodName-scoped query', () => {
    const parsed = AdminTrialBalanceQuerySchema.parse({ periodName: '2026-05' });
    expect(parsed.periodName).toBe('2026-05');
  });

  it('accepts a periodId-scoped query', () => {
    const parsed = AdminTrialBalanceQuerySchema.parse({ periodId: 'per_abc' });
    expect(parsed.periodId).toBe('per_abc');
  });

  it('accepts an explicit USD currency', () => {
    const parsed = AdminTrialBalanceQuerySchema.parse({ currency: 'USD' });
    expect(parsed.currency).toBe('USD');
  });

  it('rejects a non-USD currency', () => {
    expect(AdminTrialBalanceQuerySchema.safeParse({ currency: 'EUR' }).success).toBe(false);
  });

  it('rejects a malformed periodName', () => {
    expect(AdminTrialBalanceQuerySchema.safeParse({ periodName: 'mid-2026' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminTrialBalanceQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false);
  });
});

describe('AdminTrialBalanceRowSchema', () => {
  it('round-trips the sample row', () => {
    const parsed = AdminTrialBalanceRowSchema.parse(sampleTrialBalanceRow);
    expect(parsed).toEqual(sampleTrialBalanceRow);
  });

  it('accepts every accountType enum', () => {
    for (const t of [
      'asset',
      'liability',
      'equity',
      'revenue',
      'contra_revenue',
      'expense',
    ] as const) {
      const parsed = AdminTrialBalanceRowSchema.parse({
        ...sampleTrialBalanceRow,
        accountType: t,
        // a contra_revenue line on an asset-shaped row would be incoherent
        // domain-wise, but the contract only enforces shape.
        normalBalance: t === 'contra_revenue' ? 'debit' : sampleTrialBalanceRow.normalBalance,
      });
      expect(parsed.accountType).toBe(t);
    }
  });

  it('rejects a negative net balance', () => {
    expect(
      AdminTrialBalanceRowSchema.safeParse({
        ...sampleTrialBalanceRow,
        netDebitMinor: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminTrialBalanceRowSchema.safeParse({
        ...sampleTrialBalanceRow,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminTrialBalanceResponseSchema', () => {
  it('accepts a balanced response (totals equal)', () => {
    const parsed = AdminTrialBalanceResponseSchema.parse({
      rows: [sampleTrialBalanceRow],
      totalDebitMinor: 70_000,
      totalCreditMinor: 70_000,
      imbalanceMinor: 0,
      currency: 'USD',
      periodId: null,
      periodName: null,
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.imbalanceMinor).toBe(0);
  });

  it('accepts an imbalanced response (diagnostic surface)', () => {
    const parsed = AdminTrialBalanceResponseSchema.parse({
      rows: [],
      totalDebitMinor: 5_000,
      totalCreditMinor: 4_900,
      imbalanceMinor: 100,
      currency: 'USD',
      periodId: null,
      periodName: null,
    });
    expect(parsed.imbalanceMinor).toBe(100);
  });

  it('accepts a period-scoped response', () => {
    const parsed = AdminTrialBalanceResponseSchema.parse({
      rows: [],
      totalDebitMinor: 0,
      totalCreditMinor: 0,
      imbalanceMinor: 0,
      currency: 'USD',
      periodId: 'per_abc',
      periodName: '2026-05',
    });
    expect(parsed.periodId).toBe('per_abc');
    expect(parsed.periodName).toBe('2026-05');
  });

  it('rejects negative totals', () => {
    expect(
      AdminTrialBalanceResponseSchema.safeParse({
        rows: [],
        totalDebitMinor: -1,
        totalCreditMinor: 0,
        imbalanceMinor: 1,
        currency: 'USD',
        periodId: null,
        periodName: null,
      }).success,
    ).toBe(false);
  });

  it('rejects totals above the response cap', () => {
    expect(
      AdminTrialBalanceResponseSchema.safeParse({
        rows: [],
        totalDebitMinor: ADMIN_ACCOUNTING_TOTAL_AMOUNT_MAX_MINOR + 1,
        totalCreditMinor: 0,
        imbalanceMinor: 0,
        currency: 'USD',
        periodId: null,
        periodName: null,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminTrialBalanceResponseSchema.safeParse({
        rows: [],
        totalDebitMinor: 0,
        totalCreditMinor: 0,
        imbalanceMinor: 0,
        currency: 'USD',
        periodId: null,
        periodName: null,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminPeriodEventsListQuerySchema', () => {
  it('defaults the limit when not supplied', () => {
    const parsed = AdminPeriodEventsListQuerySchema.parse({});
    expect(parsed.limit).toBe(ADMIN_PERIOD_EVENTS_LIST_LIMIT_DEFAULT);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a numeric-string limit', () => {
    const parsed = AdminPeriodEventsListQuerySchema.parse({ limit: '40' });
    expect(parsed.limit).toBe(40);
  });

  it('rejects a limit above the bound', () => {
    expect(
      AdminPeriodEventsListQuerySchema.safeParse({
        limit: ADMIN_PERIOD_EVENTS_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminPeriodEventsListQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false);
  });
});

describe('AdminPeriodEventSchema', () => {
  it('round-trips a close event', () => {
    const parsed = AdminPeriodEventSchema.parse(samplePeriodEvent);
    expect(parsed).toEqual(samplePeriodEvent);
  });

  it('round-trips a reopen event with null description', () => {
    const parsed = AdminPeriodEventSchema.parse({
      ...samplePeriodEvent,
      kind: 'reopen',
      description: null,
    });
    expect(parsed.kind).toBe('reopen');
    expect(parsed.description).toBeNull();
  });

  it('rejects an unknown kind', () => {
    expect(
      AdminPeriodEventSchema.safeParse({
        ...samplePeriodEvent,
        kind: 'mystery',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid periodName', () => {
    expect(
      AdminPeriodEventSchema.safeParse({
        ...samplePeriodEvent,
        periodName: 'mid-2026',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminPeriodEventSchema.safeParse({
        ...samplePeriodEvent,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminPeriodEventsListResponseSchema', () => {
  it('accepts an empty events list', () => {
    const parsed = AdminPeriodEventsListResponseSchema.parse({
      events: [],
      nextCursor: null,
    });
    expect(parsed.events).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
  });

  it('accepts a populated events list with a cursor', () => {
    const parsed = AdminPeriodEventsListResponseSchema.parse({
      events: [samplePeriodEvent],
      nextCursor: 'abc123',
    });
    expect(parsed.events).toHaveLength(1);
    expect(parsed.nextCursor).toBe('abc123');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminPeriodEventsListResponseSchema.safeParse({
        events: [],
        nextCursor: null,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Paused deferred-revenue balances (TS-042-followup-3b2-followup-2a)
 * ---------------------------------------------------------------------- */

const samplePausedBalance: AdminPausedDeferredRevenueBalance = {
  balanceId: 'drb_01',
  subscriptionId: 'sub_01',
  customerId: 'hh_01',
  customerGroup: 'family',
  planCode: 'family.tier2',
  currency: 'USD',
  pausedAt: '2026-05-01T00:00:00.000Z',
  pausedForSeconds: 1_468_800,
  priorPausedSeconds: 0,
  servicePeriodStart: '2026-04-01T00:00:00.000Z',
  servicePeriodEnd: '2026-05-01T00:00:00.000Z',
  pastServicePeriodEnd: true,
  originalAmountMinor: 29_900,
  recognizedAmountMinor: 12_000,
  remainingDeferredMinor: 17_900,
};

const samplePausedSummary: AdminPausedDeferredRevenueSummary = {
  pausedCount: 3,
  pastServicePeriodEndCount: 1,
  unknownPausedAtCount: 0,
  oldestPausedAt: '2026-05-01T00:00:00.000Z',
  totalRemainingDeferredMinor: 51_700,
  currency: 'USD',
};

describe('AdminPausedDeferredRevenueBalanceSchema', () => {
  it('accepts a well-formed row', () => {
    const parsed = AdminPausedDeferredRevenueBalanceSchema.parse(samplePausedBalance);
    expect(parsed.remainingDeferredMinor).toBe(17_900);
    expect(parsed.pastServicePeriodEnd).toBe(true);
  });

  it('accepts a row whose pause instant was never recorded, with a null age', () => {
    const parsed = AdminPausedDeferredRevenueBalanceSchema.parse({
      ...samplePausedBalance,
      pausedAt: null,
      pausedForSeconds: null,
    });
    expect(parsed.pausedAt).toBeNull();
    // Null, never zero: an unknowable age must not read as the freshest
    // row on the queue.
    expect(parsed.pausedForSeconds).toBeNull();
  });

  it('rejects a negative pause duration', () => {
    expect(
      AdminPausedDeferredRevenueBalanceSchema.safeParse({
        ...samplePausedBalance,
        pausedForSeconds: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects a fractional money field (minor units are integers)', () => {
    expect(
      AdminPausedDeferredRevenueBalanceSchema.safeParse({
        ...samplePausedBalance,
        remainingDeferredMinor: 179.5,
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed plan code', () => {
    expect(
      AdminPausedDeferredRevenueBalanceSchema.safeParse({
        ...samplePausedBalance,
        planCode: 'Family Tier 2',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown customer group', () => {
    expect(
      AdminPausedDeferredRevenueBalanceSchema.safeParse({
        ...samplePausedBalance,
        customerGroup: 'partner',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminPausedDeferredRevenueBalanceSchema.safeParse({
        ...samplePausedBalance,
        pauseReason: 'family requested',
      }).success,
    ).toBe(false);
  });
});

describe('AdminPausedDeferredRevenueSummarySchema', () => {
  it('accepts an all-clear summary', () => {
    const parsed = AdminPausedDeferredRevenueSummarySchema.parse({
      pausedCount: 0,
      pastServicePeriodEndCount: 0,
      unknownPausedAtCount: 0,
      oldestPausedAt: null,
      totalRemainingDeferredMinor: 0,
      currency: 'USD',
    });
    expect(parsed.pausedCount).toBe(0);
    expect(parsed.oldestPausedAt).toBeNull();
  });

  it('accepts a populated summary', () => {
    const parsed = AdminPausedDeferredRevenueSummarySchema.parse(samplePausedSummary);
    expect(parsed.pastServicePeriodEndCount).toBe(1);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminPausedDeferredRevenueSummarySchema.safeParse({
        ...samplePausedSummary,
        stuckCount: 1,
      }).success,
    ).toBe(false);
  });
});

describe('AdminPausedDeferredRevenueQuerySchema', () => {
  it('defaults the enumeration limit', () => {
    const parsed = AdminPausedDeferredRevenueQuerySchema.parse({});
    expect(parsed.limit).toBe(ADMIN_PAUSED_BALANCES_LIST_LIMIT_DEFAULT);
    expect(parsed.asOf).toBeUndefined();
  });

  it('coerces a string limit from the query string', () => {
    const parsed = AdminPausedDeferredRevenueQuerySchema.parse({ limit: '10' });
    expect(parsed.limit).toBe(10);
  });

  it('rejects a limit above the cap', () => {
    expect(
      AdminPausedDeferredRevenueQuerySchema.safeParse({
        limit: ADMIN_PAUSED_BALANCES_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-datetime asOf', () => {
    expect(AdminPausedDeferredRevenueQuerySchema.safeParse({ asOf: '2026-05-18' }).success).toBe(
      false,
    );
  });

  it('rejects unknown query params (strict)', () => {
    expect(AdminPausedDeferredRevenueQuerySchema.safeParse({ status: 'paused' }).success).toBe(
      false,
    );
  });
});

describe('AdminPausedDeferredRevenueResponseSchema', () => {
  it('accepts an empty queue', () => {
    const parsed = AdminPausedDeferredRevenueResponseSchema.parse({
      asOf: NOW_ISO,
      summary: {
        pausedCount: 0,
        pastServicePeriodEndCount: 0,
        unknownPausedAtCount: 0,
        oldestPausedAt: null,
        totalRemainingDeferredMinor: 0,
        currency: 'USD',
      },
      balances: [],
      truncated: false,
    });
    expect(parsed.balances).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it('carries the uncapped count alongside a truncated enumeration', () => {
    const parsed = AdminPausedDeferredRevenueResponseSchema.parse({
      asOf: NOW_ISO,
      summary: { ...samplePausedSummary, pausedCount: 900 },
      balances: [samplePausedBalance],
      truncated: true,
    });
    // The contract's reason for existing: the count is NOT the page size.
    expect(parsed.summary.pausedCount).toBe(900);
    expect(parsed.balances).toHaveLength(1);
    expect(parsed.truncated).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminPausedDeferredRevenueResponseSchema.safeParse({
        asOf: NOW_ISO,
        summary: samplePausedSummary,
        balances: [],
        truncated: false,
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});
