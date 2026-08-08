import { describe, expect, it } from 'vitest';

import {
  JOURNAL_DESCRIPTION_MAX_LENGTH,
  JOURNAL_LINES_MAX,
  JOURNAL_LINES_MIN,
  JOURNAL_LINE_MAX_AMOUNT_MINOR,
  JOURNAL_MEMO_MAX_LENGTH,
  JOURNAL_REVERSAL_REASON_MAX_LENGTH,
  JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH,
  JournalKindSchema,
  JournalLineInputSchema,
  JournalLineResponseSchema,
  JournalResponseSchema,
  ManualAdjustmentRequestSchema,
  PostJournalRequestSchema,
  PostableJournalKindSchema,
  ReverseJournalRequestSchema,
} from '../http/journal.schema';

const validDebitLine = {
  accountCode: '1000',
  debitMinor: 29_900,
  currency: 'USD' as const,
  memo: 'Tier 2 subscription cash.',
};

const validCreditLine = {
  accountCode: '2000.family.tier2',
  creditMinor: 29_900,
  currency: 'USD' as const,
  memo: 'Tier 2 deferred revenue.',
};

describe('JournalKindSchema', () => {
  it('accepts every PDD-named kind', () => {
    for (const k of [
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
      expect(JournalKindSchema.parse(k)).toBe(k);
    }
  });

  it('rejects an unknown kind', () => {
    expect(JournalKindSchema.safeParse('subscription_renewal').success).toBe(false);
  });
});

describe('PostableJournalKindSchema', () => {
  it('excludes `reversal` and `period_close`', () => {
    expect(PostableJournalKindSchema.safeParse('reversal').success).toBe(false);
    expect(PostableJournalKindSchema.safeParse('period_close').success).toBe(false);
  });

  it('accepts the system-postable kinds', () => {
    expect(PostableJournalKindSchema.parse('subscription_activation')).toBe(
      'subscription_activation',
    );
    expect(PostableJournalKindSchema.parse('booking_completion')).toBe('booking_completion');
    expect(PostableJournalKindSchema.parse('manual_adjustment')).toBe('manual_adjustment');
  });
});

describe('JournalLineInputSchema', () => {
  it('accepts a valid debit line with USD default currency', () => {
    const parsed = JournalLineInputSchema.parse({
      accountCode: '1000',
      debitMinor: 29_900,
    });
    expect(parsed.debitMinor).toBe(29_900);
    expect(parsed.creditMinor).toBeUndefined();
    expect(parsed.currency).toBe('USD');
  });

  it('accepts a valid credit line', () => {
    expect(JournalLineInputSchema.parse(validCreditLine).creditMinor).toBe(29_900);
  });

  it('rejects a line with both debit and credit set non-zero', () => {
    const result = JournalLineInputSchema.safeParse({
      accountCode: '1000',
      debitMinor: 100,
      creditMinor: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('cannot have both');
    }
  });

  it('rejects a line with neither debit nor credit set non-zero', () => {
    const result = JournalLineInputSchema.safeParse({ accountCode: '1000' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('exactly one');
    }
  });

  it('rejects a line with both debit and credit set to 0', () => {
    const result = JournalLineInputSchema.safeParse({
      accountCode: '1000',
      debitMinor: 0,
      creditMinor: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative amount', () => {
    expect(
      JournalLineInputSchema.safeParse({
        accountCode: '1000',
        debitMinor: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects an amount above the maximum cap', () => {
    expect(
      JournalLineInputSchema.safeParse({
        accountCode: '1000',
        debitMinor: JOURNAL_LINE_MAX_AMOUNT_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts the maximum cap exactly', () => {
    const parsed = JournalLineInputSchema.parse({
      accountCode: '1000',
      debitMinor: JOURNAL_LINE_MAX_AMOUNT_MINOR,
    });
    expect(parsed.debitMinor).toBe(JOURNAL_LINE_MAX_AMOUNT_MINOR);
  });

  it('rejects a fractional minor value (must be integer cents)', () => {
    expect(
      JournalLineInputSchema.safeParse({
        accountCode: '1000',
        debitMinor: 100.5,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid account code', () => {
    expect(
      JournalLineInputSchema.safeParse({
        accountCode: 'CASH 1000', // uppercase + space
        debitMinor: 100,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      JournalLineInputSchema.safeParse({
        accountCode: '1000',
        debitMinor: 100,
        rogueField: 'leak',
      }).success,
    ).toBe(false);
  });

  it('caps memo length', () => {
    expect(
      JournalLineInputSchema.safeParse({
        accountCode: '1000',
        debitMinor: 100,
        memo: 'a'.repeat(JOURNAL_MEMO_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('PostJournalRequestSchema', () => {
  const validRequest = {
    kind: 'subscription_activation' as const,
    occurredAt: '2026-05-13T00:00:00.000Z',
    sourceEventId: 'evt_subscription_activated_abc123',
    description: 'Tier 2 subscription activated; cash + deferred revenue.',
    lines: [validDebitLine, validCreditLine],
  };

  it('accepts a valid balanced two-line journal', () => {
    expect(PostJournalRequestSchema.parse(validRequest)).toMatchObject({
      kind: 'subscription_activation',
    });
  });

  it('rejects when fewer than the minimum lines provided', () => {
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        lines: [validDebitLine],
      }).success,
    ).toBe(false);
  });

  it('rejects more than the maximum lines', () => {
    const tooManyLines = Array.from({ length: JOURNAL_LINES_MAX + 1 }, () => validDebitLine);
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        lines: tooManyLines,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown postable kind', () => {
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        kind: 'reversal' as never,
      }).success,
    ).toBe(false);
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        kind: 'period_close' as never,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid occurredAt', () => {
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        occurredAt: '2026-05-13',
      }).success,
    ).toBe(false);
  });

  it('caps sourceEventId length', () => {
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        sourceEventId: 'a'.repeat(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('caps description length', () => {
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        description: 'a'.repeat(JOURNAL_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts an optional context object', () => {
    const parsed = PostJournalRequestSchema.parse({
      ...validRequest,
      context: { stripeInvoiceId: 'in_abc123', tier: 'family.tier2' },
    });
    expect(parsed.context).toEqual({
      stripeInvoiceId: 'in_abc123',
      tier: 'family.tier2',
    });
  });

  it('rejects unknown top-level fields', () => {
    expect(
      PostJournalRequestSchema.safeParse({
        ...validRequest,
        leaked: 'oops',
      }).success,
    ).toBe(false);
  });

  it('enforces JOURNAL_LINES_MIN constant matches schema enforcement', () => {
    expect(JOURNAL_LINES_MIN).toBe(2);
  });
});

describe('ManualAdjustmentRequestSchema', () => {
  const validRequest = {
    occurredAt: '2026-05-13T00:00:00.000Z',
    sourceEventId: 'manual_adj_2026_05_13_001',
    description: 'Off-platform refund of $99 cleared by check.',
    reasonCode: 'OFF_PLATFORM_REFUND',
    lines: [validDebitLine, validCreditLine],
  };

  it('accepts a balanced manual-adjustment payload', () => {
    expect(ManualAdjustmentRequestSchema.parse(validRequest)).toMatchObject({
      reasonCode: 'OFF_PLATFORM_REFUND',
    });
  });

  it('rejects a `kind` field — the kind is locked at the contract layer', () => {
    expect(
      ManualAdjustmentRequestSchema.safeParse({
        ...validRequest,
        kind: 'manual_adjustment',
      }).success,
    ).toBe(false);
  });

  it('caps reasonCode length', () => {
    expect(
      ManualAdjustmentRequestSchema.safeParse({
        ...validRequest,
        reasonCode: 'a'.repeat(JOURNAL_REVERSAL_REASON_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects missing reasonCode', () => {
    expect(
      ManualAdjustmentRequestSchema.safeParse({
        ...validRequest,
        reasonCode: undefined,
      }).success,
    ).toBe(false);
  });
});

describe('ReverseJournalRequestSchema', () => {
  it('accepts a valid reversal request', () => {
    const parsed = ReverseJournalRequestSchema.parse({
      sourceEventId: 'reversal_evt_abc',
      occurredAt: '2026-05-13T00:00:00.000Z',
      reasonCode: 'BOOKING_DISPUTE_RESOLVED_REFUND',
    });
    expect(parsed.reasonCode).toBe('BOOKING_DISPUTE_RESOLVED_REFUND');
  });

  it('accepts an optional description', () => {
    const parsed = ReverseJournalRequestSchema.parse({
      sourceEventId: 'reversal_evt_abc',
      occurredAt: '2026-05-13T00:00:00.000Z',
      reasonCode: 'BOOKING_DISPUTE_RESOLVED_REFUND',
      description: 'Reverses the original booking-completion journal.',
    });
    expect(parsed.description).toBe('Reverses the original booking-completion journal.');
  });

  it('rejects unknown fields', () => {
    expect(
      ReverseJournalRequestSchema.safeParse({
        sourceEventId: 'reversal_evt_abc',
        occurredAt: '2026-05-13T00:00:00.000Z',
        reasonCode: 'X',
        leaked: 'oops',
      }).success,
    ).toBe(false);
  });
});

describe('JournalLineResponseSchema', () => {
  it('accepts a valid response line', () => {
    const parsed = JournalLineResponseSchema.parse({
      id: 'jl_abc',
      accountId: 'coa_cash',
      accountCode: '1000',
      debitMinor: 29_900,
      creditMinor: 0,
      currency: 'USD',
      memo: 'Tier 2 cash.',
    });
    expect(parsed.debitMinor).toBe(29_900);
    expect(parsed.creditMinor).toBe(0);
  });

  it('rejects unknown fields', () => {
    expect(
      JournalLineResponseSchema.safeParse({
        id: 'jl_abc',
        accountId: 'coa_cash',
        accountCode: '1000',
        debitMinor: 29_900,
        creditMinor: 0,
        currency: 'USD',
        leaked: 'no',
      }).success,
    ).toBe(false);
  });
});

describe('JournalResponseSchema', () => {
  const validResponse = {
    id: 'jrnl_abc',
    kind: 'subscription_activation' as const,
    occurredAt: '2026-05-13T00:00:00.000Z',
    postedAt: '2026-05-13T00:00:01.000Z',
    sourceEventId: 'evt_subscription_activated_abc123',
    description: 'Tier 2 subscription activated.',
    periodId: 'prd_abc',
    periodName: '2026-05',
    postedByUserId: null,
    reversedJournalId: null,
    reversedByJournalId: null,
    context: { stripeInvoiceId: 'in_abc123' },
    lines: [
      {
        id: 'jl_a',
        accountId: 'coa_cash',
        accountCode: '1000',
        debitMinor: 29_900,
        creditMinor: 0,
        currency: 'USD' as const,
      },
      {
        id: 'jl_b',
        accountId: 'coa_deferred_tier2',
        accountCode: '2000.family.tier2',
        debitMinor: 0,
        creditMinor: 29_900,
        currency: 'USD' as const,
      },
    ],
  };

  it('accepts a valid response', () => {
    expect(JournalResponseSchema.parse(validResponse).id).toBe('jrnl_abc');
  });

  it('accepts a reversal-shaped response', () => {
    const parsed = JournalResponseSchema.parse({
      ...validResponse,
      kind: 'reversal',
      reversedJournalId: 'jrnl_original',
    });
    expect(parsed.kind).toBe('reversal');
    expect(parsed.reversedJournalId).toBe('jrnl_original');
  });

  it('accepts the back-pointer on a reversed original', () => {
    const parsed = JournalResponseSchema.parse({
      ...validResponse,
      reversedByJournalId: 'jrnl_reversal_abc',
    });
    expect(parsed.reversedByJournalId).toBe('jrnl_reversal_abc');
  });

  it('rejects unknown fields', () => {
    expect(
      JournalResponseSchema.safeParse({
        ...validResponse,
        leaked: 'oops',
      }).success,
    ).toBe(false);
  });
});
