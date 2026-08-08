import { describe, expect, it } from 'vitest';

import {
  ListStripeReconciliationChecksQuerySchema,
  ListStripeReconciliationChecksResponseSchema,
  ResolveStripeReconciliationCheckRequestSchema,
  ResolveStripeReconciliationCheckResponseSchema,
  RunStripeReconciliationRequestSchema,
  RunStripeReconciliationResponseSchema,
  STRIPE_RECONCILIATION_CHECKS_RANGE_MAX_ROWS,
  STRIPE_RECONCILIATION_DATE_REGEX,
  STRIPE_RECONCILIATION_DETAIL_MAX_LENGTH,
  STRIPE_RECONCILIATION_MAX_MINOR,
  STRIPE_RECONCILIATION_RESOLUTION_NOTES_MAX_LENGTH,
  StripeReconciliationCategorySchema,
  StripeReconciliationCheckRecordSchema,
  StripeReconciliationDateSchema,
  StripeReconciliationModeSchema,
  StripeReconciliationStatusSchema,
} from '../http/stripe-reconciliation.schema';

function validRecord() {
  return {
    reconciliationDate: '2026-05-28',
    category: 'balance' as const,
    status: 'matched' as const,
    mode: 'live' as const,
    currency: 'USD' as const,
    expectedAmountMinor: 1_500_000,
    actualAmountMinor: 1_500_000,
    deltaAmountMinor: 0,
    toleranceAmountMinor: 0,
    stripeTransactionCount: null,
    windowStart: '2026-05-28T00:00:00.000Z',
    windowEnd: '2026-05-29T00:00:00.000Z',
    detail: 'Stripe balance matches the ledger Cash account within tolerance.',
    computedAt: '2026-05-29T03:00:00.000Z',
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNotes: null,
  };
}

describe('StripeReconciliationDateSchema', () => {
  it('accepts UTC calendar dates', () => {
    expect(StripeReconciliationDateSchema.parse('2026-05-28')).toBe('2026-05-28');
  });

  it('rejects datetimes, partial dates, and garbage', () => {
    expect(StripeReconciliationDateSchema.safeParse('2026-05-28T00:00:00Z').success).toBe(false);
    expect(StripeReconciliationDateSchema.safeParse('2026-5-8').success).toBe(false);
    expect(StripeReconciliationDateSchema.safeParse('not-a-date').success).toBe(false);
  });

  it('exposes the regex constant for downstream reuse', () => {
    expect(STRIPE_RECONCILIATION_DATE_REGEX.test('2026-05-28')).toBe(true);
    expect(STRIPE_RECONCILIATION_DATE_REGEX.test('2026-05-28T00:00:00Z')).toBe(false);
  });
});

describe('enum schemas', () => {
  it('category accepts the two dimensions', () => {
    expect(StripeReconciliationCategorySchema.parse('balance')).toBe('balance');
    expect(StripeReconciliationCategorySchema.parse('activity')).toBe('activity');
    expect(StripeReconciliationCategorySchema.safeParse('other').success).toBe(false);
  });

  it('status accepts the four lifecycle states', () => {
    for (const s of ['matched', 'mismatch_open', 'mismatch_resolved', 'skipped_stub']) {
      expect(StripeReconciliationStatusSchema.parse(s)).toBe(s);
    }
    expect(StripeReconciliationStatusSchema.safeParse('open').success).toBe(false);
  });

  it('mode accepts live + stub', () => {
    expect(StripeReconciliationModeSchema.parse('live')).toBe('live');
    expect(StripeReconciliationModeSchema.parse('stub')).toBe('stub');
    expect(StripeReconciliationModeSchema.safeParse('test').success).toBe(false);
  });
});

describe('StripeReconciliationCheckRecordSchema', () => {
  it('accepts a fully-populated matched record', () => {
    expect(StripeReconciliationCheckRecordSchema.parse(validRecord())).toEqual(validRecord());
  });

  it('accepts a stub record with null Stripe figures', () => {
    const stub = {
      ...validRecord(),
      status: 'skipped_stub' as const,
      mode: 'stub' as const,
      actualAmountMinor: null,
      deltaAmountMinor: null,
    };
    expect(StripeReconciliationCheckRecordSchema.parse(stub)).toEqual(stub);
  });

  it('accepts a mismatch record with a negative delta + resolution fields', () => {
    const resolved = {
      ...validRecord(),
      category: 'activity' as const,
      status: 'mismatch_resolved' as const,
      expectedAmountMinor: -5_000,
      actualAmountMinor: -7_500,
      deltaAmountMinor: -2_500,
      stripeTransactionCount: 42,
      resolvedAt: '2026-05-29T12:00:00.000Z',
      resolvedByUserId: 'user_admin_1',
      resolutionNotes: 'Stripe payout-fee timing — accepted.',
    };
    expect(StripeReconciliationCheckRecordSchema.parse(resolved)).toEqual(resolved);
  });

  it('rejects monetary fields beyond the Decimal(12,2) envelope', () => {
    expect(
      StripeReconciliationCheckRecordSchema.safeParse({
        ...validRecord(),
        expectedAmountMinor: STRIPE_RECONCILIATION_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a negative tolerance', () => {
    expect(
      StripeReconciliationCheckRecordSchema.safeParse({
        ...validRecord(),
        toleranceAmountMinor: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects a detail longer than the cap', () => {
    expect(
      StripeReconciliationCheckRecordSchema.safeParse({
        ...validRecord(),
        detail: 'x'.repeat(STRIPE_RECONCILIATION_DETAIL_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      StripeReconciliationCheckRecordSchema.safeParse({ ...validRecord(), extra: 1 }).success,
    ).toBe(false);
  });
});

describe('RunStripeReconciliationRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(RunStripeReconciliationRequestSchema.parse({})).toEqual({});
  });

  it('accepts an asOf datetime', () => {
    const body = { asOf: '2026-05-28T00:00:00.000Z' };
    expect(RunStripeReconciliationRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a date-only asOf and unknown keys', () => {
    expect(RunStripeReconciliationRequestSchema.safeParse({ asOf: '2026-05-28' }).success).toBe(
      false,
    );
    expect(RunStripeReconciliationRequestSchema.safeParse({ foo: 1 }).success).toBe(false);
  });
});

describe('RunStripeReconciliationResponseSchema', () => {
  it('accepts a run summary', () => {
    const body = {
      reconciliationDate: '2026-05-28',
      mode: 'live' as const,
      checks: [validRecord()],
      openMismatchCount: 0,
    };
    expect(RunStripeReconciliationResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a negative open-mismatch count', () => {
    expect(
      RunStripeReconciliationResponseSchema.safeParse({
        reconciliationDate: '2026-05-28',
        mode: 'live',
        checks: [],
        openMismatchCount: -1,
      }).success,
    ).toBe(false);
  });
});

describe('ListStripeReconciliationChecksQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(ListStripeReconciliationChecksQuerySchema.parse({})).toEqual({});
  });

  it('accepts status + date-range filters', () => {
    const q = { status: 'mismatch_open' as const, from: '2026-05-01', to: '2026-05-31' };
    expect(ListStripeReconciliationChecksQuerySchema.parse(q)).toEqual(q);
  });

  it('rejects from after to', () => {
    expect(
      ListStripeReconciliationChecksQuerySchema.safeParse({ from: '2026-05-31', to: '2026-05-01' })
        .success,
    ).toBe(false);
  });

  it('accepts from == to', () => {
    expect(
      ListStripeReconciliationChecksQuerySchema.safeParse({ from: '2026-05-10', to: '2026-05-10' })
        .success,
    ).toBe(true);
  });
});

describe('ListStripeReconciliationChecksResponseSchema', () => {
  it('accepts a list with an echoed window', () => {
    const body = { checks: [validRecord()], from: '2026-05-28', to: '2026-05-28' };
    expect(ListStripeReconciliationChecksResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts an empty list with null bounds', () => {
    const body = { checks: [], from: null, to: null };
    expect(ListStripeReconciliationChecksResponseSchema.parse(body)).toEqual(body);
  });
});

describe('ResolveStripeReconciliationCheck schemas', () => {
  it('requires a non-empty resolution note', () => {
    expect(
      ResolveStripeReconciliationCheckRequestSchema.parse({ resolutionNotes: 'Explained.' }),
    ).toEqual({ resolutionNotes: 'Explained.' });
    expect(
      ResolveStripeReconciliationCheckRequestSchema.safeParse({ resolutionNotes: '' }).success,
    ).toBe(false);
  });

  it('rejects a note longer than the cap', () => {
    expect(
      ResolveStripeReconciliationCheckRequestSchema.safeParse({
        resolutionNotes: 'x'.repeat(STRIPE_RECONCILIATION_RESOLUTION_NOTES_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('wraps the updated record in the response', () => {
    const body = { check: { ...validRecord(), status: 'mismatch_resolved' as const } };
    expect(ResolveStripeReconciliationCheckResponseSchema.parse(body)).toEqual(body);
  });
});

describe('constants', () => {
  it('exposes the range row cap', () => {
    expect(STRIPE_RECONCILIATION_CHECKS_RANGE_MAX_ROWS).toBe(400);
  });
});
